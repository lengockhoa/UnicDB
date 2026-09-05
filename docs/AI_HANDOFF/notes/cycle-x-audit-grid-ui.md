# Cycle X Audit — Grid / Webview / Query-UI (TASK-002)

Range `v1.6.3..v1.6.6` (commit `a103eed` working tree). Executor: bao-sonnet.
Scope per task file + PLAN §2/§3.1. Companion report: `cycle-x-audit-host-adapters.md` (TASK-001).

## Method

- Read in full: `webview/main.ts` (3440), `webview/sqlHighlight.ts` (250), `src/ui/queryComposer.ts` (515), `src/ui/distinctValues.ts` (103), `src/ui/messages.ts` (217), `src/ui/resultsPanel.ts` (1558), `src/ui/resultsGridModel.ts` (1214).
- Traced SQL composition end-to-end: grid filter/sort model → `postFilterRequery`/`orderByFromColumnState` → `handleRequery`/`composeRequerySql` → `composeRequery`/`composeSortQuery`/`buildPagedQueryTerms` → `runSql` → `pickResult`/`adopt` → state message → `renderGrid` branch selection.
- Cross-checked against `src/core/queryRunner.ts` (pickResult/adopt/batched contract), `src/adapters/postgres.ts` + `mysql.ts` (pool max=1, cursor lifecycle), `src/core/saveStatements.ts` (parseFromClause, warnings/skippedRows), and the webview test suites (which paths are guarded).
- Every P0–P3 row below cites `file:line` from the code read this session.

## Findings

### P1-1 — Aux single-SELECT host round trips steal the pool client from a live browse cursor (deadlock/timeout)

