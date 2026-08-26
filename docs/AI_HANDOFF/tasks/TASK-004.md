# TASK-004 — Whitespace `(Blanks)` and shared SQL terminator normalizer

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.3

## Goal

Treat whitespace-only strings as `(Blanks)` consistently from set-filter display through typed resolution and SQL generation. Hoist the three identical trailing-semicolon implementations into one browser-safe helper while these same query/grid files are owned together. Also quote column names in the SQL export serializers so reserved-word and spaced column names export executable SQL (audit finding P2-6, same file).

## Target Files

- `src/core/text.ts` — export shared `stripTrailingSemicolon(sql: string): string`.
- `src/core/__tests__/text.test.ts` — helper happy, lexical, and whitespace boundary tests.
- `src/ui/resultsGridModel.ts` — import helper; use one blank classifier for entry grouping and local membership; **(P2-6)** quote interpolated column names in `serializeSqlUpdates` (`:703-706` SET list, `:717-721` WHERE list) and `serializeWhereClause` (`:773-778`) through a minimal exporter-local quoter.
- `src/ui/queryComposer.ts` — import helper; for declared string columns compose `TRIM(quotedColumn) = ''`.
- `src/ui/distinctValues.ts` — import helper and remove local copy.
- `webview/main.ts` — use whitespace-aware blank classification in distinct/loaded typed-value lookup.
- `src/ui/__tests__/resultsGridModelSetFilter.test.ts` — whitespace grouping/membership tests.
- `src/ui/__tests__/queryComposer.test.ts` — per-dialect whitespace SQL and type-safety tests plus single-helper source contract.
- `src/ui/__tests__/distinctValues.test.ts` — shared helper wrapping regression.
- `src/ui/__tests__/webviewSetFilter.test.ts` — real bundled whitespace `(Blanks)` behavior.
- `src/ui/__tests__/resultsGridModelExport.test.ts` — **(P2-6)** reserved-word / spaced / quote-bearing column export cases.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | Whitespace joins one blanks entry | `[null, "", "  ", "x"]` yields `(Blanks)` count `3` pinned last and `setFilterPass("\t", blanks)` is `true`. | Pure grid-model helpers |
| 2 | edge — type safety | Non-string columns stay NULL-only | Integer/date/unknown declared types emit only quoted `IS NULL`; SQL contains no `TRIM(`. | `(Blanks)` model on non-string columns |
| 3 | edge — dialect/escaping | String blanks SQL quotes safely | PostgreSQL/MySQL/MSSQL emit `col IS NULL OR TRIM(col) = ''` with `"…"`, backtick, or bracket quoting; embedded delimiter stays escaped; normal selected value remains in `IN (...)`. | String type plus `(Blanks)` and `"a"` |
| 4 | regression | Bundle typed resolver maps whitespace to blanks | Selecting `(Blanks)` resolves raw `"   "` from DISTINCT or loaded rows and posts a typed blank rather than unresolved display-only state. | Compiled bundle and whitespace row |
| 5 | happy | One shared terminator helper | `queryComposer`, `distinctValues`, and `resultsGridModel` import `stripTrailingSemicolon`; no local function declaration remains. | Source-contract assertion |
| 6 | edge — lexical | Strip terminator, preserve interior semicolon | `stripTrailingSemicolon("SELECT ';' AS s;  ")` returns `"SELECT ';' AS s"`; wrappers retain the literal semicolon. | String literal plus terminator |
| 7 | edge — empty/boundary | Whitespace-only input is stable | Helper returns `""` for spaces-only input and leaves `SELECT 1` unchanged. | `"   "`, `"SELECT 1"` |
| 8 | regression — P2-6 | Reserved-word column exports executable SQL | `serializeSqlUpdates(["id","order"], [[1,"x"]], {pkCols:["id"], tableName:"results"})` emits `UPDATE results SET "order"='x' WHERE "id"=1;` — the SET/WHERE column names are quoted, not bare. RED before fix (`SET order='x'`). | Pure exporter call, no DOM |
| 9 | edge — escaping/identifier | Spaced and quote-bearing column names | A column named `First Name` emits `"First Name"=…`; a column containing a `"` has it doubled inside one quoted identifier (`"a""b"`); `serializeWhereClause` quotes its key columns the same way. | Export fixtures with `AS "First Name"`-style columns |
| 10 | regression — no-op guard | Bare-identifier exports are byte-stable except for quoting | For all-bare columns (`id`, `name`) the emitted SQL differs from the current baseline only by the added quoting; row-skip comments (`-- row N skipped: no non-key columns to update`), `opts.tableName` handling, hidden-column exclusion, and the trailing `;` are unchanged. | Existing export fixtures in this suite |

## Test Files

