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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (step 1 — tests written first, run before any implementation):

```
 ❯ src/adapters/__tests__/postgres.sortQuery.test.ts  (7 tests | 7 failed) 3ms
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery basic sort
     → getTableSortQuery is not a function
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery with WHERE
     → getTableSortQuery is not a function
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery DESC direction
     → getTableSortQuery is not a function
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery empty where
     → getTableSortQuery is not a function
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery SQL injection in column name
     → getTableSortQuery is not a function
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery empty originalSql
     → getTableSortQuery is not a function
   ❯ src/adapters/__tests__/postgres.sortQuery.test.ts > getTableSortQuery > getTableSortQuery preserves original SQL
     → getTableSortQuery is not a function

 Test Files  1 failed (1)
      Tests  7 failed (7)
   Start at  18:41:18
   Duration  372ms (transform 72ms, setup 0ms, collect 85ms, tests 3ms, environment 0ms, prepare 127ms)

EXIT_CODE=1
```

All 7 failures are `TypeError: getTableSortQuery is not a function` — the expected
reason (export did not exist yet). After implementation, the same file went
`1 passed (1) / 7 passed (7)`, exit 0.

Verification Output:

```
$ npm run compile
  dist/webview.js.map    3.9mb
  dist/webview.css.map  36.7kb

⚡ Done in 166ms
esbuild: build complete
EXIT_CODE=0

$ npm test
 Test Files  86 passed | 1 skipped (87)
      Tests  1266 passed | 2 skipped (1268)
   Start at  18:42:07
   Duration  12.26s (transform 3.54s, setup 8ms, collect 9.09s, tests 55.51s, environment 13.77s, prepare 5.76s)
EXIT_CODE=0

$ npm run typecheck
> vsdb@1.6.3 typecheck
> tsc --noEmit
EXIT_CODE=0
```

Full suite: 1266 passed / 0 failed — matches the previous successful run of this
task (1259 baseline + 7 new tests).

Status: PASS
Note: none. Implementation decisions: WHERE from the requery bar is appended as
the OUTER query's WHERE (original SQL stays verbatim inside the subquery);
`direction` is whitelist-normalized to ASC/DESC; column is emitted as one
double-quoted identifier with embedded `"` doubled (Postgres identifier rule),
which is what the injection edge case exercises. Empty `originalSql` composes
without throwing (kept lenient per Test Case 6 — no trailing-`;` stripping,
out of scope).

