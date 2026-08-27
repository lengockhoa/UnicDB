# Cycle Y Plan — Finish the queued work

Base: `main` @ `c890072` (v1.6.7, clean tree). Executor: `bao-sonnet`. Reviewer: `bao-opus`.
Cycle X plan and task files archived at `docs/AI_HANDOFF/archive/cycle-X-*`.

## §1 Intent

Cycle X shipped a hardened v1.6.7 but deliberately deferred a queue: six findings triaged at
the reconciliation gate plus the earlier backlog Cycle W left open. Cycle Y's job is to
**finish that queue** — no new feature surface beyond what those items imply.

Scope complexity: MODERATE (one subsystem — the results/query surface of a single extension).
No decomposition into later modules is required; all eight queued items are planned here.

Success means:

1. every queued item is implemented with tests, or explicitly re-queued with a stated reason;
2. the full suite stays green — baseline **1552 passed / 2 skipped / 0 failed**;
3. `npm run typecheck` exits 0 and `npm run compile` succeeds;
4. every SQL-composing change is correct on all three dialects with per-dialect assertions;
5. every task carries a reviewer verdict of APPROVED or APPROVED-WITH-MINOR.

**Human product decision recorded verbatim (C1).** `manualCommit` is unreachable from the UI;
the options were "expose it or delete the path". *The user chose EXPOSE THE UI*: add a UI
surface that enables manual-commit mode on a connection (a toggle in the connection add/edit
form), so the existing host path — `beginTransaction()` → pinned `DbTransaction` → the
Commit/Rollback toolbar controls already built in cycle U — becomes reachable.

Consequence recorded: exposing C1 **unblocks** the queued "pg metadata vs manual-commit window"
item, which INDEX.md marks *blocked on C1*. §2 records the decision on it.

The eight items:

1. Keyset (cursor) paging for deep offsets **and** safely projecting missing PK columns.
2. M2 — MySQL multi-statement batch partial commit.
3. C1 — expose `manualCommit` in the connection form.
4. P2-3 (DISTINCT truncated/error note) **paired with** scoping DISTINCT values to the active
   filter/WHERE — same surface, one task.
5. P2-4 — `inferColumns` must not let sampled values override the server's declared type.
6. `NULLS FIRST/LAST` emulation on mysql/mssql.
7. Typed `dialect` field on `StateMessage`, replacing header-string parsing.
8. Reviewer open minors (nine small items) — distributed into the file-owning tasks.

## §2 Scope

### In scope

| # | Item | Task |
|---|------|------|
| 1 | Keyset paging + project missing PK columns | TASK-004 |
| 2 | M2 MySQL batch transaction policy | TASK-002 |
| 3 | C1 manual-commit UI surface | TASK-001 |
| 4 | DISTINCT scoped to active WHERE + truncated/error note | TASK-006 |
| 5 | P2-4 declared-type override in `inferColumns` | TASK-003 |
| 6 | NULLS emulation on mysql/mssql | TASK-005 |
| 7 | Typed `dialect` on `StateMessage` | TASK-007 |
| 8 | Reviewer open minors | distributed (below) |

Minors distribution (item 8) — each minor goes to the task that already owns its file, per the
INDEX.md precedent "bundle it into the next file-owning task rather than spending a wave on it":

| Minor | file:line | Owner |
|-------|-----------|-------|
| `manualStatementIndex` never reset in `render()` | `resultsPanel.ts:194-229` | TASK-004 |
| Committed-save refresh rethrow | `resultsPanel.ts:929-945` | TASK-004 |
| Positional ORDER BY for duplicate column names | `webview/main.ts:2219-2222` | TASK-007 |
| `hiddenColumns` missing from `readExportInput` return type | `webview/main.ts:2983-2993` | TASK-007 |
| Dead `void received;` / `void root;` | `webviewExport.test.ts:369,392` | TASK-007 |
| `webviewServerSort.test.ts` case-18 flake root cause | `:557` | TASK-008 |
| Stale TRIM test titles | `queryComposer.test.ts:685,698` | TASK-005 |
| Dead guard in `unquoteIdent` (P3-2) | `queryComposer.ts:252-257` | TASK-005 |

### Out of scope for this cycle (stays queued in INDEX.md)

- **pg metadata vs manual-commit window.** DECIDED: stays queued, **not** a Cycle Y task.
  Rationale in §3.9. TASK-001 unblocks it, so its INDEX.md entry loses the "blocked on C1" note.