- `src/core/__tests__/text.test.ts`
- `src/ui/__tests__/resultsGridModelSetFilter.test.ts`
- `src/ui/__tests__/queryComposer.test.ts`
- `src/ui/__tests__/distinctValues.test.ts`
- `src/ui/__tests__/webviewSetFilter.test.ts`
- `src/ui/__tests__/resultsGridModelExport.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/core/__tests__/text.test.ts src/ui/__tests__/resultsGridModelSetFilter.test.ts src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/distinctValues.test.ts src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/resultsGridModelExport.test.ts
npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts src/ui/__tests__/webviewExport.test.ts
npm run typecheck
```

`compile` precedes the webview test. The second command is the P2-6 regression lane (other exporter/grid-model consumers). `package.json` has no lint script.

## Acceptance Criteria

- [ ] NULL, undefined, empty, spaces-only, and tabs-only strings share one `(Blanks)` group and local membership behavior.
- [ ] String-column server predicates match NULL and trimmed-empty values; non-string/unknown predicates stay NULL-only.
- [ ] Identifier quoting remains dialect-safe and mixed normal values remain typed/escaped through existing literal logic.
- [ ] Exactly one exported implementation of `stripTrailingSemicolon` remains, in `src/core/text.ts`.
- [ ] Existing wrapper output is unchanged except the intentional whitespace-blank predicate.
- [ ] **(P2-6)** `serializeSqlUpdates` and `serializeWhereClause` quote every interpolated column name; no bare reserved-word or spaced column name reaches the exported SQL, and the "never produce unexecutable SQL" contract at `resultsGridModel.ts:650-657` holds for reserved-word columns.
- [ ] **(P2-6)** The exporter quoter is local to `resultsGridModel.ts` (or an existing browser-safe import) and pulls in no driver dependency into the webview bundle; `opts.tableName` handling, hidden-column exclusion, and skip comments are unchanged.
- [ ] Targeted tests, the regression lane, compile, and typecheck exit 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — the UI audit gate must complete before any Cycle X UI/query fix wave starts.

## Interfaces

- Consumes: `quoteIdent(name: string, dialect: Dialect): string`; `sqlLiteral(v: unknown): string`; `FilterWhereOptions.columnTypes?: Record<string, string>`; PLAN §7.
- Produces: `stripTrailingSemicolon(sql: string): string`; unchanged signatures `buildSetFilterEntries(values: unknown[]): SetFilterEntry[]`, `setFilterPass(value: unknown, selectedKeys: Set<string> | null): boolean`, `buildFilterWhere(filters: ColumnFilterModel, dialect: Dialect, options?: FilterWhereOptions): string`, `serializeSqlUpdates(columns: string[], rows: unknown[][], opts): string`, `serializeWhereClause(...)` — export SQL now carries quoted column identifiers.
- Produces (for TASK-007, which edits `webview/main.ts` after this task): `webview/main.ts` is released with only the whitespace-blank typed-value change; TASK-007 rebases its edits on that state.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Grounding correction: the requested duplication is not in `resultsPanel.ts`. Real copies exist in `src/ui/queryComposer.ts`, `src/ui/distinctValues.ts`, and `src/ui/resultsGridModel.ts`, so all three are included. The `TRIM` index cost is accepted only for an explicit `(Blanks)` filter on a declared string column.

### 2026-08-26 · planner · bao-opus (reconciliation gate)
Added audit finding **P2-6** (grid/UI audit, `cycle-x-audit-grid-ui.md`): `serializeSqlUpdates` / `serializeWhereClause` interpolate column names unquoted (`resultsGridModel.ts:705`, `:720`, `:777`), so exporting a result with a column named `order`/`select`, or an `AS "First Name"` alias, produces SQL that will not parse. It is folded here rather than into a new task because `src/ui/resultsGridModel.ts` is already owned exclusively by TASK-004 — a separate task would collide in the same wave.

Quoting choice: use a minimal exporter-local quoter (double-quote style with `"` doubling, matching the export path's existing portable-SQL posture — `sqlLiteral` is already single-quote-only for portability). `quoteIdent` from `src/core/saveStatements.ts` is dialect-parameterised and the exporter has no dialect in hand (`opts.tableName` is hardcoded `"results"` by the webview at `main.ts:2990`), so a local quoter is the smaller, dependency-free choice. `opts.tableName` itself stays as-is — cosmetic per the audit, and changing it would alter existing export fixtures for no correctness gain.

→ @executor: case 10 exists to keep this from becoming a silent format change. If any existing export fixture's expected string must change, list each one in the Executor Report.

### 2026-08-26 · planner · bao-opus (file ownership)
`webview/main.ts` is owned by this task in Wave 2 and by TASK-007 in Wave 3. Keep this task's edit to the typed-value blank classification only; do not pre-emptively touch `orderByFromColumnState`, `handleSaveResult`, `onFilterChanged`, or `onRefreshClick` — those belong to TASK-007.

---
