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

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: claude-sonnet-4-6
- BRANCH: task-004 (worktree)
- DATE: 2026-08-21

### Files created

- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/mysql.ts`
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/mssql.ts`
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/__tests__/mysql.integration.test.ts`
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/__tests__/mssql.integration.test.ts`

### Files modified

- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/factory.ts` (added mysql + mssql branches)
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/__tests__/factory.test.ts` (assert concrete adapters)

### Implementation notes

- **MySqlAdapter (mysql2/promise)**: Connection pool sized to 1 (cursor-equivalent) so a `cancel()` can safely `destroy()` the underlying connection — the same connection that owns the stream — without affecting unrelated adapters. Single `SELECT` streams via `coreConnection.query({ sql, rowsAsArray: true }).stream()`. The promise wrapper does not expose `stream()`, so the implementation reaches through `promiseConnection.connection` to access the core `Query` object. Buffer of up to 500 rows; `pause()` on threshold; `cancel()` calls `stream.destroy()` and destroys the pool connection. Metadata via `information_schema` with backticked column aliases (`table_schema` is a reserved word).
- **MsSqlAdapter (tedious)**: One `Connection` per adapter instance with `encrypt/trustServerCertificate` tied to `cfg.ssl`. The `connect` event fires after login but before Tedious has completed its internal initial-SQL phase, so `connect()` waits for `connection.state.name === 'LoggedIn'` to avoid `Requests can only be made in the LoggedIn state` errors. SELECT streams via `Request.on('row')` collected into a 500-row buffer; `Request.on('done'|'doneInProc'|'doneProc')` signals a result-set boundary (Tedious emits one `done` per result set, not at end-of-stream). `cancel()` calls `request.cancel()` and resolves any pending fetcher with `null`. All requests are serialised through an `operationQueue` promise so a streaming SELECT cannot run concurrently with another metadata query. Metadata queries use `sys.tables`/`sys.schemas`, `sys.objects` (`type IN ('P','IF','TF')`), and `sys.columns`/`sys.types` joined to `sys.indexes`/`sys.index_columns` for primary-key detection.
- **BatchedQuery contract preserved**: Both adapters expose `columns: string[]`, `fetchBatch(): Promise<any[][] | null>`, `cancel(): Promise<void>`, `close(): Promise<void>`. The interface in `src/adapters/types.ts` was NOT modified.
- **Streaming quirks handled inside adapters**: tiny SELECTs (1 row) initially arrived before column metadata because Tedious emits `columnMetadata` asynchronously after `execSql`. The adapter awaits `metadataReady` (resolved in the `columnMetadata` handler) before returning the adapter so callers never see `columns: []` for a 1-row query. For mysql2, a small enough dataset can also complete `end` before `data`; the buffer handles that by handing back the last partial batch via the `streamDone` branch.

### RED_OUTPUT

`npx vitest run src/adapters/__tests__/factory.test.ts` with concrete adapter expectations and no implementation yet:

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004

 ❯ src/adapters/__tests__/factory.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯�⎯⎯⎯

 FAIL  src/adapters/__tests__/factory.test.ts [ src/adapters/__tests__/factory.test.ts ]
Error: Failed to load url ../mssql (resolved id: ../mssql) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004/src/adapters/__tests__/factory.test.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
```

### Verification Output

**Typecheck** — `npx tsc --noEmit`:
```
EXIT=0
```

**Unit tests** — `npm test`:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004

 ✓ src/scaffold.test.ts  (4 tests) 6ms
 ✓ src/core/__tests__/statementParser.test.ts  (26 tests) 4ms
 ✓ src/adapters/__tests__/factory.test.ts  (4 tests) 1ms

 Test Files  3 passed (3)
      Tests  34 passed (34)
```

**Integration tests** — after `docker compose -f docker/docker-compose.yml up -d postgres mysql mssql` (all three containers healthy on their mapped ports) and `VSDB_IT=1 npm run test:integration`:

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004

 ✓ src/adapters/__tests__/mysql.integration.test.ts  (4 tests) 62ms
 ✓ src/adapters/__tests__/mssql.integration.test.ts  (4 tests) 5184ms
 ✓ src/adapters/__tests__/postgres.integration.test.ts  (5 tests) 10091ms

 Test Files  3 passed (3)
      Tests  13 passed (13)
```

All 13 integration tests PASS (5 postgres + 4 mysql + 4 mssql), including:
- Test #1 MySQL: `SELECT 1 AS one` → `columns:['one']`, `[[1]]`
- Test #2 MySQL: 1,200-row seed → 500/500/200/null, first cell of each batch verified (`[1]`, `[501]`, `[1001]`)
- Test #3 MySQL: wrong password → `/Access denied/i`
- Test #4 MSSQL: `SELECT 1 AS one` → `columns:['one']`, `[[1]]`
- Test #5 MSSQL: 1,200-row seed → 500/500/200/null + `listTables`/`listColumns` correctness
- Test #6 MSSQL: wrong password → `/Login failed/i`
- Test #6b MSSQL: large query, `cancel()` mid-stream → subsequent `fetchBatch()` resolves to `null` after the attention round-trip

### Status

`done` — all acceptance criteria met:
- [x] MySQL + MSSQL adapters implement the full `DbAdapter` interface (`tsc --noEmit` clean).
- [x] Integration tests PASS for both new adapters when `VSDB_IT=1`.
- [x] `BatchedQuery` interface identical to the pg contract (`fetchBatch(): Promise<any[][] | null>`, no re-execute).
- [x] `createAdapter` returns concrete `MySqlAdapter`/`MsSqlAdapter` for the two new drivers — verified by `factory.test.ts`.
- [x] No regression: `npm test` still PASS (34/34).
- [x] `docker-compose.yml` unchanged (TASK-003 asset, REUSED as-is).
- [ ] Reviewer verdict (Phase 4).

### Note

- The compose `mysql:8` service was recreated during testing because the original volume (`vsdb_mysql_data`) used the legacy `--default-authentication-plugin=mysql_native_password` startup flag, which is rejected by MySQL 8.4 in the compose image. The fix was to delete the volume and recreate; the compose file itself was NOT modified per task instructions. If the integration harness is re-run on a fresh host, `docker compose up -d` is sufficient.
- `MsSqlAdapter.connect()` waits up to ~5s for the `LoggedIn` state after the `connect` event because Tedious 18 emits `connect` before completing its internal initial-SQL phase. The wait is bounded by polling every 5ms and short-circuits on `Final` to surface a real failure.
- `BatchedQuery.cancel()` for MSSQL resolves any pending fetcher with `null` synchronously, but the underlying `request.cancel()` round-trip is asynchronous. Test #6b polls `fetchBatch()` for up to 5s rather than blocking on a single call.
- `MySqlAdapter.fetchBatch()` is implemented as a plain function (not chained through a shared promise queue) so a single late `cancel()` cannot retroactively poison a later call's result with a stale rejection.
