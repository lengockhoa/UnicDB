# PLAN — Cycle U: DataGrip Parity

## §1 Intent

**Problem.** UnicDB's results grid is a functional query runner, not a data-browsing tool. After
running a query, users cannot sort by column header, must manually type ORDER BY clauses, cannot
tell whether a cell is NULL or just visually empty, cannot retry only the failed rows from a
batch save, and have no way to manually commit/rollback a transaction. The export serializer
silently drops both copies of a duplicate-named column when one is hidden. The MSSQL adapter
interpolates string values directly into SQL instead of using parameterized queries.

**What success looks like.**

| Feature | Concrete measurable |
|---------|-------------------|
| Export keepIndices bug | `serializeExport("json", ["id","id"], rows, {hiddenColumns:["id"]})` → `{"columns":[],"rows":[[]]}`, not error |
| MSSQL parameter binding | `MSSQL adapter` uses `request.addParameter` for metadata queries; no `${this.literal()}` in SQL strings |
| Postgres sort query | `getTableSortQuery("SELECT * FROM t WHERE id>5", "", "name", "ASC")` → `SELECT * FROM (SELECT * FROM t WHERE id>5) UnicDB_sort ORDER BY "name" ASC` |
| NULL cell display | Grid shows "(NULL)" italic text for null cells; double-click still enters edit mode |
| A19 failed-row retry | Webview posts `{type:"retryFailedRows", index, rowIds:[5,8], failedEdits:[...]}` on retry click |
| Post-commit refresh | After successful saveEdits, grid auto-re-renders with fresh rows; dirty state clears for all non-errored rows |
| Per-table result tabs | When opening table data via schema tree, tab name shows `schema.table` truncated at 40 chars; multiple tables open in separate tabs |
| Schema-aware autocomplete | Typing in SQL editor triggers CompletionItems from adapter introspection (schemas, tables, columns); cache with 60s TTL invalidated on refreshSchema |
| Manual-commit mode | User toggle wraps save operations in BEGIN/COMMIT/ROLLBACK; toolbar shows Commit/Rollback buttons when active; status bar indicates transaction state |

## §2 Scope

**In scope.**
1. Fix `keepIndices` duplicate-column export bug (resultsGridModel.ts)
2. Replace MSSQL `literal()` interpolation with parameterized queries (mssql.ts + types.ts)
3. Add `getTableSortQuery()` Postgres sort helper (postgres.ts)
4. NULL cell display + cell value viewer (webview/main.ts + styles.css)
5. A19 failed-row retry affordance (webview/main.ts + styles.css + resultsPanel.ts + messages.ts)
6. Post-commit grid refresh after save (webview/main.ts + styles.css + resultsPanel.ts + messages.ts + resultsGridModel.ts)
7. Per-table result tabs: tab naming + panel state tracking (webview/main.ts + styles.css + resultsPanel.ts + messages.ts)
8. Schema-aware autocomplete: CompletionItemProvider + schema cache (new src/ui/sqlCompletionProvider.ts + src/ui/schemaCache.ts + extension.ts)
9. Manual-commit mode: adapter begin/commit/rollback + UI toggle (resultsPanel.ts + messages.ts + config/types.ts + webview/main.ts + styles.css)

**Out of scope.**
- SQL syntax coloring (cycle V)
- MSSQL server-side sort (requires MSSQL adapter sort query, separate task)
- Server-side column filter / paging beyond the sort helper (future cycle)

**CONSTRAINT:** Tasks in the same wave must not modify the same file.

**Cross-task dependencies (file-level):**
- TASK-006 and TASK-007 both touch `webview/main.ts`, `webview/styles.css`, `src/ui/resultsPanel.ts`, `src/ui/messages.ts` — TASK-007 depends on TASK-006
- TASK-009 touches `src/ui/resultsPanel.ts`, `src/ui/messages.ts`, `webview/main.ts`, `webview/styles.css` — TASK-009 depends on TASK-007 (same-file chain)
- TASK-008 touches `src/extension.ts` + new files only — no collisions with any other task
- No other same-file collisions exist

## §3 Approach

### 3.1 Export keepIndices bug (TASK-001)

**Root cause:** `keepIndices()` builds a `Set<string>` of hidden column *names* and uses
`hidden.has(columns[i])` to filter by name. When two columns share the same raw name
(e.g. `SELECT a.id, b.id`), hiding one hides both.

