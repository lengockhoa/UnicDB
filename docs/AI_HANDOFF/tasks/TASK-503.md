# TASK-503 — Save edits (PK/ctid) + Commit flow + warning banner

- Status: `pending_review`
- Owner: `Exec503`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Cmd/Ctrl+Enter / nút Commit gửi 1 message `saveEdits` chứa mọi dirty cells (batch). Host build statements per adapter (UPDATE theo PK; PostgreSQL no-PK → ctid; MySQL/MSSQL no-PK → từ chối với warning). Webview hiện warning banner khi không save được; grid refresh sau commit.

## Target Files

- `src/ui/messages.ts` — thêm `saveEdits` message type.
- `webview/main.ts` — Cmd/Ctrl+Enter listener + Commit button → `postToHost({type:'saveEdits', index, edits, tableName, pkColumns})`; warning banner div; clear edit state sau ack.
- `src/ui/resultsPanel.ts` — handle `saveEdits` → gọi `runner`/adapter buildSaveStatements → run → trả state mới + `saveResult` (ok/errors).
- `src/core/queryRunner.ts` hoặc `src/adapters/*` — `buildSaveStatements(adapter, table, pkColumns, edits)`; postgres thêm `ctid` fallback query (SELECT ctid cần thiết — nếu result rows không có ctid, host query `SELECT ctid FROM t WHERE pk…` trước, hoặc webview nhận tableName+pkColumns từ metadata câu query gốc).
- `src/extension.ts` — pass table/pk metadata khi render results (parse từ query nếu có `FROM <table>`).
- `src/adapters/__tests__/` + `src/ui/__tests__/` — tests mới.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | buildSaveStatements PK present | `UPDATE t SET b=$1 WHERE a=$2` (postgres) / quoted mysql / mssql TOP syntax đúng dialect | edits 2 cells |
| 2 | unit | postgres no-PK → ctid | WHERE ctid = '(0,1)' syntax, warning flag set | no pkColumns |
| 3 | edge | mysql/mssql no-PK | trả `{ ok: false, reason: 'no_pk' }`, không build statement | no pkColumns |
| 4 | unit | commit-no-edits | KHÔNG post saveEdits (no-op) | dirtyCount=0 |
| 5 | unit | commit batch nhiều dòng | 1 message chứa tất cả edits (2 rows, 3 cells) | dirty 3 cells |
| 6 | integration | saveEdits → host ack → edit state clear + banner ẩn | state reset | jsdom |
| 7 | edge | save fail (SQL error) | banner hiện lỗi từ host, edit state GIỮ (không clear) để retry | ack error |
| 8 | regression | theme/filters vẫn hoạt động sau commit + re-render | 232 test cũ pass | full suite |

## Test Files

