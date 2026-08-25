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

**Executor (claude-code / feature-implementer) — decisions recorded per handoff ambiguity rule:**

1. **`TYPES.Null` does not exist in tedious 18.6.2** (verified: `Object.keys(TYPES)` has no `Null`; the `.d.ts` has no such export either). Test case #6 ("Sends TYPES.Null parameter") is therefore implemented as the tedious-18 canonical NULL wire form: the declared type (`NVarChar`) is kept and the `null` value is passed through `addParameter` — tedious emits the TDS NULL marker for a null value (confirmed against `rpcrequest-payload.js` + `NVarChar.generateParameterData` null path, and `addParameter('p', TYPES.NVarChar, null)` round-trips without error). The test asserts the null value reaches `addParameter` un-stringified.
2. **`estimateTableRows` (singular) also converted** — it is not in the Target Files method list, but acceptance criterion #3 ("No `${this.literal()}` interpolation remains in SQL strings passed to execSql") is violated if it keeps interpolating, since it funnels through `execute` → `execSql` like the rest. Same one-line pattern as the batch variant; noted here as deliberate.
3. **One stale test updated in `adapterQueryShape.test.ts`** (outside the Target Files list, flagged): the existing edge test "listColumns(...'O'Brien'...) emits `'O''Brien'` exactly once" asserts the retired literal-escaping behavior and cannot pass alongside acceptance #3/#5. Updated minimally to assert the new contract (value never appears in SQL text — raw or `''`-escaped — and travels as the `@table` parameter). No other assertion in that file touched.
4. **Tests #4 (literal backward-compat) and #5 (empty params no-op) pass both before and after by design** — they are guard tests for retained/no-op behavior per the Test Cases table, not new-behavior tests. RED was confirmed by the other 6 tests failing for the expected reasons.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
$ npm test src/adapters/__tests__/mssql.parameterized.test.ts
 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.execute(sql, params) — parameter binding (TASK-002) > #1 execute with params sends NVarChar parameters
AssertionError: expected "spy" to be called 2 times, but got 0 times
 ❯ src/adapters/__tests__/mssql.parameterized.test.ts:124:26

 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.execute(sql, params) — parameter binding (TASK-002) > #6 edge: execute with null param value sends the parameter as a typed NULL
AssertionError: expected "spy" to be called 1 times, but got 0 times

 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.metadata queries — parameterized SQL (TASK-002) > #2 listTables uses parameterized query
AssertionError: expected 'SELECT t.name AS name, s.name AS [sch…' not to contain "'dbo'"
- Expected
+ Received
+ SELECT t.name AS name, s.name AS [schema]
+          FROM sys.tables t
+          JOIN sys.schemas s ON s.schema_id = t.schema_id
+         WHERE s.name = 'dbo'
+          ORDER BY t.name

 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.metadata queries — parameterized SQL (TASK-002) > #3 listColumns uses parameterized query
AssertionError: expected 'SELECT c.name AS name, ty.name AS dataT…' to contain '@table'

 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.metadata queries — parameterized SQL (TASK-002) > #2b regression: listTables with a quote in the schema name never reaches the SQL text
AssertionError: expected 'SELECT t.name AS name, s.name AS [sch…' not to contain 'O\'\'Brien'
+         WHERE s.name = 'O''Brien'

 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.metadata queries — parameterized SQL (TASK-002) > #3b regression: estimateTableRowsBatch builds an IN list from @tableN parameters
AssertionError: expected 'SELECT t.name AS name, SUM(p.rows) AS…' to contain 'IN (@table0, @table1)'
+          WHERE s.name = 'dbo'
+            AND t.name IN ('a', 'b')

 Test Files  1 failed (1)
      Tests  6 failed | 2 passed (8)
```
(6 RED failures = exactly the new-behavior tests; the 2 pre-existing passes are guard tests #4 literal-backward-compat and #5 empty-params-no-op — see Discussion note 4.)

Verification Output:
```
$ npm test src/adapters/__tests__/mssql.parameterized.test.ts
 ✓ src/adapters/__tests__/mssql.parameterized.test.ts  (8 tests) 4ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  311ms

$ npm run compile          # run once first: 2 pre-existing tests read dist/ artifacts
$ npm test
 Test Files  86 passed | 1 skipped (87)
      Tests  1267 passed | 2 skipped (1269)
   Duration  9.34s

$ npm run typecheck
> vsdb@1.6.3 typecheck
> tsc --noEmit
(exit 0, clean)
```

Status: PASS
Note: (1) tedious 18.6.2 has no `TYPES.Null` export — test case #6 implemented as declared-type + null value (tedious's canonical TDS NULL wire form); recorded in Discussion. (2) `estimateTableRows` (singular) also converted beyond the Target Files method list to satisfy acceptance criterion #3 (no literal interpolation reaches execSql). (3) One stale edge test in `src/adapters/__tests__/adapterQueryShape.test.ts` (asserted the retired `'O''Brien'` escaping in listColumns SQL) was updated to assert the parameterized contract — required for acceptance #5 (`npm test` green). (4) First full `npm test` run failed 2 pre-existing dist-artifact tests (ENOENT dist/webview.css, dist/schemaForm.js) before `npm run compile`; green after compiling — unrelated to this change.

## Reviewer Verdict (R1 — adapters/export group)
VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
FINDINGS: no Critical/Important defects; minor notes only, non-blocking. Verification re-run green.
SOURCE: R1 review round outcome recorded in RUN.md cursor (adapters/export group).