- Any new AI/chat, export, or schema-tree work. Any dependency upgrade. Any release/publish.
- MSSQL manual transactions: `src/adapters/mssql.ts` has no `beginTransaction` at all (0 grep
  hits). No finding reported it; not tasked, not queued. Stated so it is not mistaken for
  coverage.

### File-ownership constraint (hard)

**Tasks in the same wave must not modify the same file.** Where two items want one file, the
items are merged into one task or serialized by an explicit dependency. The collision map that
drove the split:

| File | Wanted by items | Resolution |
|------|-----------------|------------|
| `src/ui/queryComposer.ts` | 1, 6, 8 | Sole owner **TASK-005**. TASK-004 must NOT touch it — its keyset composition goes into a NEW `src/ui/keysetPaging.ts`. |
| `src/ui/resultsPanel.ts` | 1, 4, 7, 8 | Wave-1 owner **TASK-004**. TASK-007 (wave 2) and TASK-006 (wave 3) each need it later ⇒ ordered by dependency, never concurrent. |
| `webview/main.ts` | 4, 5, 7, 8 | Wave-2 owner **TASK-007**. TASK-006 (wave 3) edits it after. TASK-003 does not touch it at all. |
| `src/ui/messages.ts` | 4, 5, 7 | Wave-2 owner **TASK-007** — the `dialect` field plus the DISTINCT note fields land in one edit. |
| `src/extension.ts` | 3, 7 | Sole owner **TASK-001**. TASK-007's `dialect` is filled inside `resultsPanel`, not by a new `extension.ts` call (§3.7), so there is no second owner. |
| `src/adapters/mysql.ts` | 2 | Sole owner **TASK-002**. |
| `src/ui/resultsGridModel.ts` | 5 | Sole owner **TASK-003**. |
| `src/ui/__tests__/resultsPanelOrderBy.test.ts` | 1, 6 | Sole owner **TASK-005** (it holds the NULLS rejection assertions). TASK-004 is forbidden from editing it. |

## §3 Approach

### §3.1 TASK-001 — expose `manualCommit` (item 3)

Grounded facts: `src/config/types.ts:44` already declares `manualCommit?: boolean`;
`src/extension.ts:97` already reads it (`getManualCommit: () => mgr.getActive()?.manualCommit === true`).
The host path exists end to end. What is missing is only the form field and the two config
literals.

Change set:
- `src/ui/connectionFormMessages.ts` — add `manualCommit: boolean` to `ConnectionFormSubmit`
  and `ConnectionFormTest` (they carry identical field lists today; keeping them symmetric
  avoids a second shape). `SubmitPayload` is `Omit<ConnectionFormSubmit,"type">`
  (`connectionForm.ts:18`), so it picks the field up with no edit there.
- `webview/connectionFormMain.ts` — a checkbox `id="manualCommit"` using the existing
  `<label class="vsdb-form-check">` pattern that `useSsl` uses (`:151-153`); `readForm()`
  (`:50-64`) returns `manualCommit: input("manualCommit").checked`; `applyInit()` (`:201-220`)
  prefills from `existing.manualCommit === true`.
- `src/extension.ts` — `openConnectionForm`'s add literal (`:740-752`) and edit patch
  (`:760-771`) both carry `manualCommit: payload.manualCommit`.

Alternative rejected: a VS Code setting or command-palette toggle — `manualCommit` is
per-connection state living in `ConnectionConfig`, and the connection form is the only surface
that already round-trips that record.

Alternative rejected: deleting the manual path — the user explicitly chose expose.

Stated unknown: `src/config/types.ts` is unreadable from this planner session (directory
permission denied); only the grep hit at `:44` is confirmed. The executor must open it and
confirm the `ConnectionConfig` shape before writing the literals. Recorded in TASK-001
§Discussion rather than guessed.

The Commit/Rollback toolbar visibility already exists (`webview/main.ts:557-560`, gated on
`transactionStatus`, handled at `:3382`) and is covered by `manualCommit.test.ts:200-213`.
TASK-001 therefore adds **no** `webview/main.ts` change — which keeps the wiring-heavy task
clear of the hottest file.

### §3.2 TASK-002 — MySQL batch transaction policy (item 2, M2)

Today `MySqlAdapter.runQuery` (`mysql.ts:212-217`) loops
`results.push(await this.executeText(text))`. Each `executeText` checks out its own pooled
connection and MySQL autocommits, so a batch failing at statement 3 leaves 1-2 committed.

