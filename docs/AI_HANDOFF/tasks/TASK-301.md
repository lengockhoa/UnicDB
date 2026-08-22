# TASK-301 — Adapter: estimateTableRows (reltuples)

Cycle 2026-08-22-B · P0 · Size S · Deps: none
(Rev 2 — áp PlanReviewer Round 1 findings: interface file đúng, mysql/mssql impl, test file mới vi.mock)

## Goal

Thêm `estimateTableRows(schema: string, table: string): Promise<number | null>` vào `DbAdapter` interface (`src/adapters/types.ts` — KHÔNG phải factory.ts) và implement cho **cả 3 adapter** (postgres, mysql, mssql — cùng implements DbAdapter, thiếu 1 cái là typecheck fail). Postgres dùng `pg_class.reltuples`; mysql/mssql dùng catalog metadata nhanh (KHÔNG COUNT(*)). Null khi unknown hoặc lỗi; không bao giờ throw lên tree.

## Action

1. `src/adapters/types.ts` — thêm vào `DbAdapter` (sau `listColumns`):
   ```ts
   /** Row estimate cho table từ planner/catalog metadata (không scan). Null = unknown (chưa analyze / lỗi / không tồn tại). */
   estimateTableRows(schema: string, table: string): Promise<number | null>;
   ```
2. `src/adapters/postgres.ts`:
   ```sql
   SELECT c.reltuples::bigint AS row_estimate
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')
   ```
   Dùng helper query(sql, params) hiện tại (postgres.ts ~310-319). 0 row → null; `row_estimate < 0` → null; ngược lại → number. Try/catch toàn bộ → `return null`.
3. `src/adapters/mysql.ts`: `SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'` — TABLE_ROWS null → null; try/catch → null.
4. `src/adapters/mssql.ts`: `SELECT SUM(p.rows) AS row_count FROM sys.partitions p JOIN sys.tables t ON t.object_id = p.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @schema AND t.name = @table AND p.index_id IN (0,1)` — null/0-row → null; try/catch → null.
5. Test file **MỚI** `src/adapters/__tests__/postgres.test.ts` — chưa tồn tại (chỉ có `postgres.integration.test.ts` dùng DB thật). Dùng `vi.mock('pg')` theo pattern mock của project (xem `src/adapters/__tests__/factory.test.ts` cho vi.mock style).

## Interfaces

- Produces: `DbAdapter.estimateTableRows(schema, table): Promise<number | null>` — TASK-302 gọi qua `getAdapterFor()`.

## Test Cases

| Loại | Test | Expected |
|------|------|----------|
| happy | pg: reltuples=176 → estimateTableRows('qas','api_po_log') | resolves 176 |
| happy | pg: reltuples=1234567 | resolves 1234567 |
| edge | pg: reltuples=-1 (chưa ANALYZE) | resolves null |
| edge | pg: query trả 0 row (table không tồn tại / không phải table) | resolves null, không throw |
| edge | pg: client query reject (connection chết) | resolves null, không throw |
| edge | pg: reltuples=0 (table rỗng đã analyze) | resolves 0 |

(MySQL/MSSQL impl smoke qua typecheck; integration test DB thật nằm ngoài cycle này.)

## Test Files

- `src/adapters/__tests__/postgres.test.ts` (**file mới**, vi.mock('pg'))

## Verification Commands

```bash
npm run typecheck
npx vitest run src/adapters/__tests__/postgres.test.ts
```

## Acceptance Criteria

- [x] Interface (types.ts) + 3 adapter impl, typecheck pass
- [x] 6 test cases pass (RED trước khi implement)
- [x] Không COUNT(*) / TABLE_ROWS scan-full ở bất kỳ đâu

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec301 (feature-implementer)
SUMMARY: Added `estimateTableRows(schema, table): Promise<number | null>` to DbAdapter interface and implemented for all 3 adapters (Postgres pg_class.reltuples, MySQL information_schema.TABLES.TABLE_ROWS, MSSQL sys.partitions SUM). 6 mock-based unit tests added in new file `src/adapters/__tests__/postgres.test.ts` using `vi.mock('pg')`.
TEST_PLAN_FOLLOWED: inline (task §Test Cases — 6 cases, vi.mock('pg') pattern)
FILES_CHANGED:
  - src/adapters/types.ts: added `estimateTableRows` to DbAdapter interface (after listColumns, before testConnection).
  - src/adapters/postgres.ts: added `estimateTableRows` impl using existing `this.query` helper + pg_class/pg_namespace catalog query; try/catch → null; reltuples<0 or 0-rows → null.
  - src/adapters/mysql.ts: added `estimateTableRows` impl using `information_schema.TABLES.TABLE_ROWS` with `TABLE_TYPE = 'BASE TABLE'`; null/0-rows → null.
  - src/adapters/mssql.ts: added `estimateTableRows` impl using `sys.partitions` SUM joined to sys.tables/sys.schemas; index_id IN (0,1); null SUM → null.
  - src/adapters/__tests__/postgres.test.ts (NEW): 6 test cases via `vi.mock('pg')` with queue-driven fake Pool.
  - docs/AI_HANDOFF/INDEX.md: TASK-301 status ready → in_progress (this run) → pending_review (after report).
TESTS_ADDED:
  - src/adapters/__tests__/postgres.test.ts:
    - happy: pg: reltuples=176 → estimateTableRows('qas','api_po_log') resolves 176
    - happy: pg: reltuples=1234567 resolves 1234567
    - edge: pg: reltuples=-1 (chưa ANALYZE) resolves null
    - edge: pg: query trả 0 row resolves null, không throw
    - edge: pg: client query reject resolves null, không throw
    - edge: pg: reltuples=0 resolves 0
VERIFICATION:
  command: npm run typecheck
  result: PASS (exit 0, no errors)
  output_excerpt: |
    > vsdb@1.3.0 typecheck
    > tsc --noEmit
  command: npx vitest run src/adapters/__tests__/postgres.test.ts
  result: 6 passed (6)
  output_excerpt: |
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
     ✓ src/adapters/__tests__/postgres.test.ts  (6 tests) 1ms
     Test Files  1 passed (1)
          Tests  6 passed (6)
RED_OUTPUT (captured before implementation):
  command: npx vitest run src/adapters/__tests__/postgres.test.ts
  result: 6 failed (6) — all "TypeError: adapter.estimateTableRows is not a function"
  output_excerpt: |
     FAIL  src/adapters/__tests__/postgres.test.ts > PostgresAdapter — estimateTableRows (TASK-301) > happy: reltuples=176 → resolves 176
    TypeError: adapter.estimateTableRows is not a function
     ❯ src/adapters/__tests__/postgres.test.ts:97:34
     … (6 identical-style failures, one per test case)
      Test Files  1 failed (1)
           Tests  6 failed (6)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

## Reviewer Verdict


(reviewer điền)