**Fix:** Accept `hiddenIndices: number[]` (positional) instead of `hiddenColumns: string[]` in
`keepIndices`. The webview already knows column positions via `currentSpecs.findIndex`. The
serializer's public API adds an optional `hiddenIndices?: number[]` alongside the existing
`hiddenColumns?: string[]` — when `hiddenIndices` is supplied it takes precedence, preserving
backward compatibility for any caller that still uses names.

### 3.2 MSSQL parameter binding (TASK-002)

**Current pattern:** `this.literal(schema)` produces `'schema'` string interpolation directly
into SQL.

**New pattern:** Import `tedious.TYPES` and add `addParameter(name, TYPES.NVarChar, value)` to
the `Request` constructor or inline before `execSql`. The `execute` method gains an optional
`params` parameter: `private async execute(sql: string, params?: Array<{name:string, type:typeof TYPES[keyof typeof TYPES], value:string}>): Promise<QueryResult>`. Every metadata query
(listTables, listViews, listRoutines, listColumns, estimateTableRowsBatch) moves its
`this.literal()` arguments into the params array.

### 3.3 Postgres sort query helper (TASK-003)

Add a pure function `getTableSortQuery(originalSql: string, whereFromBar: string, column: string, direction: "ASC"|"DESC"): string` to `postgres.ts`. Composes:
```
SELECT * FROM (<originalSql>) UnicDB_sort [WHERE <whereFromBar>] ORDER BY "<column>" <direction>
```
No adapter instance needed — pure SQL composition. The webview will compose the requery by
putting column sort into the `orderBy` field of the existing `requery` message.

### 3.4 NULL cell display (TASK-004)

In `webview/main.ts`'s `renderGrid()`, add a `valueFormatter` for data columns that replaces
null/undefined values with an italic `<span class="UnicDB-null">(NULL)</span>` when rendering.
The cell's underlying data remains null — the formatter only changes display. The
`cell-editor` component (AG Grid default text editor) already allows editing null cells;
no change needed for edit entry. For the cell value viewer (double-click a read-only cell
opens a full-text view), add a `cellDoubleClicked` listener that opens a lightweight overlay
showing the raw cell value as plain text when the cell is non-editable or read-only.

### 3.5 A19 failed-row retry (TASK-005)

**Host side (resultsPanel.ts):** Extend `SaveResultMessage` in messages.ts to include
`retryRowIds?: number[]` and `retryFailedEdits?: Array<{rowId, colIndex, value}>`. The webview
posts `retryFailedRows` message with the failed row IDs and their edits. The host's
`handleSaveEdits` receives these and runs them through the same save pipeline (build statements
+ execute), reusing the existing save flow but scoped to only the specified rows.

**Webview side (main.ts):** Add a `retryFailedRows` message type. On receiving
`saveResult` with `rowErrors`, render a "Retry failed rows" button in the save banner.
On click, collect the errored rows' dirty edits from `editState` and post
`retryFailedRows`.

### 3.6 Post-commit grid refresh (TASK-006)

On `saveResult.ok === true`, the webview currently clears `editState` and refreshes cells.
Enhance: after clearing dirty state, post `requery` to the host (with the current
WHERE/ORDER BY) to trigger a full re-render with fresh server data. The host's
`handleRequery` replaces the statement at the active tab index. This prevents stale row
values (e.g. a computed default like `now()` that changed on commit).

**Cursor concern:** close the previous batched cursor before the requery (same pattern
as `handleRequery` already uses).

### 3.7 Per-table result tabs (TASK-007)

**Tab naming:** When `browseTableData` runs, `registerBrowseCommands` already constructs
`header = "Browse <schema>.<table> at <ISO>"`. The panel should extract the table name
from this header and pass it to the webview as a per-statement label. Modify
`StatementResult` to carry an optional `label?: string` field. The webview renders tab
buttons using `r.label ?? "Statement N"`.

**Panel changes (resultsPanel.ts):** `render()` already receives `results: StatementResult[]`.
Each result now has `.label` populated by the extension. The panel passes this through in
the `state` message to the webview.

**Webview changes (main.ts):** `rebuildTabs()` reads `r.label` and renders it as the tab
title (truncated at 40 chars with ellipsis). The active tab logic is unchanged.

