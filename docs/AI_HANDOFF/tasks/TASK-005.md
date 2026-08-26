# TASK-005 — Emulate NULLS FIRST/LAST on MySQL and MSSQL

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 items 6 and 8, §3.4

## Goal

Accept valid `NULLS FIRST` / `NULLS LAST` order terms on all three dialects. PostgreSQL keeps
native syntax; MySQL and MSSQL receive a safe leading null-rank sort expression followed by the
regular quoted column sort. Remove the dead `unquoteIdent` guard and correct stale test names
as bundled P3 cleanup.

## Target Files

- `src/ui/queryComposer.ts` — stop rejecting NULLS for mysql/mssql; render native or emulated
  clauses; remove the dead guard in `unquoteIdent`.
- `src/ui/__tests__/queryComposer.test.ts` — replace today’s mysql/mssql rejection assertions
  with exact emulation SQL and retitle the stale whitespace predicate cases at `:685,698`.
- `src/ui/__tests__/resultsPanelOrderBy.test.ts` — replace case 8c’s rejected-requery assertion
  with host execution assertion for emulated NULLS clauses.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | MySQL NULLS LAST is emulated | `parseOrderBy("a ASC NULLS LAST", "mysql")` is `{ok:true}` and `buildOrderByClause` is exactly `` `a` IS NULL ASC, `a` ASC ``. | One valid bare identifier. |
| 2 | edge — dialect | MSSQL NULLS LAST is emulated without boolean ORDER BY | Exact output is `CASE WHEN [a] IS NULL THEN 1 ELSE 0 END ASC, [a] ASC`; it contains no `NULLS LAST`. | Same term under `mssql`. |
| 3 | edge — boundary | NULLS FIRST reverses only rank direction | MySQL and MSSQL rank key ends `DESC` while the data term stays caller direction; postgres remains exactly `"a" ASC NULLS FIRST`. | ASC and DESC term fixtures. |
| 4 | regression | Valid mysql/mssql NULLS no longer becomes synthetic error state | `ResultsPanel` receives `a NULLS LAST`, calls runner with emulated SQL once, and does not post `status:"error"` / error text matching `Invalid ORDER BY`. | Existing case-8c host harness, parameterized mysql/mssql. |
| 5 | edge — malformed input | Expressions remain rejected | `parseOrderBy("CASE WHEN a IS NULL THEN 0 END", "mysql")` is `{ok:false}` and runner is never called. | Existing expression-rejection fixture. |
| 6 | regression — cleanup | Unquote and whitespace behavior stays unchanged | Existing quoted identifier escaping tests still pass after deleting the no-op guard; renamed whitespace tests retain their exact regex/NOT LIKE assertions. | Existing suite cases. |

## Test Files

- `src/ui/__tests__/queryComposer.test.ts`
- `src/ui/__tests__/resultsPanelOrderBy.test.ts`

## Verification Commands

```bash
npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts
npm run typecheck
```

No selected test loads a `dist/*.js` bundle. `package.json` has no lint script. Global
constraints: PLAN.md §7.

## Acceptance Criteria

- [ ] PostgreSQL output remains native and byte-identical.
- [ ] MySQL output uses `quotedColumn IS NULL ASC|DESC, quotedColumn direction`.
- [ ] MSSQL output uses `CASE WHEN quotedColumn IS NULL THEN 1 ELSE 0 END ASC|DESC` followed
      by its normal bracket-quoted data term.
- [ ] Plain-identifier validation and expression rejection remain intact.
- [ ] The old rejection tests are intentionally rewritten to pin the new public behavior.
- [ ] The unreachable `unquoteIdent` guard and stale TRIM-based test titles are removed/updated
      without changing their assertions.
- [ ] All listed verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes: `parseOrderBy(orderBy: string, dialect?: Dialect): ParseOrderByResult`
  (`queryComposer.ts:304`), `OrderByTerm { column, direction, nulls? }` (`:231-235`), and
  `buildOrderByClause(terms, dialect)` (`:443-451`).
- Produces: an accepted `nulls` term for all three dialects and safe, dialect-specific SQL used
  by `ResultsPanel.composeRequerySql()` (`resultsPanel.ts:1117`).

---

## Discussion

1. **Rank direction is load-bearing.** `IS NULL` / CASE returns 1 for nulls. Ascending puts nulls
   last; descending puts them first. Keep the actual data sort direction unchanged after the
   rank term.
2. **No raw user token reaches SQL.** Keep `parseOrderBy` → logical identifier → `quoteIdent`
   flow. Do not append raw `NULLS` input or expressions.
3. **No `resultsPanel.ts` ownership.** The host test may be edited, but production composition
   stays in `queryComposer.ts`; this task must not touch `resultsPanel.ts`, which TASK-004 owns.
4. **TDD order.** Convert the existing expected-rejection assertions into failing exact SQL
   assertions before changing parser/rendering code.

---
