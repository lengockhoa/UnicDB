# TASK-007 — Typed state dialect, declared-type wiring, and webview minors

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 items 5, 7, 8, §3.7

## Goal

Replace header-string dialect inference with a typed `StateMessage.dialect`, then use the same
message path to wire TASK-003's declared types into the webview `inferColumns` call. Also fix the
duplicate-name server sort ordinal, declare `hiddenColumns` in `readExportInput`, and remove two
dead test expressions.

BREAKDOWN RESOLVED (orchestrator, post-plan): Discussion option **C+** — typed `dialect` +
minors are unconditional; declared-type plumbing rides on TASK-004's browse-shape provenance.
`ResultsPanel` records per-statement columnTypes ONLY when both `tableByStatement` (parse
provenance) and the TASK-004 browse-gate hold, via the existing optional
`SaveContext.listColumnTypes` (same resolution path as `handleRequery`'s filter lane). That map
is keyed by POSITIONAL index → declared type string to avoid duplicate-name ambiguity, sent as
optional `StateMessage.columnTypes?: Record<string, string>` (keyed by numeric-string ordinal).
The webview converts positional→name once for `inferColumns(columns, rows, types)` (safe:
output columns at that point ARE the table columns under the same gate). Every `state` post in
`resultsPanel.ts` fills `dialect` from `this.saveContext?.getDriver() ?? undefined` through one
private helper; when null/omitted, webview falls back to the legacy header parse unchanged.

## Target Files

- `src/ui/messages.ts` — add typed optional state fields after verifying their exact shared types.
- `src/ui/resultsPanel.ts` — later owner after TASK-004; centralize state posts or update every
  real site to include live dialect and declared-type map.
- `webview/main.ts` — consume typed dialect preferentially, retain legacy header fallback, feed
  declared types to `inferColumns`, fix duplicate-name sort ordinal, and correct
  `readExportInput` return type.
- `src/ui/__tests__/resultsPanel.test.ts` — state protocol output coverage.
- `src/ui/__tests__/resultsGridModelRequery.test.ts` — declared-type state-to-grid behavior.
- `src/ui/__tests__/webviewServerSort.test.ts` — duplicate-name positional sort bundle coverage.
- `src/ui/__tests__/webviewExport.test.ts` — `hiddenColumns` type cleanup and unchanged export
  regression.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Typed dialect controls quoting | A state message `{dialect:"mysql"}` with a non-bare column id posts a requery ORDER BY containing backticks even when `header` is malformed/non-driver text. | Compiled webview bundle; existing server-sort fixture. |
| 2 | edge — empty | Legacy state falls back safely | A state lacking `dialect` continues to infer postgres/mysql/mssql from existing valid headers; a malformed header falls back to current postgres behavior. | Existing `driverHeader` fixture plus malformed header. |
| 3 | happy | Declared varchar reaches inference | State `{columnTypes:{code:"varchar"}}` plus rows `[["123"]]` renders `code` left-aligned/string; a declared integer all-null column is right-aligned/number. | TASK-003's optional third parameter must exist. |
| 4 | edge — ordering | Duplicate headers use positional ORDER BY | State columns `["id","id"]`; sorting second grid field posts a positional ordinal term that identifies column 2, never a second ambiguous quoted `id`. | Compiled webview bundle, current duplicated-field naming fixture. |
| 5 | regression — export | `readExportInput` declares hidden columns | The return annotation includes `hiddenColumns:string[]`; existing sql-where export still posts exactly `WHERE (id=1 AND \`order\`='x')`. | Existing webviewExport mysql fixture. |
| 6 | edge — no active driver | State output omits dialect without connection | `saveContext.getDriver()` returning null produces a state compatible with header fallback rather than an invented dialect. | ResultsPanel host harness. |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts`
- `src/ui/__tests__/resultsGridModelRequery.test.ts`
- `src/ui/__tests__/webviewServerSort.test.ts`
- `src/ui/__tests__/webviewExport.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts src/ui/__tests__/webviewServerSort.test.ts src/ui/__tests__/webviewExport.test.ts
npm run typecheck
```

Compile must precede the webview tests because they evaluate `dist/webview.js`. `package.json`
has no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [x] **Resolved:** option C+ — unconditional typed `dialect` + minors; declared types attached
      positionally ONLY under TASK-004's browse-shape gate via `listColumnTypes`; header parse
      remains the fallback for legacy/missing values. No name-keyed map is ever sent for
      arbitrary output.
- [ ] A typed state dialect is preferred for SQL quoting; header parsing is retained only for
      backwards-compatible messages without it.
- [ ] Declared types reach `inferColumns` without sampled values overriding them.
- [ ] Duplicate output column names are sorted by an unambiguous positional expression.
- [ ] `readExportInput` return type declares its already-returned `hiddenColumns`; dead test
      no-ops are removed without changing expected export text.
- [ ] After Discussion resolution, all listed verification commands exit 0.

## Dependencies

- TASK-003 — produces optional declared-type parameter for `inferColumns`.
- TASK-004 — releases `src/ui/resultsPanel.ts` as later owner.

## Interfaces

- Consumes: `StateMessage { type:"state"; header:string; results:StatementResult[]; busy:boolean }`
  (`src/ui/messages.ts:20-27`), `SaveContext.getDriver(): ConnectionConfig["driver"] | null`
  (`resultsPanel.ts:77`), `inferColumns(columns, rows)` (`resultsGridModel.ts:76`),
  `orderByFromColumnState(api)` (`webview/main.ts:2213`).
- Proposed output (NOT YET APPROVED): `StateMessage.dialect?: "postgres" | "mysql" | "mssql"`
  and a declared-types map keyed by result column name. Exact name/type/source is blocked below.

---

## Discussion

1. **Blocking metadata fact.** `QueryResult` is only
   `{columns:string[]; rows:any[][]; rowCount; commandTag?; durationMs}` (`adapters/types.ts:11-17`).
   It has no declared types. `SaveContext.listColumnTypes(schema, table)` exists only for a
   `tableByStatement` direct table and currently supports `(Blanks)` filtering in
   `handleRequery` (`resultsPanel.ts:1241-1249`). It cannot correctly label arbitrary query
   output, duplicate aliases, joins, or expressions. Sending it as `StateMessage.columnTypes`
   would falsely claim server types for output columns.
2. **Required breakdown decision.** Pick one grounded scope before implementation:
   - **A. Direct-table-only metadata:** only attach a map for parser-proven direct-table browse
     statements, keyed by exact output columns; all other result sets keep sample inference.
     Recommended if TASK-004 resolves direct-browse provenance.
   - **B. Extend adapter QueryResult:** add ordered declared type metadata (`columnTypes` by
     position, not name) to PostgreSQL/MySQL/MSSQL query/cursor results. This is a broad
     three-adapter protocol task and must be separately planned.
   - **C. Defer P2-4 webview plumbing:** deliver typed `dialect` and minors now in a ready task,
     leaving P2-4 queued after TASK-003. This avoids a false type promise.
   Recommendation: **C** unless a direct-browse provenance contract is materialized by
   TASK-004. The current Cycle Y combined task must not ship a name-keyed map that mislabels
   duplicate or computed columns.
3. **State post inventory required.** `resultsPanel.ts` has state posts at least at
   `:223,385,436,453,505,923,1205,1283,1356,1384`. Before refactoring, catalog whether each
   has `saveContext`, whether `getDriver()` can throw, and whether a helper would alter message
   ordering. No unverified global replacement.
4. **Duplicate names need a SQL dialect decision.** SQL ordinal syntax is generally `ORDER BY 2`,
   but its interaction with existing `parseOrderBy` (currently only identifiers) must be added
   and tested on all dialects before claiming this ready. Do not send synthetic `id__2` to the
   host: it is AG Grid-only and not a database column.
5. **Dead expression cleanup.** `void received;` and `void root;` in `webviewExport.test.ts`
   are after their variables were already used. Remove only those two statements; preserve the
   test assertion and fixture lifecycle.

---