Constraint that rules out the obvious fix: `multipleStatements: false` (`mysql.ts:76`) — joining
`BEGIN; …; COMMIT;` into one `executeText` is invalid.

Approach: hold ONE `PoolConnection` across the loop. `getConnectionWithUtcSession()`
(`:504-516`) already yields a session-prepared connection and `runQueryOnConnection(connection, sql)`
(`:427-447`) already runs statements on a held connection — it is exactly what
`beginTransaction()` uses at `:246`. So the multi-statement arm becomes: check out one
connection → `connection.beginTransaction()` → run every statement on it → `commit()` on
success → `rollback()` + rethrow on any error → `release()` in `finally`.

User-facing contract (the "explicit policy" M2 asks for): **a multi-statement batch is
all-or-nothing on MySQL.** Postgres already behaves this way via `runQueryOnClient`
(`postgres.ts:384`). Documented in `README.md`.

Edges that must not regress: the single-SELECT streaming arm (`:202-210`) returns before the
loop and must stay byte-identical — wrapping a streaming cursor in a transaction would pin the
`connectionLimit: 1` pool. DDL inside a batch is a known MySQL implicit-commit hazard and
cannot be rolled back, so the documented contract states DDL batches are not atomic; that is a
documentation obligation, not a code path.

### §3.3 TASK-003 — declared types beat sampled values (item 5, P2-4)

`inferColumns(columns, rows)` (`resultsGridModel.ts:76-127`) decides `kind` purely from up to
1000 sampled values, so an all-NULL column becomes `"string"` and a `varchar` holding only
`"123"` becomes `"number"` + `alignRight`.

Approach: widen to `inferColumns(columns, rows, columnTypes?: Record<string, string>)`. When a
declared type exists for a column NAME it decides `kind` and sampling is skipped for that
column; otherwise the existing sampling is byte-identical. The type vocabulary reuses whatever
`queryComposer`'s `isStringColumnType` (`:160`) already understands so the two places agree on
what "a string column" means; numeric and boolean families map to `number`/`boolean`; anything
unrecognized falls back to sampling.

The parameter is optional so every existing call site and test keeps compiling and behaving
identically — that is what lets TASK-003 sit in wave 1 with no dependency.