- **Evidence:** `src/adapters/postgres.ts:300-303` — `runQuery` routes ANY single SELECT to a cursor: `const batched = await this.openCursorForStatement(...)`; the cursor holds the only pooled client (`max: 1` at `postgres.ts:215`) until close/EOF (`postgres.ts:674`, `744-752`). MySQL mirror: `mysql.ts:64-71` (`connectionLimit: 1`), `mysql.ts:143-147`.
- **Trigger:** Browse a table with >500 rows (cursor open, rows pending). Click any non-batch host path that calls `runner.runSql(auxSql)` while the cursor is still open. Candidates in the audited surface: the post-commit auto-refresh (`resultsPanel.ts:770` `const refreshed = await this.runner.runSql(r.sql)`) and the no-PK ctid prober (`resultsPanel.ts:1391`). Both run after `closeStatementCursor` in their flows — but `fetchPostgresCtids` is invoked from `handleSaveEdits` BEFORE any cursor close in the ctid path, and more importantly `listPkColumns`/`listColumnTypes` (`saveContext`, resultsPanel.ts:1128, 1149) go through the same pool.
- **Expected:** aux metadata/refresh queries run or queue behind the cursor and complete.
- **Actual:** the aux SELECT is itself routed to a cursor → `pool.connect()` waits for the only client, held by the still-open browse cursor → after `connectionTimeoutMillis: 10_000` the request fails ("timeout exceeded when trying to connect"). Cursor-draining in `handleRequestDistinctValues` (resultsPanel.ts:980-991) and the requery path's explicit `closeStatementCursor` (resultsPanel.ts:1085) close the gap for THEIR flows only.
- **Proposed fix (small):** route host-side aux queries through a non-cursored path — e.g. `runSql(sql, { noCursor: true })` that forces the multi-statement branch, or close the active statement cursor before the first ctid/metadata await in `handleSaveEdits`. Marked *needs live DB verification* for the exact failure ordering (pool queue timing), the routing defect itself is from code.
- **Proposed test:** `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — stub `runSql` sequence (browse cursor open → save on no-PK table) asserting the ctid probe is not routed to a second cursor / asserting the browse cursor is closed before the probe. Disposition: **P0/P1 budget — TASK-006/007 candidate.**

### P1-2 — Set-filter search box has no `isFilterInput` guard analog on the *sort* path; a colId that duplicates AG Grid's field-dedup suffix produces wrong SQL

- **Evidence:** `src/ui/resultsGridModel.ts:110-119` dedups duplicate column names into `field = "id__2"`; `webview/main.ts:2203-2213` `orderByFromColumnState` maps `c.colId` (the deduped FIELD, not the original column name) straight into the ORDER BY string.
- **Trigger:** `SELECT a.id, b.id FROM a JOIN b ...`; user clicks the header of the second `id` column. colId = `id__2`, which is not the SQL name of any projected column.
- **Expected:** sort re-queries by the real column (the raw `headerName`/original column name).
- **Actual:** posted orderBy contains `"id__2"`/`id__2`; the host's `parseOrderBy` accepts it as a bare identifier and the DB errors `column "id__2" does not exist` (host surfaces a synthetic error statement — grid replaced by the error panel). No test covers duplicate-name sort (`webviewServerSort.test.ts` has no `id__2` case; only the export path tests dedup, `webviewCommitRefresh.test.ts:493-534`).
- **Proposed fix (small):** in `orderByFromColumnState`, map colId back through `currentSpecs` (`spec.headerName` for the matching field) before quoting.
- **Proposed test:** `src/ui/__tests__/webviewServerSort.test.ts` — duplicate columns case asserting posted `orderBy` uses the original name. Disposition: **P0/P1 budget — TASK-006/007 candidate.**

### P1-3 — `saveResult` `warnings` field is sent but not declared in the protocol and never rendered by the webview

- **Evidence:** host sends `warnings: nonFatalWarnings` (`src/ui/resultsPanel.ts:812-813`) alongside `errors`; `src/ui/messages.ts:191-216` (`SaveResultMessage`) declares `errors`/`rowErrors` but no `warnings`; the webview mirror `webview/main.ts:88-104` likewise, and `handleSaveResult` (`webview/main.ts:3183-3278`) only reads `errors` — on `ok:true` with only warnings present, the banner is hidden and the non-fatal per-row messages (e.g. the ctid-fallback not-safe warning emitted by `saveStatements.ts:487`) vanish.
- **Trigger:** postgres no-PK table, edit + commit a row via the ctid path. Save succeeds; `built.warnings` carries "not safe under concurrent writes".
- **Expected:** user sees the per-row non-fatal warning (the code comment at resultsPanel.ts:793-797 says this is the point).
- **Actual:** nothing is displayed; the message is dropped in the webview.
- **Proposed fix (small):** declare `warnings?: string[]` on `SaveResultMessage` + webview mirror and render them in the banner on the `ok:true` path.
- **Proposed test:** `src/ui/__tests__/webviewSaveEdits.test.ts` — ok:true + warnings → banner text contains the warning. Disposition: **TASK-006/007 candidate.**

### P1-4 — Manual-commit rollback leaves the grid on stale rows (no refresh), unlike commit and unlike save

- **Evidence:** `src/ui/resultsPanel.ts:312-324` `rollbackOpenTransaction` posts only `transactionStatus`; no requery/state refresh. Compare `handleCommitTransaction` — also no refresh — but the commit path's row changes arrive via the webview's own auto-requery only on `saveResult ok` (`webview/main.ts:3255-3259`), which fires per save; a manual COMMIT/ROLLBACK *button* click has no webview-side hook at all (`webview/main.ts:748-759` posts only the message).
- **Trigger:** manual-commit mode; edit + save a row (auto-requery shows the uncommitted value, routed through the pinned transaction, resultsPanel.ts:1199-1201); click Rollback. DB state reverts; grid keeps the uncommitted values.
- **Expected:** after rollback the grid reflects server truth (requery).
- **Actual:** grid silently shows rolled-back data; the only correction path is a manual Refresh. Worse for COMMIT: uncommitted values shown were fetched through the transaction, so they match — but any rows deleted/inserted by ANOTHER session since the window opened stay stale too.
- **Proposed fix (small):** after commit/rollback completes (and the transaction is null), post a requery-equivalent refresh for the active statement (same `runSql(r.sql)` + swap pattern as `handleSaveEdits`, routed through no transaction since it is now closed).
- **Proposed test:** `src/ui/__tests__/manualCommit.test.ts` — after rollbackTransaction, assert a follow-up `runSql(r.sql)`/state post occurs. Disposition: **TASK-006/007 candidate.**

### P1-5 — Auto-mode save can deadlock: refresh `runSql` while the statement's cursor is still open

- **Evidence:** `src/ui/resultsPanel.ts:769-771` — `if (!manualCommit) { const refreshed = await this.runner.runSql(r.sql); ... }` runs immediately after the save statements, with no `closeStatementCursor(r)` first (the manual branch has one at :710; the requery path has one at :1085). `r.sql` is the original browse SELECT → routed to a cursor (`postgres.ts:300-303`) → second `pool.connect()` on `max:1` while `r.batched` still holds the client.
- **Trigger:** auto-commit mode (default; `manualCommit` off), browse >500-row table, edit a cell, Commit. The save itself succeeds (`BEGIN;...;COMMIT` goes through the multi-statement branch), then the refresh SELECT deadheads for 10s and the grid never refreshes; the `catch` at :835-851 rethrows (non-manual) — unhandled rejection in `handleMessage`.
- **Expected:** refresh runs after the old cursor is closed; grid refreshes.
- **Actual:** 10s hang, error path, stale grid. *Needs live DB verification* for exact timing, but the missing close relative to both sibling paths is direct code evidence.
- **Proposed fix (small):** `await this.closeStatementCursor(r);` before the refresh `runSql` (and note `adopt()` at :824 will also try to close the displaced cursor — double close is safe/idempotent by design, `postgres.ts:782-785`).
- **Proposed test:** `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — auto-mode save asserts `batched.close` called before the second `runSql`. Disposition: **P0/P1 budget — TASK-006/007 candidate.**

