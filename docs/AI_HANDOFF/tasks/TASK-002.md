# TASK-002 -- MSSQL parameter binding (types.ts + mssql.ts)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.2

## Goal

Replace all `${this.literal()}` string interpolation in MsSqlAdapter with parameterized queries using `tedious` TYPES and `addParameter`. Add an `execute` helper that accepts optional typed parameters alongside the SQL string.

## Target Files

- `src/adapters/mssql.ts` (existing, 788 lines) -- add `execute(sql, params?)` private method; refactor `listTables`, `listViews`, `listRoutines`, `listColumns`, `estimateTableRowsBatch` to use params instead of `this.literal()`
- `src/adapters/__tests__/mssql.parameterized.test.ts` (new) -- unit tests for parameterized execute (this file is NOT excluded from the default vitest config, unlike `*.integration.test.ts`)

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `execute with params sends NVarChar parameters` | Request.addParameter called with TYPES.NVarChar for each param | Mock tedious Request |
| 2 | unit | `listTables uses parameterized query` | SQL string contains no `${this.literal()}` interpolation | Mock adapter, spy on execute |
| 3 | unit | `listColumns uses parameterized query` | SQL string contains no `${this.literal()}` interpolation | Mock adapter, spy on execute |
| 4 | unit | `literal() method still exists for backward compat` | `this.literal("test")` returns `'test'` | Direct method call |
| 5 | edge | `execute with empty params array` | Runs SQL without parameters | Empty params |
| 6 | edge | `execute with null param value` | Sends TYPES.Null parameter | Null value in params |

## Test Files

- `src/adapters/__tests__/mssql.parameterized.test.ts` (new) -- unit tests for parameterized execute

## Verification Commands

```bash
npm test src/adapters/__tests__/mssql.parameterized.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] `execute(sql, params?)` private method created on MsSqlAdapter
- [ ] All metadata queries (listTables, listViews, listRoutines, listColumns, estimateTableRowsBatch) use parameterized execution
- [ ] No `${this.literal()}` interpolation remains in SQL strings passed to `execSql`
- [ ] `literal()` method retained for backward compatibility but no longer called from metadata queries
- [ ] All existing unit MSSQL tests still pass (`npm test`)
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: existing `tedious` Connection/Request/TYPES imports in mssql.ts
- Produces: `private execute(sql: string, params?: Array<{name: string, type: typeof TYPES[keyof typeof TYPES], value: string | null}>): Promise<QueryResult>`

---

## Discussion

(chua co comment)