The webview call site (`webview/main.ts:1618`) is NOT edited here (that file is TASK-007's).
TASK-007 passes the value through once the protocol carries it. Until then `inferColumns`
receives `undefined` and behaves as today — a deliberately inert landing.

### §3.4 TASK-005 — NULLS emulation + queryComposer minors (items 6, 8)

`parseOrderBy` rejects `NULLS` unless postgres (`queryComposer.ts:327-329`);
`buildOrderByClause` (`:443-451`) renders it natively.

Approach: stop rejecting, and emit a leading sort key per dialect:
- postgres — unchanged native `"col" ASC NULLS LAST`.
- mysql — `` `col` IS NULL `` is 1 for nulls, so NULLS LAST → `` `col` IS NULL ASC, `col` ASC ``
  and NULLS FIRST → `` `col` IS NULL DESC, `col` ASC ``.
- mssql — T-SQL allows no boolean expression in ORDER BY, so the same shape via
  `CASE WHEN [col] IS NULL THEN 1 ELSE 0 END ASC|DESC, [col] ASC`.

Intentional behavior change: two existing blocks assert today's rejection and must be
rewritten — `queryComposer.test.ts:372-398` (cases 9/10) and
`resultsPanelOrderBy.test.ts:239-257` (case 8c). This mirrors cycle W's case-16 precedent: one
intentional expectation change per cycle, called out in the plan.

Minors folded in: delete the no-op guard at `queryComposer.ts:252-257` (P3-2 — the `if` body is
a comment only, so removal is provably behavior-free), and retitle the two stale tests at
`queryComposer.test.ts:685,698` whose names say `TRIM(col) = ''` while the assertions are
regex / `NOT LIKE` predicates.

### §3.5 TASK-004 — keyset paging + PK projection + resultsPanel minors (items 1, 8)

Two coupled problems in `handleRequery`:
- `:1227-1232` adds PK tiebreakers only when `pk.every(c => projected.includes(c))`; if one PK
  column is not projected, paging silently loses its gap-free guarantee.
- `buildPagedQueryTerms` always emits `OFFSET n`, so `OFFSET 500000` still scans.

Approach, in a NEW module `src/ui/keysetPaging.ts` (deliberately not `queryComposer.ts`, which
TASK-005 owns this wave — the same tactic cycle W used when it created `distinctValues.ts`):

1. **Project missing PK columns safely.** The rule implemented: a PK column may be projected
   only when the statement is a plain browse-shaped `SELECT … FROM <table>` — exactly the case
   `tableByStatement` (`resultsPanel.ts:213-217`) records. For any other shape — DISTINCT,
   aggregate, explicit projection — no tiebreaker is added and no gap-free promise is made,
   exactly as today. Appending all projected columns is explicitly rejected (INDEX.md: "not a
   valid substitute") because it changes DISTINCT semantics and breaks aggregates.
2. **Keyset paging.** When the composed ORDER BY is total (user terms + full PK) and the caller
   supplies the previous page's last-row key, emit a keyset `WHERE` predicate plus `LIMIT n`
   instead of `OFFSET n`. Page 0 has no predicate and composes byte-identically to today. The
   predicate is an OR-of-ANDs chain rather than a row-value constructor, because MSSQL has no
   row-value comparison.
3. `resultsPanel.ts` consumes the module: `handleRequery` passes the last-row key when the
   webview supplied one, otherwise falls back to OFFSET. **No webview change in this task** —
   the fallback keeps it self-contained and testable at the host boundary.

Minors folded in (both `resultsPanel.ts`): clear `manualStatementIndex = null` inside `render()`
next to the other per-statement-set resets (`:213`); and in the save catch (`:929-945`) replace
the non-manual `throw err` with a `saveResult {ok:true, warnings:[…]}` post, so a save that
already committed at `:826` can never reject out of the un-awaited `handleMessage` (`:177`).

### §3.6 TASK-006 — DISTINCT scoped to WHERE + truncated/error note (item 4)

Two halves of one dropdown:
- Host: `handleRequestDistinctValues` calls `buildDistinctValuesQuery(r.sql, column, dialect, "")`
  (`resultsPanel.ts:1057`). The `where` parameter exists precisely for this
  (`distinctValues.ts:42-47`). The host retains no per-statement WHERE today (verified: no
  `lastWhere`/`whereByStatement`). Add `whereByStatement: Map<number, string>`, written where
  `combinedWhere` is already computed (`composeRequerySql:1132-1134`), cleared in `render()`,
  read here.
- Webview: `handleDistinctValues` drops any reply carrying `error` (`webview/main.ts:2283`) and
  never surfaces `truncated`. Both must render into the existing `.vsdb-setfilter-status`
  footer (`:1216`, text set at `:1444-1450`).

Both halves touch files other tasks own (`resultsPanel.ts` → TASK-004,
`webview/main.ts` + `messages.ts` → TASK-007), so TASK-006 depends on both and runs last.

Design decision recorded: scoping a dropdown to the active filter means a value the user just
filtered out disappears from its own list, stranding them. Mitigation chosen: the retained
WHERE is the requery-bar WHERE **plus the OTHER columns' filters**, excluding the requested
column's own filter — so a column's selection never narrows its own value list. This is why
the map stores a composed WHERE per statement rather than reusing `combinedWhere` verbatim.

### §3.7 TASK-007 — typed `dialect` + webview minors (items 7, 8)

`webview/main.ts:2185-2191` parses the driver out of the header string with
`/—\s*([A-Za-z0-9_-]+)@/`, falling back to postgres. The header is built in two places
(`extension.ts:639`, `browseCommands.ts:163-167`) with different prefixes, so a display string
is load-bearing for SQL quoting.

Approach: add `dialect?: SqlDialect` to `StateMessage` (`messages.ts:20-27`). `ResultsPanel`
already knows the live dialect — `this.saveContext?.getDriver()` is used at `:1046` and `:1183`
— so every `state` post fills it from there, with no `extension.ts` or `browseCommands.ts`
change. There are **11** `type:"state"` post sites in `resultsPanel.ts`
(`:223,385,436,453,505,923,1205,1283,1356,1384,1392` — the last is the else-branch of the try
at :1384); the executor routes them through one private
helper instead of editing each literal.
PLAN REVISION (plan-review round 1): the original count of ten omitted `:1392`. Executors MUST
audit live code rather than trust these line numbers — the grep count is authoritative.

File-ownership: those post sites live in `resultsPanel.ts`, TASK-004's wave-1 file. TASK-007
depends on TASK-004 and becomes the later owner in a different wave — permitted; the rule bans
same-wave sharing only.

Webview side: `detectDialectFromHeader` stays as the fallback for a `state` without `dialect`
(older host, and the bundle tests that hand-build headers), but the typed field wins.

Minors folded in: `orderByFromColumnState` (`:2219-2222`) resolves `spec.headerName`, so
`SELECT id, id` emits `ORDER BY "id", "id"` and the de-duplicated `field` (`id__2`) is
discarded — fix by emitting the positional ordinal when two specs share a `headerName`. Add
`hiddenColumns: string[]` to the `readExportInput` return type (`:2983-2993`) — the value is
already computed at `:3031` and consumed at `:3065`/`:3089`; only the declared type omits it.
Delete the dead `void received;` / `void root;` at `webviewExport.test.ts:369,392`.

### §3.8 TASK-008 — case-18 flake root cause (item 8)

`webviewServerSort.test.ts` still uses the per-`it` `loadBundle()` pattern that cycle X's
TASK-003 removed from `resultsGridModelNull.test.ts`: every `it` re-evaluates the bundle
(`:98`) and installs another `window` message listener, so N stale handlers and timer closures
race the 150 ms filter debounce. Case 18 at `:557` is where it surfaces (3/3 full-suite runs
failed there; 2/6 isolated). Fix: apply the same single-evaluation suite lifecycle that
TASK-003 proved, plus bounded observable waits instead of the fixed `setTimeout(250)` at `:554`.

Test-only file, zero production files ⇒ zero collisions ⇒ wave 1.

### §3.9 Recorded decision — pg metadata vs manual-commit window stays queued

TASK-001 removes the blocker, but the fix itself is: while `this.transaction` is open, every
`PostgresAdapter.query()` (`postgres.ts:653-660`, `this.pool.query`) can block on the `max: 1`
pool or read outside the transaction's snapshot. Correcting it means threading the pinned
client through ~11 metadata call sites
(`:410,420,434,448,492,529,535,564,596,631,637`). That is a task of its own size, it would
necessarily depend on TASK-001, and it shares no test surface with anything else this cycle.
Queued rather than crammed in. INDEX.md keeps the entry with "blocked on C1" replaced by
"unblocked — C1 shipped in Cycle Y TASK-001".

### §3.10 Ambiguity resolutions (no questions were asked; choices recorded)

- **Item 5 split.** `inferColumns` and its webview call site could have been one task, but that
  would make TASK-003 an owner of `webview/main.ts` and force it out of wave 1. Chosen: split —
  the optional parameter lands inert in wave 1, TASK-007 wires it.
- **Item 1 module boundary.** Keyset composition could extend `queryComposer.ts`. Chosen: a new
  `src/ui/keysetPaging.ts`, so TASK-004 and TASK-005 are file-disjoint and both run in wave 1.
- **Item 4 sequencing.** Could have been two tasks (host half / webview half). Chosen: one task
  in the last wave — splitting would put the webview half behind TASK-007 anyway, and the
  truncated/error note is meaningless without the scoped query that produces it.

## §4 Test Plan

Kind vocabulary: *happy*, *edge-boundary*, *edge-dialect*, *edge-ordering*, *edge-failure*,
*edge-empty*, *regression*. Each task's own table repeats its rows with fixtures.

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | T1 form round-trip | Submitting with the manual-commit box checked calls `onSave` with `manualCommit: true`; the add path builds a `ConnectionConfig` carrying `manualCommit: true`. |
| edge-empty | T1 unchecked default | Add mode with the box untouched yields `manualCommit: false` — never `undefined`. |
| regression | T1 edit prefill | `init` with `existing.manualCommit === true` renders the box checked; absent renders unchecked; the existing full-SSL submit assertion still passes. |
| happy | T2 atomic batch | A 3-statement MySQL batch runs on ONE connection: call log `beginTransaction, q1, q2, q3, commit, release`. |
| edge-failure | T2 mid-batch failure | Statement 2 throwing yields `beginTransaction, q1, rollback, release`, the error rethrown, `commit` never called. |
| regression | T2 single SELECT untouched | A single `SELECT` with no `;` still returns `{results: [], batched}` and never calls `beginTransaction`. |
| edge-boundary | T2 pool never used directly | `pool.query` is never reached in the multi-statement arm (the mock throws if it is). |
| happy | T3 declared type wins | `inferColumns(["a"], [["123"]], {a:"varchar"})` → `kind:"string"`, no `alignRight`. |
| edge-empty | T3 all-NULL column | `inferColumns(["a"], [[null],[null]], {a:"integer"})` → `kind:"number"`, `alignRight:true`. |
| regression | T3 no types = today | Omitting the third argument reproduces existing kind/field/de-dup output exactly, including `name__2` suffixing. |
| edge-boundary | T3 unknown type falls back | Declared `"geometry"` samples as before. |
| happy | T4 keyset page 2 | With a total ORDER BY and a supplied last-row key, the composed SQL contains no `OFFSET` and carries the keyset predicate + `LIMIT n`. |
| edge-dialect | T4 mssql keyset | The same request under mssql emits `OFFSET…FETCH`-free keyset SQL with an OR-of-ANDs predicate (no row-value constructor). |
| edge-boundary | T4 page 0 unchanged | Offset 0 with no key composes byte-identically to today's `buildPagedQueryTerms` output. |
| edge-failure | T4 non-browse statement | A DISTINCT/aggregate statement gets no projected PK and no keyset — falls back to today's OFFSET SQL. |
| regression | T4 manualStatementIndex reset | A `render()` between opening a manual window and Commit leaves `manualStatementIndex === null`; the Commit runs no stray `runSql`. |
| regression | T4 committed-save refresh failure | A refresh that throws after a successful commit posts `saveResult {ok:true, warnings:[…]}` and does not reject. |
| happy | T5 NULLS on mysql | `buildOrderByClause([{column:"a",direction:"ASC",nulls:"LAST"}], "mysql")` = `` `a` IS NULL ASC, `a` ASC ``. |
| edge-dialect | T5 NULLS on mssql | Same term under mssql = `CASE WHEN [a] IS NULL THEN 1 ELSE 0 END ASC, [a] ASC`. |
| edge-boundary | T5 FIRST inverts the key | `nulls:"FIRST"` flips the sort-key direction to `DESC` on mysql and mssql; postgres still emits native `NULLS FIRST`. |
| regression | T5 parse no longer rejects | `parseOrderBy("a NULLS LAST","mysql")` returns `{ok:true}`; the two rejection assertions are rewritten, not deleted. |
| happy | T6 DISTINCT scoped | With a filter active on column `b`, the DISTINCT query for `a` carries a WHERE including `b`'s predicate. |
| edge-boundary | T6 own filter excluded | The DISTINCT query for `a` never includes `a`'s own filter predicate. |
| edge-failure | T6 error surfaced | A reply carrying `error` renders the message in `.vsdb-setfilter-status` instead of being dropped. |
| edge-boundary | T6 truncated note | A reply with `truncated:true` renders a "first 1000" note alongside the count. |
| happy | T7 typed dialect | Every `state` post carries `dialect` equal to `saveContext.getDriver()`. |
| edge-empty | T7 no connection | With `getDriver()` returning null, `dialect` is omitted and the webview falls back to header parsing. |
| edge-boundary | T7 duplicate column names | `SELECT id, id` sorted on the second column posts a positional ORDER BY, not `"id", "id"`. |
| regression | T7 export input type | `readExportInput()` returns `hiddenColumns` and type-checks; the sql-where export output is unchanged. |
| happy | T8 case 18 deterministic | `webviewServerSort.test.ts` passes 5 shuffled single-thread seeds. |
| edge-ordering | T8 no stale listeners | The bundle is evaluated once for the suite; one `window` message listener. |
| regression | T8 whole file green | Every existing case in the file still passes with its intent unchanged. |

## §5 Verification

Project reality, verified against `package.json`: scripts are `compile` (`node esbuild.js`),
`test` (`vitest run`), `test:integration`, `typecheck` (`tsc --noEmit`), `package`.
**There is no lint script in this repo** — `typecheck` is the only static gate and it is
mandatory in every task. `RULES.md`'s generic `yarn test:release-core` floor does not exist
here and must not be copied into any task; this repo uses **npm**.

Per task:

```bash
npm run compile                  # REQUIRED before any test that loads dist/*.js
npx vitest run <the task's test files>
npm run typecheck
```

Cycle-close (orchestrator, after the last wave):

```bash
npm run compile
npx vitest run
npm run typecheck
```

Baseline to preserve: **1552 passed / 2 skipped / 0 failed**. Integration tests
(`*.integration.test.ts`) are excluded by `vitest.config.ts` and are NOT part of any task's
verification — they need live databases.

## §6 Acceptance

- [ ] The connection form has a manual-commit toggle; a connection saved with it enabled makes
      the existing Commit/Rollback toolbar reachable. (TASK-001)
- [ ] A failing MySQL multi-statement batch commits nothing; the all-or-nothing contract is
      documented in `README.md`. (TASK-002)
- [ ] A declared server type overrides sampled inference in `inferColumns`; omitting types is
      byte-identical to today. (TASK-003)
- [ ] Deep pages compose without `OFFSET` when a total order and a page key exist; a
      non-browse statement still falls back safely and DISTINCT/aggregate queries are not
      rewritten. (TASK-004)
- [ ] `manualStatementIndex` cannot survive a `render()`; a post-commit refresh failure never
      rejects out of `handleMessage`. (TASK-004)
- [ ] `NULLS FIRST/LAST` renders on all three dialects; the two rejection tests are rewritten
      to assert emulation. (TASK-005)
- [ ] The DISTINCT dropdown is scoped to the active WHERE excluding the column's own filter and
      surfaces both truncation and errors in its footer. (TASK-006)
- [ ] `StateMessage` carries a typed `dialect`, with header parsing left only as a fallback;
      duplicate-name sorts emit a positional ORDER BY; `readExportInput` declares
      `hiddenColumns`. (TASK-007)
- [ ] `webviewServerSort.test.ts` passes 5 shuffled seeds with a single bundle evaluation.
      (TASK-008)
- [ ] `npx vitest run` reports ≥1552 passed and 0 failed; `npm run typecheck` exits 0.
- [ ] Every task's reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## §7 Global Constraints

Every `TASK-xxx.md` inherits this section by reference; it is not repeated per task.

- Package manager is **npm**, never yarn. Tests run as `npx vitest run <files>`.
- **Never `rm -rf`** (hook-blocked). Use `rm -f` plus `rmdir`.
- `npm run compile` MUST precede any test that reads `dist/*.js` (`webview*.test.ts`,
  `*Bundle.test.ts`, and the grid-model tests that eval the bundle). A stale bundle was the
  root cause of multiple Cycle X flakes.
- `npm run typecheck` must exit 0 in every task. No lint script exists.
- Baseline 1552 passed / 2 skipped / 0 failed must not regress.
- Every SQL-composing change must be correct on **all three dialects** (postgres, mysql, mssql)
  with a per-dialect assertion.
- Identifiers reach SQL only through `quoteIdent`; values only through typed literals. No
  string interpolation of user input.
- Reserved subquery aliases must not collide: `vsdb_page`, `vsdb_sort`, `vsdb_sub`,
  `vsdb_distinct`. A new wrapper needs a new `vsdb_*` alias.
- Postgres pool is `max: 1`; MySQL is `connectionLimit: 1`. Any query issued while a cursor or
  transaction is open must reuse the pinned handle or close the cursor first.
- Tasks in the same wave must not modify the same file (§2 collision map is authoritative).
- Executor is `bao-sonnet`; reviewer is `bao-opus`. They must not be the same instance.
- TDD: the RED assertion is written and observed failing before the fix.

## Planner Self-Audit

Checklist: 12/12 pass

1. **§6 → task trace.** Every acceptance line names its task; all eight tasks appear.
2. **Task → §1/§6 trace.** Every task maps to one of the eight queued items; no task exists
   that §1 does not ask for.
3. **Delivery of §1's success.** All eight items are tasked; the ninth queued item (pg
   metadata) is explicitly re-queued with a reason, which §1 permits.
4. **Unhappy paths.** Covered: mid-batch failure (T2), refresh-after-commit failure (T4),
   DISTINCT query error (T6), no active connection (T7), non-browse statement shape (T4),
   all-NULL column (T3).
5. **Target paths verified.** Every existing path was confirmed by grep/ls in this session.
   `src/ui/keysetPaging.ts` is the only new file and is marked `(new)` in TASK-004.
6. **Verification commands real.** `compile`, `test`, `typecheck` confirmed in `package.json`;
   the absent lint script is stated rather than silently omitted; `yarn test:release-core` is
   explicitly ruled out.
7. **Same-wave file sharing.** Wave 1 = TASK-001 (`connectionForm*`, `extension.ts`), TASK-002
   (`mysql.ts`, `README.md`), TASK-003 (`resultsGridModel.ts`), TASK-004 (`resultsPanel.ts`,
   new `keysetPaging.ts`), TASK-005 (`queryComposer.ts`), TASK-008 (one test file) — pairwise
   disjoint. Wave 2 = TASK-007 alone. Wave 3 = TASK-006 alone.
8. **No dependency on an uncreated symbol.** TASK-007 consumes `inferColumns`' optional third
   parameter (TASK-003, wave 1) and adds its own `state`-post helper; TASK-006 adds
   `whereByStatement` itself into a file TASK-004 has already released.
9. **Edge-kind diversity.** Every task carries ≥2 edge cases of genuinely different kinds
   (dialect vs boundary vs failure vs ordering vs empty) — checked per task, not per cycle.
10. **Concrete expectations.** Every row states a value, a call log, or an exact SQL fragment.
    No "works correctly".
11. **Regression tests.** TASK-002, TASK-004, TASK-005, TASK-007, TASK-008 each carry a
    regression case that is RED against today's code.
12. **Empty-implementation check.** No listed case passes against a no-op: each pins a new
    output string, a new call order, or an absence that does not hold today.

Fixed during audit:
- Moved item 5's webview wiring out of TASK-003 into TASK-007 — as first drafted TASK-003 owned
  `webview/main.ts` and collided with TASK-007 in wave 1.
- Moved item 1's composition into a new `src/ui/keysetPaging.ts` — as first drafted it extended
  `queryComposer.ts` and collided with TASK-005 in wave 1.
- Gave `resultsPanelOrderBy.test.ts` exclusively to TASK-005 after noticing TASK-004 would
  otherwise edit the same test file.
- Replaced "wire `dialect` in `extension.ts`" with "fill it in `resultsPanel`'s state posts",
  removing a second owner of `src/extension.ts`.
- Archived the Cycle X plan and its eight task files to `docs/AI_HANDOFF/archive/cycle-X-*`
  before overwriting `PLAN.md`, matching the archive convention for cycles I-V.

Known gaps:
- `src/config/types.ts` could not be read by this planner (directory permission denied); only
  the grep hit `manualCommit?: boolean` at `:44` is confirmed. TASK-001's executor must open
  the file and confirm the surrounding `ConnectionConfig` shape before writing the literals.
  Recorded in TASK-001 §Discussion as a stated unknown rather than guessed.
- The keyset predicate's exact SQL text (OR-of-ANDs rendering per dialect) is specified by
  shape and by test expectation, not by a literal string — the executor writes the RED test
  first and settles the exact rendering there. TASK-004 is the largest task in this cycle and
  is the most likely `needs_breakdown` candidate at the Task Gate if the browse-shape rule for
  PK projection turns out not to hold for a real statement shape.
- MSSQL has no adapter-level `beginTransaction`, so M2's atomicity contract covers MySQL and
  Postgres only. Not tasked, not queued — no finding reported it.

## Planner Report
PLANNER_MODEL: bao-opus
PLAN_REVIEW: Approved by bao-opus (round 1: Issues Found — 3 findings applied: state-post count 10→11 with corrected list + live-audit note, signature sketch pinned in TASK-004; round 2: fixes verified, Approved)

## Plan Review Log

(Round 1 verdict was returned by the reviewer agent as `Issues Found` with 3 numbered findings;
its inline append was not persisted, so its content is summarized in the Planner Report above.
All 3 findings were applied before round 2.)

### Round 2 — 2026-08-26 · bao-opus
Status: Approved

COMPLETENESS:
  - Fix 1 verified: PLAN §3.7 now says **11** state-post sites with the corrected list `(:223,385,436,453,505,923,1205,1283,1356,1384,1392)` and includes the "PLAN REVISION (plan-review round 1)" note instructing executors to audit live code.
  - Fix 2 verified: TASK-004 Interfaces section pins a two-function public API sketch (`assertBrowseShape` returning browse-shape info or null; `composeKeysetQuery` with byte-identical page-0 guarantee and fallback semantics).
  - Round 1 findings were applied directly to the document; no prior log entry existed here.

CONSISTENCY:
  - The TASK-004 interface sketch is consistent with PLAN §3.5 (browse-shape gate, keyset predicate, page-0 identity, fallback), PLAN §4 tests (T4 happy/edge-dialect/edge-boundary/edge-failure map to the two functions), and TASK-004 Discussion §5 resolution.
  - No new cross-file collision introduced by either fix.

CLARITY:
  - The revision note in §3.7 is unambiguous: "executors MUST audit live code rather than trust these line numbers — the grep count is authoritative."
  - The interface sketch specifies exact signatures with return types, eliminating ambiguity for the executor.

SCOPE:
  - Both fixes are targeted corrections that do not expand scope or introduce new items.

YAGNI:
  - No unrequested additions.

NOTES: Both Round 1 fixes verified clean. No new blocking issues introduced. Plan is approved for execution.
