# TASK-003 -- Postgres sort query helper (getTableSortQuery)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.3

## Goal

Add a pure function `getTableSortQuery` to `postgres.ts` that wraps a SQL query with ORDER BY for server-side column sorting. The webview will compose the requery by putting column sort into the `orderBy` field of the existing `requery` message.

## Target Files

- `src/adapters/postgres.ts` (existing) -- add exported pure function `getTableSortQuery(originalSql: string, whereFromBar: string, column: string, direction: "ASC"|"DESC"): string`
- `src/adapters/__tests__/postgres.sortQuery.test.ts` (new) -- tests for sort query composition

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `getTableSortQuery basic sort` | `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY "name" ASC` | originalSql=`"SELECT 1"`, column=`"name"`, direction=`"ASC"` |
| 2 | unit | `getTableSortQuery with WHERE` | SQL contains both WHERE and ORDER BY | whereFromBar=`"age > 18"` |
| 3 | unit | `getTableSortQuery DESC direction` | ORDER BY ... DESC | direction=`"DESC"` |
| 4 | unit | `getTableSortQuery empty where` | No WHERE clause added | whereFromBar=`""` |
| 5 | edge | `getTableSortQuery SQL injection in column name` | Column quoted as identifier | column=`"name; DROP TABLE users--"` |
| 6 | edge | `getTableSortQuery empty originalSql` | Returns valid SQL (no crash) | originalSql=`""` |
| 7 | regression | `getTableSortQuery preserves original SQL` | Original SQL appears in subquery | Any input |

## Test Files

- `src/adapters/__tests__/postgres.sortQuery.test.ts` (new) -- unit tests

## Verification Commands

```bash
npm test src/adapters/__tests__/postgres.sortQuery.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] `getTableSortQuery` wraps SQL in subquery with `vsdb_sort` alias
- [ ] ORDER BY uses quoted column identifier (injection-safe)
- [ ] WHERE clause from requery bar is included when non-empty
- [ ] Empty where produces no WHERE clause
- [ ] Both ASC and DESC directions work
- [ ] Empty/original SQL inputs handled without crash
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: (none -- pure SQL composition)
- Produces: `getTableSortQuery(originalSql: string, whereFromBar: string, column: string, direction: "ASC"|"DESC"): string`

---

## Discussion

(chua co comment)