### P2-1 — Search box (quick filter) is silently disabled for Load More but still triggers server-side requery side effects

- **Evidence:** `webview/main.ts:845-862` search input sets `quickFilterText` + calls `onFilterChanged()`; `onFilterChanged` (`webview/main.ts:1824-1830`) unconditionally calls `scheduleFilterRequery()` (debounced postFilterRequery) even when the only "filter" is the quick search (`colFilterActive` false). `dispatchLoadMore` bails on `quickFilterActive` (:2308) so no paging happens, but each search keystroke batch still posts a full `requery` to the DB with `filters: undefined`.
- **Trigger:** type in the Search box on any result.
- **Expected:** quick search is purely client-side (footer already reports filtered state, `main.ts:3104`); no DB round trip.
- **Actual:** 150ms after typing stops, the host re-runs the whole query; the returned state replaces rows and can drop the client-side quick filter effect ordering (render + identity change clears `distinctByColumn`, main.ts:3302) — visible as the grid flashing/resetting scroll while searching.
- **Proposed fix (small):** in the `onFilterChanged` handler, only `scheduleFilterRequery()` when `colFilterActive` is true (or when `e.source` involves column filters).
- **Proposed test:** `src/ui/__tests__/webviewFilters.test.ts` — typing in search box posts no `requery`. Disposition: **TASK-006/007 candidate (small).**

### P2-2 — `pickResult` batched branch swallows initial `fetchBatch` errors into an empty grid