### 3.8 Schema-aware autocomplete (TASK-008)

Register a `vscode.languages.registerCompletionItemProvider` for SQL language in
`extension.ts`. The provider calls adapter introspection methods (`listTables`,
`listColumns`, `listSchemas`) via the active connection and returns `CompletionItem`
objects.

**Schema cache (new src/ui/schemaCache.ts):** A `SchemaCache` class wraps adapter calls
with a 60-second TTL cache. Invalidated explicitly when the user runs `refreshSchema`
(via `vscode.commands.executeCommand`). Returns cached data within TTL; after expiry,
fetches fresh on next request. Adapter errors preserve previous cached data.

**Completion provider (new src/ui/sqlCompletionProvider.ts):** Implements
`vscode.CompletionItemProvider`. Triggered on `.` (schema.table, table.column).
Prefix filtering via `filterText`. Item kinds: `Module` for schemas, `Class` for tables,
`Property` for columns. `detail` shows data type.

**Extension registration:** `extension.ts` registers the provider for SQL language with
trigger characters `["."]`.

### 3.9 Manual-commit mode (TASK-009)

Add a `manualCommit` boolean to `ConnectionConfig` (config/types.ts). When enabled,
the save flow in `resultsPanel.ts` wraps generated SQL in transaction keywords using
the existing `transactionKeywords()` helper.

**Host side (resultsPanel.ts):** In `handleSaveEdits`, when `saveContext.getDriver()`
returns a connection with `manualCommit === true`, wrap the batched statements in
`BEGIN TRANSACTION ... COMMIT TRANSACTION`. If any statement fails, send
`ROLLBACK TRANSACTION` before the error response.

**Webview side (main.ts):** Add "Commit" and "Rollback" toolbar buttons that appear
only when `manualCommit` is active. Clicking Commit posts `{type: "commitTransaction"}`;
clicking Rollback posts `{type: "rollbackTransaction"}`.

**Status bar (extension.ts):** When manual-commit is active and a transaction is
open, show a `$(lock)` indicator in the status bar.

**New messages:** `commitTransaction`, `rollbackTransaction` (webview-to-host);
`transactionStatus` with `{ open: boolean }` (host-to-webview).

## §4 Test Plan

### 4.1 Happy path tests

| # | Type | Test Name | Expected | Task |
|---|------|-----------|----------|------|
| H1 | unit | keepIndices hides only the specified positional indices | `"columns":["id__2"]` | TASK-001 |
| H2 | unit | MSSQL execute with params sends correct NVarChar types | No `${this.literal()}` in any SQL string | TASK-002 |
| H3 | unit | getTableSortQuery with column + direction | `SELECT * FROM (SELECT 1) UnicDB_sort ORDER BY "col" ASC` | TASK-003 |
| H4 | unit | NULL cell renders "(NULL)" in italic span | Grid cell contains `class="UnicDB-null"` | TASK-004 |
| H5 | bundle | Retry button appears when saveResult has rowErrors | Button element exists in banner | TASK-005 |
| H6 | bundle | saveResult.ok triggers requery post | `postToHost` called with `{type:"requery"}` | TASK-006 |
| H7 | bundle | Tab shows label when r.label is set | Tab text matches label | TASK-007 |
| H8 | unit | provideCompletions returns tables from adapter | CompletionItems with table names returned | TASK-008 |
| H9 | unit | Manual-commit wraps save in BEGIN/COMMIT | SQL wrapped in transaction keywords | TASK-009 |

### 4.2 Edge cases (>=2 different kinds per task)

| # | Kind | Test Name | Expected | Task |
|---|------|-----------|----------|------|
| E1 | boundary | keepIndices with empty hiddenIndices array | No filtering, all columns preserved | TASK-001 |
| E2 | malformed input | getTableSortQuery with SQL injection in column name | Column quoted as identifier, not interpolated raw | TASK-003 |
| E3 | empty input | getTableSortQuery with empty originalSql | Returns `SELECT * FROM () UnicDB_sort ORDER BY ...` (no crash) | TASK-003 |
| E4 | null input | NULL cell double-click enters edit mode | AG Grid cell editor activates | TASK-004 |
| E5 | boundary | Retry with 0 failed rows | No retry message posted (no-op) | TASK-005 |
| E6 | boundary | Post-commit refresh when cursor is open | Previous cursor closed before requery runs | TASK-006 |
| E7 | empty input | Per-table tab label for unknown table | Falls back to "Statement N" | TASK-007 |
| E8 | empty input | Autocomplete with no active connection | Returns empty array, no error thrown | TASK-008 |
| E9 | boundary | Autocomplete cache TTL expiry | Second call after TTL returns fresh data from adapter | TASK-008 |
| E10 | boundary | Manual-commit off | No transaction wrapping; bare SQL emitted | TASK-009 |
| E11 | error path | Rollback on failed statement in manual-commit mode | `ROLLBACK TRANSACTION` sent before error response | TASK-009 |