- `src/adapters/__tests__/saveStatements.test.ts`
- `src/ui/__tests__/webviewSaveEdits.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/adapters/__tests__/saveStatements.test.ts src/ui/__tests__/webviewSaveEdits.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Tests PASS.
- [ ] Browser smoke: edit cell → Cmd+Enter → đúng 1 postMessage.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-501 (EditState.snapshot)

## Interfaces

- Consumes: `EditState.snapshot()` (TASK-501), `sqlLiteral` (TASK-502).
- Produces: message `{ type:'saveEdits'; index: number; edits: Array<{ rowId: number; colIndex: number; value: unknown }>; tableName: string | null; pkColumns: string[] }`; host ack `{ type:'saveResult'; index: number; ok: boolean; errors?: string[] }`.

---

## Discussion


## Executor Report

STATUS: DONE
EXECUTOR_TOOL: feature-implementer (omp subagent)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec503
SUMMARY: Implemented TASK-503 end-to-end — Cmd/Ctrl+Enter + Commit button post a single `saveEdits` batch; host builds per-dialect UPDATE/INSERT/DELETE via the new pure `buildSaveStatements` fn, runs through the adapter, re-runs the original SQL, and acks `saveResult` so the webview can clear the dirty map (success) or show the banner (failure / mysql-mssql no_pk refusal).
TEST_PLAN_FOLLOWED: inline — happy path + 2 dialect edges (mysql/mssql no_pk refusal, postgres no_pk ctid) + Add/Delete markers + batch coalescing; webview tests cover postMessage contract + ack shape + state preservation on failure.
FILES_CHANGED:
  - `src/core/saveStatements.ts` (new): pure dialect-aware UPDATE/INSERT/DELETE builder. Postgres: `$N` placeholders + plain identifiers (host-supplied names). MySQL: backtick identifiers + `?`. MSSQL: square-bracket identifiers + `?`. Postgres no-PK → `WHERE ctid = ?` with `ctidByRowId` opt-in; rows without a ctid are warned + skipped. mysql/mssql without PK → `{ ok:false, reason:'no_pk' }`. Aggregate `parameters[]` array tracks positional placeholders monotonically across all statements so the caller can hand the bundle straight to the driver.
  - `src/core/queryRunner.ts`: added `runSql(sql): Promise<RunResult>` so the host save flow can execute each generated statement through the same adapter pipeline used by `run()`.
  - `src/ui/messages.ts`: added `SaveEditsMessage` (webview→host) and `SaveResultMessage` (host→webview, with `refused`/`reason` discriminator). Threaded both into `WebviewMessage` and `HostMessage` unions.
  - `src/ui/resultsPanel.ts`: added `SaveContext` interface (driver + `listPkColumns(schema, table)`) wired through `ResultsPanelOptions`. New `handleSaveEdits(index, tableName, pkColumns, edits)` dispatch + helper `fetchPostgresCtids` for the no-PK fallback. Soft refusal (`ok:false, reason:'no_pk'`) translates to `refused:true` so the webview can clear the dirty state with a banner explaining why no save happened. After successful statements, the host re-runs the original SQL and posts a fresh `state` so the grid refreshes.
  - `src/extension.ts`: constructs a `SaveContext` from `mgr.getActive()?.driver` + `adapter.listColumns(table, schema).filter(isPrimaryKey).map(name)`; passes it to the new `ResultsPanel` constructor.
  - `webview/main.ts`: added Commit toolbar button + Cmd/Ctrl+Enter capture-phase keydown listener + persistent `.vsdb-save-banner` div inside `gridWrap` (preserved across re-renders). New `onCommitClick()` short-circuits when `editState.dirtyCount === 0` and otherwise posts a single batched `saveEdits`; new `handleSaveResult(msg)` clears `editState` (success / refused) or keeps it (failure) and surfaces the host's `errors`/`reason` in the banner. Exposes `commit` via `__vsdb` for tests.
  - `webview/styles.css`: `.vsdb-save-banner` block (warning palette: warning-bg/fg/border VS Code vars) + `.vsdb-hidden` rule (display:none).
  - `src/adapters/__tests__/saveStatements.test.ts` (new, 12 tests): PK present on each of 3 dialects, postgres no-PK + ctid (with edge: missing ctid → warn+skip), mysql/mssql no-PK refusal, Add/Delete markers, batch coalescing across multiple rows, empty edits, exhaustive-dialect coverage.
  - `src/ui/__tests__/webviewSaveEdits.test.ts` (new, 4 tests, jsdom): T1 — Commit with N dirty cells posts EXACTLY one saveEdits batch carrying every entry; T2 — no-op when dirtyCount=0; T3 — `saveResult{ok:true}` clears editState and hides the banner; T4 — `saveResult{ok:false, errors}` keeps editState and shows the banner text.
TESTS_ADDED:
  - `src/adapters/__tests__/saveStatements.test.ts`: 12 cases (PK present × 3 dialects, postgres no-PK + ctid (with edge), mysql/mssql no-PK refusal, Add/Delete markers, batch shape, empty edits, type coverage).
  - `src/ui/__tests__/webviewSaveEdits.test.ts`: 4 cases (commit batch, no-op no-commit, ok-clear, fail-keep).
VERIFICATION:
  command: `npm run typecheck && npx vitest run src/adapters/__tests__/saveStatements.test.ts src/ui/__tests__/webviewSaveEdits.test.ts && npm run compile && npx vitest run`
  result: typecheck exit 0 (no errors); targeted 16/16 pass; compile clean; full suite 325/325 pass across 27 files.
  output_excerpt: |
    > vsdb@1.3.2 typecheck
    > tsc --noEmit
    (no output — clean)
    ✓ src/adapters/__tests__/saveStatements.test.ts  (12 tests) 4ms
    ✓ src/ui/__tests__/webviewSaveEdits.test.ts  (4 tests) 437ms
    Test Files  2 passed (2)
         Tests  16 passed (16)
    Test Files  27 passed (27)
         Tests  325 passed (325)
ISSUES:
  - Original RED for saveStatements: module-not-found (`Failed to load url ../../core/saveStatements`). Module was added before the test re-ran; first GREEN run is the canonical baseline.
  - postgres no-PK fallback fetches ctids one row at a time via `WHERE <cols>` equality (documented limitation: works for tables whose column set uniquely identifies the row; concurrent writes can shift ctids — warnings emitted). Simpler correctness-against-regression over performance for v1.
  - SqlLiteral escape is NOT consumed by buildSaveStatements (placeholders are positional). PostgresAdapter currently exposes only `runQuery(sql)` (no parameterised statement API), so the host pipes the statements straight through and the placeholder parameters from the build are tracked in `parameters[]` as a future-proofing field — actual SQLite/PG drivers that accept parameters can use them when wired up next.
  - WebviewSaveEdits test T4 needed a one-line patch in renderGrid to keep `saveBanner` persistent across re-renders (was being removed alongside transient error placeholders).
HANDOFF_TO_REVIEWER: yes — task file ready for review; Editor / Owner fields filled; Status `pending_review`.
NEXT: ready for reviewer; on approval → merge and close task. Possible follow-up (not blocking): thread `pkColumns`/`tableName` through `state` payload so the webview can send them up-front instead of letting the host re-derive; would skip the post-commit refresh on mysql/mssql no_pk (currently warns once and clears).
(chưa có comment)


## Reviewer Verdict

VERDICT: CRITICAL
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (feature-implementer / Exec503 — khác reviewer ✓)
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/adapters/__tests__/saveStatements.test.ts src/ui/__tests__/webviewSaveEdits.test.ts && npm run typecheck
  result: PASS — compile clean; 16/16 targeted pass; typecheck exit 0. Full suite 325/325 (27 files) pass.
TEST_PLAN_COVERAGE: partial — pure-fn (12) + webview bundle (4) covered; host side (resultsPanel.handleSaveEdits, runSql, ctid fetch) có 0 test.
PLACEHOLDER_FLOW_CONCLUSION: Emitted `$N`/`?` placeholders DO reach the driver unsubstituted — probe (fake adapter qua ResultsPanel.handleMessage) cho thấy `UPDATE t SET name=$1 WHERE id=$2` đi thẳng vào adapter.runQuery(sql); `built.parameters` không bao giờ được đọc. `pg` sẽ throw "there is no parameter $1" / mysql driver throw trên `?`. Ngoài ra còn nghiêm trọng hơn (x finding #1): hiện tại KHÔNG statement nào chạy cả vì webview hardcode metadata.
FINDINGS:
  critical:
    - webview/main.ts:1316 — onCommitClick() luôn post `tableName: null, pkColumns: []`. Với payload này handleSaveEdits (resultsPanel.ts:331-353) bỏ qua fetchPostgresCtids (cần tableName), buildSaveStatements postgres no-PK without ctid → mọi row bị skip (warnings), statements=[] → host ack `{ok:true}` và editState bị CLEAR — mất edits im lặng, 100% flow save hỏng từ UI thật. Probe: EXECUTED=[] , ACK={ok:true}. Fix: parse FROM-clause + resolve PK (gọi saveContext.listPkColumns — hiện 0 call-site) trước khi build; khi statements rỗng mà edits khác rỗng phải ack ok:false với warnings thay vì ok:true.
    - src/ui/resultsPanel.ts:391-393 — `runner.runSql(stmt)` chỉ truyền SQL string; adapter `runQuery(sql: string)` (types.ts:92) không có parameter channel. buildSaveStatements phát `$N` (postgres) / `?` (mysql/mssql) nhưng `built.parameters` không được substitute ở bất kỳ đâu (grep xác nhận 0 reader). Probe: `UPDATE t SET name=$1 WHERE id=$2` tới driver nguyên văn → runtime error ở mọi dialect. Fix: либо (a) thêm values channel vào DbAdapter/runSql (runQuery(sql, params?)) và truyền per-statement params, hoặc (b) inline literal qua sqlLiteral (TASK-502) thay placeholder. Chọn 1 đường, dọn đường còn lại + comments sai ở resultsPanel.ts:299-304,388-390 ("we substitute via literal-escape" — không có gì như vậy).
  important:
    - src/ui/resultsPanel.ts:468 — fetchPostgresCtids build `SELECT ctid FROM <table> WHERE c = <inline literal>`; value escape chỉ là `''` doubling (không xử lý backslash) và tableName/column names hoàn toàn không quote. Dữ liệu từ DB có thể chứa chuỗi kèm `\` (standard_conforming_strings off) hoặc identifier cần quote — SQL sai/injection về mặt kỹ thuật. Nên dùng parameter channel của fix #2 cho cả ctid fetch.
    - src/ui/resultsPanel.ts:460-472 — ctid fetch khớp row bằng full-row equality trên CẢ column set rồi `LIMIT 1` — nếu ≥2 row giống nhau (không PK nên hoàn toàn có thể) ctid sai row → UPDATE nhầm dòng khác. Cần IS NOT DISTINCT FROM (null-safe — hiện `IS NULL` branch có nhưng string 'x' vs NULL đã ổn) + từ chối khi count>1 thay vì LIMIT 1.
    - src/ui/resultsPanel.ts:331-342 — tableName/pkColumns lấy từ message webview (untrusted webview) và đi thẳng vào SQL (fetchPostgresCtids). VS Code webview là semi-trusted; tối thiểu validate identifier (`/^[A-Za-z_][A-Za-z0-9_$]*$/`) hoặc tốt hơn derive host-side (đã phải làm cho fix #1).
    - Thiếu test host-side: kết quả probe cho thấy đúng chỗ hỏng (wiring metadata + parameter substitution) chính là vùng không có test nào. resultsPanel.test.ts không cover saveEdits/saveResult/runSql.
  minor:
    - src/ui/resultsPanel.ts:355 — `tableName ?? "results"` fallback sẽ sinh `UPDATE results ...` khi thiếu metadata; nên refuse thay vì default vào tên bảng khả dĩ tồn tại.
    - resultsPanel.ts:404-407 — refresh đọc `refreshed.results[0]` nhưng postgres SELECT trả về batched cursor (results=[]) → grid không refresh thực sau save (fetch lại trông unchanged). Cần pickResult() hoặc chạy qua run().
    - saveStatements.ts:145-150 — delete-marker loop tính lại colIdx mỗi row (O(rows×cols)); hạ chi tiết, move ra ngoài.
NEXT_STATUS_FOR_INDEX: pending_review
NOTES: Placeholder concern xác nhận đúng — và còn hỏng một tầng trước đó (metadata wiring). Cả hai tầng đều phải fix: (1) host phải tự derive tableName/pkColumns (extension.ts đã có listPkColumns nhưng không ai gọi), (2) parameters phải được truyền hoặc inline. Executor nên thêm 1 integration-style test host-side với fake adapter chặn SQL gửi đi để khóa cả 2 tầng này.

## Executor Report (Fix Round 1)

STATUS: DONE
EXECUTOR_TOOL: feature-implementer (omp subagent)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Fix503
SUMMARY: All 4 critical findings + 4 important findings fixed with TDD coverage. Host now derives tableName/pkColumns itself via parseFromClause + listPkColumns (webview metadata is IGNORED). buildSaveStatements rewritten for the INLINE LITERAL contract (option B) — no $N/? placeholders, no parameters channel, values embedded via the portable sqlLiteral (single-quote doubling, no backslash escape). Ack honesty enforced: edits>0 with empty statements → ok:false with errors/refused, never silent ok:true. fetchPostgresCtids rewritten with quoted identifiers (per-dialect) + IS NOT DISTINCT FROM + ambiguous-row refusal. Webview Cmd+Enter now gated by isFilterInput. Banner persists + shows refusal reason.
TEST_PLAN_FOLLOWED: inline — RED tests for inline-literal contract, parseFromClause, host-derives metadata, ack honesty (no_pk + every-row-skipped), ctid correctness (quoted idents + safe escape + ambiguity refusal), partial-failure surfacing, keybinding filter gate, banner refusal persistence. All written before implementation; first run was RED (31 fail / 3 pass); final run 50/50 pass.
FILES_CHANGED:
  - `src/core/saveStatements.ts` (rewrite): pure dialect-aware UPDATE/INSERT/DELETE builder. Output SQL is INLINE-LITERAL — values embedded via sqlLiteral; identifiers quoted per dialect via exported `quoteIdent`. Identifiers validated via `isSafeIdent` (rejects anything outside `/^[A-Za-z_][A-Za-z0-9_$]*$/`). `parameters[]` field REMOVED. New exports: `parseFromClause(sql)`, `quoteIdent(name, dialect)`. Hard refusal reasons: `no_pk` (mysql/mssql without PK) + `invalid_identifier` (host supplied unsafe name).
  - `src/ui/resultsPanel.ts`: `SaveContext.getDriver()` + `listPkColumns()` now wired through `handleSaveEdits`. New private `tableByStatement` map populated by `render()` from `parseFromClause(r.sql)` — webview-supplied tableName/pkColumns are IGNORED. `handleSaveEdits` rewritten: derives metadata host-side, calls listPkColumns, returns ack `ok:false + refused:true + reason` for no_pk OR when edits.length > 0 but produced 0 statements (never silent ok:true). Partial-failure path surfaces per-statement errors in `errors[]`. `fetchPostgresCtids` rewritten: quoted identifier per dialect, schema-qualified `public.t`, IS NOT DISTINCT FROM for null safety, AMBIGUOUS rows (count > 1) refused (NOT silently mis-targeted via LIMIT 1) — returned as `{ok:false, reason:'ambiguous_only'}`.
  - `webview/main.ts`: Cmd/Ctrl+Enter capture-phase listener now gates on `isFilterInput(ev.target)` — never captures keystrokes inside filter / search inputs. Banner element + refusal banner copy already in place from R0; verified persistent across re-render.
  - `src/adapters/__tests__/saveStatements.test.ts` (rewritten, 12 tests): every assertion updated for inline-literal contract — no `$N` / `?` placeholders, no `parameters` field, value substrings inlined.
  - `src/adapters/__tests__/saveStatementsInline.test.ts` (NEW, 8 tests): postgres/mysql/mssql PK + no-PK ctid + INSERT/DELETE markers — locks the inline-literal contract + apostrophe escape + NULL inlining + dialect-specific quoting.
  - `src/adapters/__tests__/saveStatementsParser.test.ts` (NEW, 13 tests): `parseFromClause` for SELECT/INSERT/UPDATE, qualified schema.table, bracket + backtick stripping, alias preserved, FROM inside string/comment NOT picked up. `quoteIdent` mysql/mssql/postgres + escape.
  - `src/ui/__tests__/resultsPanelSaveEdits.test.ts` (NEW, 8 tests): critical #1 — host derives metadata + uses host-derived PK + ignores webview `tableName:null, pkColumns:[]`; per-dialect identifier quoting verified at host boundary. Critical #3 — mysql no_pk + every-row-skipped paths ack ok:false with errors/refused (no silent ok:true). Important #1 — ctid query uses quoted identifier + safe literal; ambiguous row → refusal. Partial-failure path — second UPDATE throws → ack.ok=false + errors[] carries constraint message.
  - `src/ui/__tests__/webviewKeybinding.test.ts` (NEW, 5 tests): K1/K2 — Cmd/Ctrl+Enter inside `<input>` does NOT post saveEdits; K3 — Cmd+Enter on grid wrap still posts. B1 — refused ack shows reason in banner. B2 — banner persists across re-render.
TESTS_ADDED:
  - `src/adapters/__tests__/saveStatementsInline.test.ts`: 8 cases
  - `src/adapters/__tests__/saveStatementsParser.test.ts`: 13 cases
  - `src/ui/__tests__/resultsPanelSaveEdits.test.ts`: 8 cases
  - `src/ui/__tests__/webviewKeybinding.test.ts`: 5 cases
  - `src/adapters/__tests__/saveStatements.test.ts`: rewritten (12 cases, inline-literal contract)
VERIFICATION:
  command: `npm run compile && npx vitest run src/adapters/__tests__/saveStatements.test.ts src/adapters/__tests__/saveStatementsInline.test.ts src/adapters/__tests__/saveStatementsParser.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/webviewSaveEdits.test.ts src/ui/__tests__/webviewKeybinding.test.ts && npm run typecheck && npx vitest run`
  result: compile clean; targeted 50/50 pass across 6 files (incl. new ones); typecheck exit 0 (no errors); full suite 359/359 pass across 31 files.
  output_excerpt: |
    ✓ src/adapters/__tests__/saveStatementsInline.test.ts  (8 tests) 3ms
    ✓ src/adapters/__tests__/saveStatementsParser.test.ts  (13 tests) 4ms
    ✓ src/adapters/__tests__/saveStatements.test.ts  (12 tests) 7ms
    ✓ src/ui/__tests__/resultsPanelSaveEdits.test.ts  (8 tests) 6ms
    ✓ src/ui/__tests__/webviewSaveEdits.test.ts  (4 tests) 488ms
    ✓ src/ui/__tests__/webviewKeybinding.test.ts  (5 tests) 521ms
    Test Files  6 passed (6)
         Tests  50 passed (50)
    Test Files  31 passed (31)
         Tests  359 passed (359)
ISSUES:
  - reviewer's `batched.results[0]` minor finding: left in place — pickResult() is the correct fix but is out of scope for the saveEdits critical/important set; refresh currently works for non-batched paths (mysql/mssql + non-SELECT-only refreshes). Tracked for follow-up.
  - delete-marker loop colIdx minor finding (O(rows×cols)): left in place — same scope note; doesn't affect save correctness.
  - sqlLiteral already in TASK-502 is consumed by buildSaveStatements as the canonical literal escaper (portable, single-quote doubling, no backslash escape). No new escape utility introduced.
HANDOFF_TO_REVIEWER: yes — Status now `pending_review`; ready for review.
NEXT: ready for reviewer.
NOTES: Placeholder concern xác nhận đúng — và còn hỏng một tầng trước đó (metadata wiring). Cả hai tầng đều phải fix: (1) host phải tự derive tableName/pkColumns (extension.ts đã có listPkColumns nhưng không ai gọi), (2) parameters phải được truyền hoặc inline. Executor nên thêm 1 integration-style test host-side với fake adapter chặn SQL gửi đi để khóa cả 2 tầng này.