- **Evidence:** `src/core/queryRunner.ts:426-440` — `try { const first = await runResult.batched.fetchBatch(); ... } catch { /* ignore */ }` returns `rows: []` with no error marker. Host consumers (`resultsPanel.ts:1208`, `:771`) treat the picked empty result as success and swap in a "done, 0 rows" statement.
- **Trigger:** cursor's first FETCH throws transiently (connection reset, cancel race).
- **Expected:** statement marked error (grid shows the error panel).
- **Actual:** silent empty result; user believes the table is empty. (Core-runner file is TASK-001's territory — cross-listed here because the audited requery/distinct paths consume it at the three sites above.)
- **Proposed fix (small):** rethrow in the catch, letting `handleRequery`'s existing error branch (`resultsPanel.ts:1267-1303`) render it.
- **Proposed test:** `src/core/__tests__/queryRunner` (existing suite) + requery error path in `resultsPanelRequery.test.ts`. Disposition: **TASK-001 coordination — do not double-fix.**

### P2-3 — `handleDistinctValues` ignores DISTINCT-drain errors silently when `distinctByColumn` fallback exists

- **Evidence:** `src/ui/resultsPanel.ts:1000-1004` catch replies with `error` — fine — but `webview/main.ts:2270-2271` `if (msg.error) return;` drops the reply without any UI note; the dropdown silently keeps loaded-row entries (documented fallback) but `truncated` is never surfaced either (`msg.truncated` unused by the webview except implicitly through cache).
- **Trigger:** DISTINCT query fails (permissions, pool timeout per P1-1).
- **Expected:** dropdown shows a note like "distinct values unavailable — showing loaded rows" (the messages.ts:110-112 comment promises "the webview keeps its loaded-row fallback", which it does, but the user is not told the list is partial).
- **Actual:** no feedback; a truncated (>1000 distinct) or errored list is indistinguishable from a complete one.
- **Proposed fix (small):** render `truncated`/`error` in the SetFilterComponent footer status line.
- **Proposed test:** `src/ui/__tests__/webviewDistinctValues.test.ts` — reply with truncated:true shows an indicator. Disposition: **queued (UI polish) or TASK-006/007 if budget allows.**

### P2-4 — `inferColumns` numeric-string sniffing misclassifies string columns as right-aligned numbers (display+export alignment only)

- **Evidence:** `src/ui/resultsGridModel.ts:63` `NUMERIC_STRING` + `:94-95` — a varchar column whose loaded sample is all numeric-lookalike strings (`"007"`, `"-1.5e3"`) is inferred `kind: "number"`, `alignRight`.
- **Trigger:** varchar zip codes / phone numbers in the first ≤1000 rows.
- **Expected:** string column (the file's own header comment at :20-21 promises "a `varchar` `'007'` must stay a quoted string" — and the SQL filter path honors that via `typed`; but the grid's column typing does not).
- **Actual:** cosmetic (alignment, tabular-nums) — the filter/save/export paths use `typed[]` and are unaffected. No data corruption; classify P2 not P1.
- **Proposed fix (medium):** thread `columnTypes` (already available host-side for `(Blanks)`, resultsPanel.ts:1147-1156) into the state message or spec inference and prefer declared types over row sniffing.
- **Proposed test:** `src/ui/__tests__/resultsGridModel.test.ts` — declared-type override case. Disposition: **queued (medium, protocol addition).**

### P2-5 — `onRefreshClick` uses `window.confirm`, which does not exist in the webview sandbox

- **Evidence:** `webview/main.ts:2589-2595` — `typeof window.confirm === "function" ? window.confirm.bind(window) : null; const proceed = confirmFn ? confirmFn(...) : true;`. VS Code webviews do not provide `window.confirm` (no native dialogs; the API is unavailable/undefined in the sandboxed iframe).
- **Trigger:** dirty edits present, click Refresh.
- **Expected:** confirmation before discarding edits.
- **Actual:** `confirmFn` is null → `proceed = true` → edits silently discarded. The guard is dead code in production (it works in jsdom where tests stub it).
- **Proposed fix (small):** use an in-DOM confirm banner (reuse the saveBanner pattern) or post a host-side `showInputBox`/message round trip. Marked *needs live verification* of current webview `window.confirm` availability per VS Code version, but the fallback-to-true direction is unsafe regardless.
- **Proposed test:** `src/ui/__tests__/webviewRetry.test.ts` style — stub `window.confirm` absent, assert Refresh does NOT clear editState without confirmation. Disposition: **TASK-006/007 candidate (data-loss adjacent — arguably P1; downgraded to P2 because the click is explicit and rare).**

### P2-6 — `serializeSqlUpdates`/`serializeWhereClause` interpolate unquoted column names

- **Evidence:** `src/ui/resultsGridModel.ts:705-706` `` `${c}=${sqlLiteral(row[i])}` `` — same at :720-721, :777-778. Column names from the result set go in unquoted; a column named `order` or `select` yields invalid SQL in the export.
- **Trigger:** export sql-updates/sql-where on a result whose columns include a reserved word or space (e.g. via `AS "First Name"`).
- **Expected:** export produces executable SQL ("never produce unexecutable SQL" is the file's own contract at :656-657).
- **Actual:** `UPDATE results SET order=...` fails to parse. `opts.tableName` is likewise interpolated raw (:726) but the webview hardcodes `"results"` (main.ts:2990) so it is cosmetic there.
- **Proposed fix (small):** run names through a minimal exporter-local quoter (or reuse `quoteIdent` if the browser bundle constraint allows — `queryComposer` already imports it webview-side via saveStatements with no driver deps, queryComposer.ts:23).
- **Proposed test:** `src/ui/__tests__/resultsGridModelExport.test.ts` — reserved-word column case. Disposition: **TASK-006/007 candidate (small).**

### P3-1 — `git diff --check v1.6.3..v1.6.6` fails (exit 2) on two range-internal whitespace defects

- **Evidence:** `docs/AI_HANDOFF/archive/cycle-V-TASK-001.md:124` trailing whitespace; `src/ui/sqlSemanticTokens.ts:170` new blank line at EOF. This is a Verification Command of this task and it does not exit 0.
- **Disposition:** trivial fix, fold into any Wave-2 task touching those files or a 2-line chore. No behavior impact.

### P3-2 — Dead guard block in `unquoteIdent`

- **Evidence:** `src/ui/queryComposer.ts:249-253` — an `if` whose body is only a comment; the actual escape handling is the scan below. No wrong behavior (the scan is correct for `"a""`, unterminated, etc. — verified by trace), pure noise.
- **Disposition:** queued cleanup; do not spend audit-fix budget.

### P3-3 — `sanitizeStatementResult` clones the `batched` cursor handle's envelope but strips only `rows`

- **Evidence:** `src/ui/resultsPanel.ts:1486-1496` spreads `...r` (carrying the live `batched` object with function properties) then replaces `result`. Structured clone would THROW on functions if `batched` reached `postMessage` — it does not today only because the webview-facing statement type declares `batched?: boolean` and tests ship `batched: true` (webviewFilters.test.ts:172). A host that posts a statement carrying the real handle (any future caller of `postMessage({type:"state"})` using unfiltered runner results — e.g. the `ready` path at :429-434 posts `lastResults`, which DO carry the real cursor objects from `runner.run`) would fail to clone.
  - Verified: `extension.ts:642-646` passes `runner.getResults()` (real handles) to `render()` → `postMessage` → `sanitizeStatementResult` → `{...r}` keeps `batched` (an object with `fetchBatch/close/cancel` functions) in the payload. VS Code's `postMessage` uses a laxer clone than strict structured-clone in practice (functions are dropped or the promise rejects; the surrounding try/catch at :281-300 exists exactly because rejections happen). The tests never exercise a real handle through this path, so behavior in the wild is *needs live verification* — but the type mismatch (`BatchedQuery` object vs the declared `boolean`) is unambiguous.
- **Expected:** the wire type (`batched?: boolean`) is what the host actually sends.
- **Actual:** an opaque cursor object is (attempted to be) shipped; at best the webview receives junk, at worst the post rejects and the panel stops updating (the catch shows an error toast).
- **Proposed fix (small):** in `sanitizeStatementResult`, emit `batched: !!r.batched`.
- **Proposed test:** `src/ui/__tests__/resultsPanel.test.ts` — state post with a function-bearing `batched` asserts the payload field is boolean. Disposition: **promote to P2/P1 pending live verification; small fix either way.**

## Checked and clean

- `webview/sqlHighlight.ts` — full trace: unterminated strings/comments/quotes terminate at EOF; `''`/`""`/`` `` `` escapes; number lexing incl. `.5`/`1e-3`/`1e+3`; keyword set case-insensitive; round-trip property (every char consumed once); DOM built via createElement/textContent only. No defects.
- `queryComposer.buildFilterWhere` — `(Blanks)` never yields empty `IN ()`; typed/display mismatch degrades correctly; no display-string type sniffing; NULL routing via typed; string-family type match is bounded and fails closed. Clean.
- `queryComposer.parseOrderBy`/`buildOrderByClause` — bare + quoted identifier grammar traced incl. doubled escapes, comma splitting inside quotes, NULLS rejection for mysql/mssql, unsafe-identifier rejection. Clean (see P1-2 for the caller-side colId mapping issue).
- `buildPagedQuery`/`buildPagedQueryTerms` — mssql `ORDER BY (SELECT NULL)` placeholder, tiebreaker dedup, alias disjointness (`UnicDB_page`/`UnicDB_sort`/`UnicDB_sub`/`UnicDB_distinct`). Clean.
- `distinctValues.ts` — probe `limit+1`, ragged-row tolerance, mssql `TOP` variant, truncation flag. Clean.
- Requery staleness — `requerySeq` guard increments before awaits and drops stale completions both success (:1212) and error (:1272); "running" pre-post enables the webview reset detection; `adopt()` + displaced-cursor close. Clean.
- DISTINCT staleness — host `statementGeneration` + per-key cache cleared on render/requery (:1244-1245); webview token/generation check (:2272-2273) and identity string incl. durationMs to catch same-SQL reruns (:3294-3296). Clean.
- Edit/save addressing — `__rowId` high-water mark, `serverIndexByRowId` clearing discipline across reset branches, insert-marker overlay in `buildSaveStatements`, `clearExceptRowIds` partial-failure handling, `saveResult`-before-state ordering, retry subset re-filter. Clean (traced against webviewEdit/webviewSaveEdits/webviewRetry tests).
- `sanitizeCell` — BigInt safe-range conversion, Date→ISO, circular guard via WeakSet, try/catch around property reads. Clean.
- CSP/HTML — `escapeHtml` on title; `default-src 'none'`; no innerHTML with dynamic content anywhere in main.ts except the fixed SVG icon strings (static literals). `tabTitle` via textContent. Clean.
- Export serializers — csvEscape RFC4180, xmlEscape ordering (`&` first), SQL literal single-quote-only portability, hidden-column name/position precedence, empty-SET row skip. Clean except P2-6.
- Manual-commit save path — pinned transaction routing, rollback-on-failed-commit invariant, cursor close before `beginTransaction`. Clean except P1-4 (button paths) and P1-1/P1-5 (cursor/pool ordering).
- `messages.ts` shapes vs both consumers — additive-only evolution verified (`distinctValues` ignored by older bundles, optional fields). Clean except P1-3.

## Rejected observations

- *"Distinct cache is never bounded"* — capped at 1000 values per column by the host probe; the webview map holds ≤1 per column of the active statement and is cleared on identity change. Not a leak.
- *"postFilterRequery offset uses statementRows length which may exceed server truth after filters change"* — filters always produce a fresh page-0 requery (no offset) via `scheduleFilterRequery`; offset only rides the `dispatchLoadMore` path where `colFilterActive` is true and rows came from the same filtered query. Consistent.
- *"inferColumns dedup `name__N` can collide with a pre-existing `name__2` column"* — guarded by seeding `usedFields` with every emitted field including suffixed ones (resultsGridModel.ts:82-120). Correct.
- *"applyUndoAction redo of add-row leaks newRowCount on repeated redo"* — undo/redo pops are bracketed (`newRowCount++/--` symmetric); stack prevents double-redo. Correct.
- *"webview `header` for Browse tabs breaks dialect detection"* — `detectDialectFromHeader` returns "unknown" → postgres quoting fallback, which is wrong for mysql/mssql browse sessions (only affects `quoteColIdIfNeeded` for non-bare colIds on Browse headers). Real but low-frequency edge; fold into P1-2's fix (same function family). Not separately actionable.

## Follow-up disposition summary

- **P1-1, P1-2, P1-3, P1-4, P1-5** → mandatory; fit TASK-006/TASK-007 budget (all small, ≤30-line fixes) except P1-1/P1-5 share `resultsPanel.ts` and must be one task together — same-file rule.
- **P2-1, P2-3, P2-5, P2-6** → TASK-006/007 if they fit without file collisions; else queue.
- **P2-2** → TASK-001 territory (queryRunner.ts), cross-listed, single-owner fix.
- **P2-4** → queue (medium, protocol change).
- **P3-1** → chore. **P3-2** → queue. **P3-3** → promote after live verification; fix is one line.