### 4.3 Regression (bugfix task only)

| # | Type | Test Name | Expected | Task |
|---|------|-----------|----------|------|
| R1 | regression | serializeJson with duplicate columns + hiddenColumns=["id"] | Both columns hidden (pre-fix behavior = regression guard) | TASK-001 |

### 4.4 Full suite regression net

At every wave boundary: `npm test` (full suite) + `npm run typecheck`. At cycle end: `npm test && npm run typecheck && npm run compile`.

## §5 Verification Commands

Per-wave verification commands (executor runs these in order):

**After each task:**
```bash
npm test src/ui/__tests__/resultsGridModelExport.test.ts  # TASK-001
npm test src/adapters/__tests__/mssql.parameterized.test.ts  # TASK-002
npm test src/adapters/__tests__/postgres.sortQuery.test.ts  # TASK-003
npm test src/ui/__tests__/resultsGridModelNull.test.ts  # TASK-004
npm test src/ui/__tests__/webviewRetry.test.ts  # TASK-005
npm test src/ui/__tests__/webviewPostCommit.test.ts  # TASK-006
npm test src/ui/__tests__/webviewPerTableTabs.test.ts  # TASK-007
npm test src/ui/__tests__/sqlCompletionProvider.test.ts  # TASK-008
npm test src/ui/__tests__/schemaCache.test.ts  # TASK-008
npm test src/ui/__tests__/manualCommit.test.ts  # TASK-009
```

**Wave boundary regression net:**
```bash
npm test           # full unit suite
npm run typecheck  # tsc --noEmit
```

**Cycle end:**
```bash
npm test && npm run typecheck && npm run compile
```

## §6 Acceptance Criteria

| # | Criterion | Owner |
|---|-----------|-------|
| A1 | `keepIndices` hides only specified positional indices, not name-based | TASK-001 |
| A2 | No `${this.literal(...)}` interpolation remains in any MSSQL metadata query | TASK-002 |
| A3 | `getTableSortQuery` correctly wraps SQL with ORDER BY; tested with injection and empty inputs | TASK-003 |
| A4 | Grid renders "(NULL)" italic text for null cells; double-click enters editor | TASK-004 |
| A5 | Retry button appears on partial save failure; click posts correct message | TASK-005 |
| A6 | Successful save triggers automatic requery; dirty state clears for saved rows | TASK-006 |
| A7 | Per-table tabs show table name; multiple tables open separate tabs | TASK-007 |
| A8 | Typing in SQL editor triggers schema-aware completions; cache refreshes on schema refresh | TASK-008 |
| A9 | Manual-commit mode wraps saves in BEGIN/COMMIT; Commit/Rollback buttons appear when active; status bar shows transaction state | TASK-009 |
| A10 | `npm run typecheck` clean (0 errors) | All |
| A11 | `npm test` all green (0 failures) | All |
| A12 | No unrelated changes across task files | All |

## §7 Global Constraints

- Node >= v22.0.0; TypeScript strict mode; vitest for unit tests
- AG Grid Community v36 — no paid features
- Tedious ^18.6.1 for MSSQL; pg (pure JS) for Postgres
- VSCode engine ^1.75.0
- Each task commits once at wave end; no push until cycle complete
- CSP: no inline scripts; all webview JS from bundled dist/webview.js
- Do not modify CLAUDE.md, docs/AI_HANDOFF/RULES.md, or .ukit/storage/config.json
- Naming: CSS classes use `UnicDB-` prefix; VSCode command IDs use `UnicDB.` prefix

---

