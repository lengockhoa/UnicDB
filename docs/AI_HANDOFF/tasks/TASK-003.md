# TASK-003 — DbAdapter interface + Postgres adapter + docker compose

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (test #9)

## Goal

Định nghĩa interface `DbAdapter` dùng chung cho cả 3 DB + hiện thực đầy đủ adapter PostgreSQL (pg): connect/close, query dạng AsyncIterable batch 500 rows qua cursor API, cancel, metadata (tables/views/routines/columns). Tạo `docker/docker-compose.yml` MỘT LẦN với đủ 3 services (postgres/mysql/mssql) để TASK-004 reuse.

## Target Files

- `src/adapters/types.ts` — interface dùng chung:
  - `export interface QueryResult { columns: string[]; rows: any[][]; rowCount: number | null; commandTag?: string; durationMs: number }`
  - `export interface TableInfo { name: string; schema: string }` ; `ViewInfo` tương tự; `RoutineInfo { name: string; kind: 'function' | 'procedure'; schema: string }`; `ColumnInfo { name: string; dataType: string; nullable: boolean; isPrimaryKey?: boolean }`
  - `export interface BatchedQuery { columns: string[]; fetchBatch(): Promise<any[][] | null>; cancel(): Promise<void>; close(): Promise<void> }` — null = hết rows.
  - `export interface DbAdapter { connect(): Promise<void>; close(): Promise<void>; runQuery(sql: string): Promise<{ results: QueryResult[]; batched?: BatchedQuery }>; listTables(schema?: string): Promise<TableInfo[]>; listViews(schema?: string): Promise<ViewInfo[]>; listRoutines(schema?: string): Promise<RoutineInfo[]>; listColumns(table: string, schema?: string): Promise<ColumnInfo[]>; testConnection(): Promise<void> }`
- `src/adapters/postgres.ts` — class `PostgresAdapter implements DbAdapter`: dùng `pg.Pool` (pool size 1); `runQuery` với statements đơn giản trả hết results; SELECT dùng `pg` cursor API (`new pg.Cursor(sql)`) → `BatchedQuery` gom 500 rows/lần fetch; `cancel()` gọi `cursor.close()` + `pg_cancel_backend`; metadata qua `information_schema.tables/columns` + `pg_proc`.
- `src/adapters/factory.ts` — `export function createAdapter(cfg: ConnectionConfig): DbAdapter` (case postgres only; mysql/mssql throw `NotImplementedError` — TASK-004 fill). **Note:** factory.ts is created here with postgres case only; TASK-004 extends it with mysql + mssql cases.
- `docker/docker-compose.yml` — 3 services (TẠO ĐẦY ĐỦ NGAY TẪ ĐÂU): `postgres:16-alpine` (user/pass `vsdb/vsdb`, db `vsdb`, port 5433), `mysql:8` (root pass `vsdb`, db `vsdb`, port 3307), `mcr.microsoft.com/mssql/server:2022-latest` (SA_PASSWORD `VsdbPass123!`, port 1434, `ACCEPT_EULA=Y`).
- `src/adapters/__tests__/postgres.integration.test.ts` — integration (chỉ chạy khi `VSDB_IT=1`).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | integration | Connect + query đơn giản | `SELECT 1 AS one` trả columns `['one']`, rows `[[1]]` | docker compose up postgres |
| 2 | integration | Batch 500 + Load more | `SELECT generate_series(1,1200)` → fetchBatch đầu 500 rows, lần 2 500, lần 3 200, lần 4 null | docker postgres |
| 3 | edge (integration) | Sai password → lỗi rõ | lỗi chứa `28P01` hoặc "password authentication failed" | host đúng, password sai |
| 4 | edge (integration) | Cancel giữa query | gọi cancel() khi đang fetch → fetchBatch sau đó trả null/close không throw | query dài generate_series(1,5000000) |
| 5 | integration | Metadata đúng | seed table → listTables/listColumns trả đúng tên + kiểu; listRoutines sau khi CREATE FUNCTION | docker postgres + seed SQL |

## Test Files

- `src/adapters/__tests__/postgres.integration.test.ts`
- `src/adapters/__tests__/factory.test.ts` — unit: factory trả PostgresAdapter cho postgres; throw cho 2 driver chưa có.

## Verification Commands

```bash
npx tsc --noEmit
npm test -- src/adapters/__tests__/factory.test.ts
docker compose -f docker/docker-compose.yml up -d postgres
VSDB_IT=1 npm run test:integration
```

(Executor chạy `docker compose down` sau khi xong nếu cần.)

## Acceptance Criteria

- [ ] Unit test factory PASS; integration postgres PASS khi `VSDB_IT=1`.
- [ ] `BatchedQuery` interface đúng chữ ký — TASK-004/006 phụ thuộc nguyên văn.
- [ ] docker-compose.yml có đủ 3 services (TASK-004 sẽ không phải sửa file này).
- [ ] Không regression: `npm test` PASS.
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (scaffold, deps pg), TASK-002 (types `ConnectionConfig`)

## Interfaces

- Consumes: `ConnectionConfig`, `DriverType` từ `src/config/types.ts` (TASK-002).
- Produces:
  - `DbAdapter`, `QueryResult`, `BatchedQuery`, `TableInfo`, `ViewInfo`, `RoutineInfo`, `ColumnInfo` từ `src/adapters/types.ts` — TASK-004/005/006/007 consume NGUYÊN VĂN, không sửa file này ở task khác (trừdiscussion đồng ý).
  - `createAdapter(cfg: ConnectionConfig): DbAdapter` từ `src/adapters/factory.ts`.
  - `docker/docker-compose.yml` services: `postgres`(:5433, vsdb/vsdb/vsdb), `mysql`(:3307, root/vsdb), `mssql`(:1434, sa/VsdbPass123!).

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
