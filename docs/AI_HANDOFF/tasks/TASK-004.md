# TASK-004 — Adapter MySQL (mysql2) + SQL Server (tedious)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (test #10)

## Goal

Hiện thực 2 adapter còn lại theo đúng `DbAdapter` của TASK-003: MySQL/MariaDB (mysql2, streaming qua `query().stream()`) và SQL Server (tedious, stream qua `request.on('row')`), cùng cơ chế batch 500 rows + cancel, và fill 2 case còn thiếu trong `factory.ts`.

## Target Files

- `src/adapters/mysql.ts` — class `MySqlAdapter implements DbAdapter`: connection pool mysql2/promise; SELECT → `conn.query(sql).stream()` gom rows vào buffer 500 → `BatchedQuery.fetchBatch()`; `cancel()` = `conn.destroy()` (kill query); metadata qua `information_schema`.
- `src/adapters/mssql.ts` — class `MsSqlAdapter implements DbAdapter`: tedious `Connection` + `Request`, `request.on('row')` push vào buffer 500, `request.on('done')` đánh dấu hết; `cancel()` = `request.cancel()`; metadata qua `sys.tables`/`sys.columns`/`sys.objects`.
- `src/adapters/factory.ts` — TASK-003 tạo factory với case postgres; task này thêm cases mysql + mssql (`new MySqlAdapter(cfg)`, `new MsSqlAdapter(cfg)` + imports).
- `src/adapters/__tests__/mysql.integration.test.ts`, `src/adapters/__tests__/mssql.integration.test.ts` — integration khi `VSDB_IT=1`.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | integration | MySQL connect + query | `SELECT 1 AS one` trả `columns:['one']`, `rows:[[1]]` | docker compose up mysql |
| 2 | integration | MySQL batch 500 + load more | bảng seed 1.200 rows → fetchBatch 500/500/200/null, thứ tự đúng | seed INSERT ... 1200 rows |
| 3 | edge (integration) | MySQL sai password | lỗi chứa "Access denied" (ER_ACCESS_DENIED_ERROR) | password sai |
| 4 | integration | MSSQL connect + query | `SELECT 1 AS one` trả đúng | docker compose up mssql |
| 5 | integration | MSSQL batch 500 + metadata | seed table → batch đúng + listTables/listColumns trả đúng | seed trong test setup |
| 6 | edge (integration) | MSSQL sai password / cancel | lỗi "Login failed"; cancel() giữa stream dừng fetchBatch (trả null sau đó) | login sai / query lớn |

## Test Files

- `src/adapters/__tests__/mysql.integration.test.ts`
- `src/adapters/__tests__/mssql.integration.test.ts`
- `src/adapters/__tests__/factory.test.ts` — sửa/append: factory trả đúng 3 adapter cho 3 driver (unit, không cần docker).

## Verification Commands

```bash
npx tsc --noEmit
npm test -- src/adapters/__tests__/factory.test.ts
docker compose -f docker/docker-compose.yml up -d mysql mssql
VSDB_IT=1 npm run test:integration
```

## Acceptance Criteria

- [ ] Cả 2 adapter hiện thực ĐỦ `DbAdapter` — typecheck xanh là chứng minh contract.
- [ ] Integration test MySQL + MSSQL PASS khi `VSDB_IT=1`.
- [ ] Batch interface giống hệt postgres (`fetchBatch(): Promise<any[][]|null>`) — KHÔNG re-execute để load more.
- [ ] Không regression: `npm test` PASS (kể cả postgres integration cũ).
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-003 (`src/adapters/types.ts`, `factory.ts`, `docker/docker-compose.yml` — REUSE compose, không sửa)

## Interfaces

- Consumes: `DbAdapter`, `BatchedQuery`, `QueryResult`, `TableInfo`, `ViewInfo`, `RoutineInfo`, `ColumnInfo` từ `src/adapters/types.ts` (TASK-003) — NGUYÊN VĂN, không sửa interface.
- Consumes: `ConnectionConfig` từ `src/config/types.ts`.
- Produces: `createAdapter(cfg)` hỗ trợ đủ 3 driver `postgres|mysql|mssql` — TASK-005/006/007 chỉ gọi factory.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