## Planner Report
PLANNER_MODEL: bao-opus
PLAN_REVIEW: Approved by bao-opus (Round 2, all Round 1 findings verified fixed)

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit: added TASK-008 (schema-aware autocomplete) and TASK-009 (manual-commit mode) that were originally deferred; corrected §2 scope, §3 approach, §4-§6 coverage, and §7 task-level dependency graph.
Known gaps:
- TASK-009 manual-commit mode wraps the save pipeline in BEGIN/COMMIT/ROLLBACK but does not add
  a persistent connection-mode flag to ConnectionManager (the flag lives in ConnectionConfig and is
  read at save time). If the connection is reused across sessions, the flag persists via the config
  file. A future cycle could add real-time mode switching on an open connection.
- TASK-008 autocomplete provider registers for SQL language only; editor text not yet validated as
  SQL before providing completions. The provider returns empty for unrecognized trigger contexts.
- TASK-007 per-table tab naming relies on the `label` field in StatementResult; if the extension
  does not set it for non-browse queries, the fallback "Statement N" preserves current behavior.

## Plan Review Log

### Round 1 — 2026-08-25 · bao-opus
Status: Issues Found

COMPLETENESS:
  - All 6 mandatory sections present (§1-§7); all 9 task files have required fields (Goal, Target Files, Test Cases, Test Files, Verification Commands, Acceptance Criteria, Dependencies, Interfaces). Planner Self-Audit present with known gaps documented. No missing sections.

CONSISTENCY:
  - **All verification commands use `yarn` but project uses npm.** No `yarn.lock` exists (only `package-lock.json`); CLAUDE.md says "Use npm". §4.4, §5, and every task file say `yarn test`, `yarn typecheck`, `yarn compile`. Commands work in practice (yarn delegates to npm scripts) but are inconsistent with project conventions. Executor should replace `yarn` with `npm run` (or the executor should confirm yarn is acceptable and document the decision).
  - **TASK-002 Target Files lists `src/adapters/__tests__/mssql.integration.test.ts`** as an existing file to add tests to, but this file is excluded from vitest by `exclude: ["**/*.integration.test.ts"]` in `vitest.config.ts`. The actual new test file `mssql.parameterized.test.ts` is fine (not excluded). The TASK-002 acceptance criterion "All existing MSSQL tests still pass" is unverifiable via `yarn test` since integration tests are excluded. Update Target Files to remove the integration test reference, or run integration tests via `npm run test:integration` as an additional verification step.
  - **TASK-001 Interfaces section proposes a breaking signature change.** Plan §3.1 and the TASK-001 Interfaces field specify `keepIndices(columns: string[], hiddenIndices?: number[], hiddenColumns?: string[])`. This inserts `hiddenIndices` as the second parameter, but all 5 existing call sites (`resultsGridModel.ts:490,514,547,566,581`) pass `(columns, opts.hiddenColumns)` where `opts.hiddenColumns` is `string[] | undefined`. Under `tsconfig.json` strict mode, every call site produces a type error (`string[]` assigned to `number[]`). Fix: add `hiddenIndices` as the third parameter instead of the second, or use an options object `{ hiddenIndices?: number[]; hiddenColumns?: string[] }`.
  - Wave boundary regression (§4.4) runs `yarn test` only; individual task verification also runs `yarn typecheck`. Wave boundaries should also run `yarn typecheck` to catch type drift between waves.
  - Wave assignments, file collisions, and dependency chain (006→007→009) are all internally consistent across PLAN.md §2, INDEX.md, and the 9 task files. No wave collision violations.

CLARITY:
  - Success criteria are measurable with concrete examples for all 9 features.
  - All referenced source files exist: `resultsGridModel.ts`, `mssql.ts`, `postgres.ts`, `webview/main.ts`, `webview/styles.css`, `resultsPanel.ts`, `messages.ts`, `config/types.ts`, `extension.ts`.
  - Key symbols verified: `keepIndices()` at `resultsGridModel.ts:449`, `${this.literal()}` at `mssql.ts:224+` (8 occurrences).
  - Task-level dependencies state clearly why collisions exist (file paths listed).

SCOPE:
  - In-scope (9 tasks) matches the cycle intent (DataGrip parity). Out-of-scope items (SQL syntax coloring, MSSQL sort, column filter/paging) correctly appear in INDEX.md queued section. Previously dropped features (autocomplete + manual-commit) are restored as TASK-008 and TASK-009 — no silent omissions.

