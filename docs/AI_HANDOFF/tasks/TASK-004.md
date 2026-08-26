# TASK-004 — Whitespace `(Blanks)` and shared SQL terminator normalizer

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.3

## Goal

Treat whitespace-only strings as `(Blanks)` consistently from set-filter display through typed resolution and SQL generation. Hoist the three identical trailing-semicolon implementations into one browser-safe helper while these same query/grid files are owned together.

## Target Files

- `src/core/text.ts` — export shared `stripTrailingSemicolon(sql: string): string`.
- `src/core/__tests__/text.test.ts` — helper happy, lexical, and whitespace boundary tests.
- `src/ui/resultsGridModel.ts` — import helper; use one blank classifier for entry grouping and local membership.
- `src/ui/queryComposer.ts` — import helper; for declared string columns compose `TRIM(quotedColumn) = ''`.
- `src/ui/distinctValues.ts` — import helper and remove local copy.
- `webview/main.ts` — use whitespace-aware blank classification in distinct/loaded typed-value lookup.
- `src/ui/__tests__/resultsGridModelSetFilter.test.ts` — whitespace grouping/membership tests.
- `src/ui/__tests__/queryComposer.test.ts` — per-dialect whitespace SQL and type-safety tests plus single-helper source contract.
- `src/ui/__tests__/distinctValues.test.ts` — shared helper wrapping regression.
- `src/ui/__tests__/webviewSetFilter.test.ts` — real bundled whitespace `(Blanks)` behavior.

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

## Test Files

- `src/core/__tests__/text.test.ts`
- `src/ui/__tests__/resultsGridModelSetFilter.test.ts`
- `src/ui/__tests__/queryComposer.test.ts`
- `src/ui/__tests__/distinctValues.test.ts`
- `src/ui/__tests__/webviewSetFilter.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/core/__tests__/text.test.ts src/ui/__tests__/resultsGridModelSetFilter.test.ts src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/distinctValues.test.ts src/ui/__tests__/webviewSetFilter.test.ts
npm run typecheck
```

`compile` precedes the webview test. `package.json` has no lint script.

## Acceptance Criteria

- [ ] NULL, undefined, empty, spaces-only, and tabs-only strings share one `(Blanks)` group and local membership behavior.
- [ ] String-column server predicates match NULL and trimmed-empty values; non-string/unknown predicates stay NULL-only.
- [ ] Identifier quoting remains dialect-safe and mixed normal values remain typed/escaped through existing literal logic.
- [ ] Exactly one exported implementation of `stripTrailingSemicolon` remains, in `src/core/text.ts`.
- [ ] Existing wrapper output is unchanged except the intentional whitespace-blank predicate.
- [ ] Targeted tests, compile, and typecheck exit 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — the UI audit gate must complete before any Cycle X UI/query fix wave starts.

## Interfaces

- Consumes: `quoteIdent(name: string, dialect: Dialect): string`; `sqlLiteral(v: unknown): string`; `FilterWhereOptions.columnTypes?: Record<string, string>`; PLAN §7.
- Produces: `stripTrailingSemicolon(sql: string): string`; unchanged signatures `buildSetFilterEntries(values: unknown[]): SetFilterEntry[]`, `setFilterPass(value: unknown, selectedKeys: Set<string> | null): boolean`, `buildFilterWhere(filters: ColumnFilterModel, dialect: Dialect, options?: FilterWhereOptions): string`.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Grounding correction: the requested duplication is not in `resultsPanel.ts`. Real copies exist in `src/ui/queryComposer.ts`, `src/ui/distinctValues.ts`, and `src/ui/resultsGridModel.ts`, so all three are included. The `TRIM` index cost is accepted only for an explicit `(Blanks)` filter on a declared string column.

---
