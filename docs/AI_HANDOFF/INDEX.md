# INDEX

Cycle W -- **SERVER-SIDE SORT + DISTINCT FILTER VALUES + DETERMINISTIC PAGING**: real ORDER BY
parser with per-dialect quoting and expression rejection, `(Blanks)` matching empty strings,
PK tiebreaker for gap-free OFFSET paging, server-side DISTINCT values for the set filter, and
AG Grid header-click sort wired to the server. 4 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | ORDER BY parser + dialect clause builder + paging tiebreaker + `(Blanks)` opt-in | approved | - | bao-opus |
| TASK-002 | `buildDistinctValuesQuery`: pure DISTINCT-values SQL builder | approved | - | bao-opus |
| TASK-003 | Webview: server-side sort on header click + distinct-value set filter | changes_requested | - | bao-opus |
| TASK-004 | Host wiring: distinct-values round trip + ORDER BY parser + paging tiebreaker | approved | claude-code/bao-sonnet | bao-opus |

Graph: 001 --> 004, 002 --> 004. 001, 002, 003 are independent.

- **Wave 1 (3, parallel):** 001, 002, 003
- **Wave 2 (1):** 004

File-collision decisions:
- No file is touched by two tasks in this cycle, so no same-wave collision is possible.
- `webview/main.ts` (the cycle-V hotspot) is owned **solely** by TASK-003 — sort wiring,
  set-filter distinct values and typed-value resolution are bundled into that one task
  rather than split across waves.
- `src/ui/queryComposer.ts` + its test belong solely to TASK-001. TASK-002's DISTINCT builder
  went into a NEW `src/ui/distinctValues.ts` specifically to avoid sharing that file, and to
  keep clear of the source-text assertions at `queryComposer.test.ts:161-182`.
- `src/ui/messages.ts` + `src/ui/resultsPanel.ts` + `src/extension.ts` belong solely to TASK-004
  (wave 2). The `src/extension.ts` edit is ~8 lines: implementing the new optional
  `SaveContext.listColumnTypes` beside the existing `listPkColumns`.
- TASK-004 also updates ONE existing test block
  (`resultsPanelServerFilter.test.ts` case 16) — the single intentional behaviour change of
  this cycle (ORDER BY pass-through becomes an explicit rejection).

## Previous cycles

Cycle V (6 tasks, all done) shipped at `68f602a` (v1.6.5). See `archive/cycle-V-*` for
completed task files and the cycle plan.
Cycle U (9 tasks, all done) shipped at `08c8de3` (v1.6.4). See `archive/cycle-U-*`.
Cycle T (12 tasks, all done) shipped at `4a35fec`. See `archive/cycle-T-*`.

## Next cycles (queued)

- **Keyset (cursor) paging for deep offsets.** Cycle W makes OFFSET paging deterministic only
  when the full PK is projected, but not fast; `OFFSET 500000` still scans. Needs a stable unique
  sort key carried through the webview round trip and a different composition for page 0.
- **Safely project missing PK columns for deterministic OFFSET paging.** Cycle W appends the full
  declared PK only when every PK component is already in `StatementResult.result.columns`; if one
  is missing, no tiebreaker is added and no gap-free promise is made. A follow-up must project all
  PK columns through arbitrary wrapped SELECTs without changing visible result columns or
  breaking DISTINCT/aggregate queries; appending all projected columns is not a valid substitute.
- **Session-timezone-aware timestamp literals for MySQL/MSSQL.** `mysql.createPool` is built
  with no `timezone`/`dateStrings` and tedious's `new Connection` with no `useUTC`, so a
  server session not running in UTC shifts the UTC-naive `datetime` literals that
  `typedLiteral` emits. Needs a per-connection session-timezone probe.
- **Scope DISTINCT dropdown values to the active filter/WHERE.** Cycle W composes the DISTINCT
  list over the base statement with `where = ""` because the host retains no per-statement WHERE
  (verified: no `lastWhere` / `whereByStatement` in `src/ui/resultsPanel.ts`), so the dropdown can
  offer values the current filtered view cannot contain. Needs the host to retain the composed
  WHERE (bar AND filter) per statement first; `buildDistinctValuesQuery`'s `where` parameter is
  already in place for it.
- **`NULLS FIRST/LAST` on mysql/mssql.** Cycle W accepts the clause in the grammar, renders it
  natively on postgres and rejects it elsewhere rather than emulating it with a `CASE` /
  `IS NULL` sort key (no producer emits it today — requery-bar typing only).
- **Typed `dialect` field on `StateMessage`.** The webview currently infers the driver by parsing
  the `state` header string (`extension.ts:623`) in order to quote non-bare `colId`s, falling
  back to postgres quoting. A typed field would remove the string parsing.
- **Whitespace-only values in `(Blanks)`.** Cycle W folds `''` into `(Blanks)` for string
  columns but leaves `"  "` as its own entry; `TRIM(col) = ''` would match it at the cost of
  the index on all three dialects.
- **Shared `stripTrailingSemicolon`.** Duplicated between `src/ui/queryComposer.ts` and the
  new `src/ui/distinctValues.ts` to avoid a cross-task file collision; hoist both into one
  module.
- **MySQL `getTableSortQuery` adapter twin.** Postgres and MSSQL have one; MySQL's arm is
  composed inline in `composeSortQuery`. Only worth doing if a second call site appears.