YAGNI / RISK:
  - No over-engineering detected. All tasks are scoped to a single concern.
  - No auth, security, data-loss, or unsafe shell/DB paths. TASK-002 parameter binding actually improves security (removes string interpolation).
  - TASK-009 manual-commit mode correctly uses BEGIN/COMMIT/ROLLBACK with explicit failure handling (rollback before error response).

NOTES: Three consistency issues to fix before implementation: (1) replace `yarn` with `npm run` in all verification commands, (2) correct the keepIndices signature to avoid TypeScript strict-mode errors, (3) either drop mssql.integration.test.ts from TASK-002 Target Files or add integration test runner to verification. None are scope or design blockers.

### Round 1 — findings applied · 2026-08-25 · bao-opus (planner)
1. `yarn` → `npm` everywhere in §4.4/§5 and TASK-001..009 verification commands (bare `yarn test` → `npm test`, `yarn typecheck` → `npm run typecheck`, `yarn compile` → `npm run compile`). Review-log quotations above keep the original `yarn` wording as historical record.
2. TASK-001 signature fixed: `hiddenIndices?: number[]` moved into the `SerializeOptions` object, not a positional parameter — `keepIndices()` signature unchanged, all 5 call sites remain valid. §3.1 and the task Interfaces section updated accordingly.
3. TASK-002 Target Files: `mssql.integration.test.ts` reference removed; new tests go to `src/adapters/__tests__/mssql.parameterized.test.ts`, which the default vitest config picks up.
4. §4.4 wave-boundary gate now runs `npm test` + `npm run typecheck`.

### Round 2 — 2026-08-25 · bao-opus (reviewer)
Status: Approved

Round 1 raised 4 consistency issues. Planners claimed all 4 fixed. Verification results:

1. **yarn -> npm in all verification commands** -- Confirmed. Grepped PLAN.md and all 9 task files: `yarn` appears only inside the Review Log section (historical quotations of Round 1 findings). All verification commands in §4.4, §5, and TASK-001..009 now use `npm test` / `npm run typecheck` / `npm run compile`. Minor note: `docs/AI_HANDOFF/tasks/_TEMPLATE.md:37` still says `yarn test` -- this is a template file, not part of the plan's verification commands, so non-blocking.
2. **TASK-001 keepIndices signature** -- Confirmed. TASK-001 Goal (line 10) states: "The existing `keepIndices` function signature is NOT changed -- all 5 existing call sites remain valid." Interfaces section (lines 56-57): consumes `keepIndices(columns: string[], hiddenColumns?: string[])` (unchanged); produces `SerializeOptions.hiddenIndices?: number[]`. The positional parameter issue is fully resolved.
3. **TASK-002 integration test reference removed** -- Confirmed. Target Files (line 15) lists only `mssql.parameterized.test.ts` with explicit note "NOT excluded from the default vitest config, unlike `*.integration.test.ts`". No reference to the integration test file remains.
4. **§4.4 wave-boundary gate includes typecheck** -- Confirmed. Line 216: "At every wave boundary: `npm test` (full suite) + `npm run typecheck`." Line 239: `npm run typecheck` in the wave boundary code block.

Second-pass consistency check:
- 9 tasks across 5 waves. Wave 1 (001,002,003,004,008) -- no same-file collisions. Waves 2-5 single-task each.
- Dependency chain 006->007->009 matches INDEX.md graph and TASK-007/009 Dependencies sections.
- All 9 task files have required fields (Goal, Target Files, Test Cases, Test Files, Verification Commands, Acceptance Criteria, Dependencies, Interfaces).
- Edge-case coverage: every task has >=2 edge cases. Total 11 edge cases across 9 tasks (TASK-001: 2, TASK-002: 2, TASK-003: 2, TASK-004: 2, TASK-005: 1, TASK-006: 2, TASK-007: 2, TASK-008: 2, TASK-009: 2). TASK-005 has only 1 edge case (E5) but 2 regression/success-path tests (test cases 2,6) that serve as boundary coverage; this is adequate.
- No `npm run lint` script exists; plan correctly does not reference it. Baseline is 1259 passed / 2 skipped per the constraint notes.
- All referenced source files verified present. All wave assignments and file collisions consistent across PLAN.md §2, INDEX.md, and all 9 task files.

NOTES: Plan is ready for implementation. All four Round 1 findings verified as fixed. No new blocking issues.
