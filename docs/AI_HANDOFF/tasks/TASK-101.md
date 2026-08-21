# TASK-101 — listSchemas() cho 3 adapter

Status: ready
Owner: claude-code
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Thêm `listSchemas(includeSystem: boolean): Promise<SchemaInfo[]>` vào `DbAdapter` interface và cả 3 adapter (postgres/mysql/mssql). Adapter không đọc VS Code config; caller truyền `includeSystem`.

## Target Files

- `src/adapters/types.ts` — thêm `SchemaInfo` interface + method `listSchemas(includeSystem: boolean)` vào `DbAdapter`
- `src/adapters/postgres.ts` — implement: query pg_namespace; `includeSystem=false` lọc pg_% + information_schema
- `src/adapters/mysql.ts` — implement: information_schema.schemata; `includeSystem=false` lọc mysql/information_schema/performance_schema/sys
- `src/adapters/mssql.ts` — implement: sys.schemas; `includeSystem=false` lọc system (sys, INFORMATION_SCHEMA, guest, db_*)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | postgres listSchemas(false) lọc system | query chứa `NOT LIKE` + `<> 'information_schema'`; mock rows → trả SchemaInfo[] |
| 2 | unit | postgres listSchemas(true) KHÔNG lọc | query không chứa điều kiện lọc pg_ |
| 3 | unit | mysql listSchemas(false) lọc 4 system schema | kết quả không chứa mysql/information_schema/performance_schema/sys |
| 4 | unit | mssql listSchemas(false) loại sys/INFORMATION_SCHEMA | tương tự |
| 5 | edge | listSchemas trả 0 row | resolve [] (không throw) |

## Test Files

- `src/adapters/__tests__/schemas.test.ts` (mới) — mock query layer từng adapter, spy chuỗi SQL

## Verification Commands

```bash
cd .worktrees/task-101 && npx tsc --noEmit && npx vitest run src/adapters/__tests__/schemas.test.ts && npx vitest run
```

## Acceptance Criteria

- [ ] DbAdapter có listSchemas; 3 adapter implement; TS biên dịch
- [ ] Test mới pass (RED trước, GREEN sau)
- [ ] Full suite không regression

## Dependencies

(none)

## Interfaces

Produces: `SchemaInfo = { name: string }`; `listSchemas(includeSystem: boolean): Promise<SchemaInfo[]>` trên DbAdapter.

## Discussion

### 2026-08-21 · planner · unic-smart
Config `vsdb.hideSystemSchemas` do `SchemaTreeProvider` đọc và chuyển thành `includeSystem = !hideSystemSchemas`; adapter giữ thuần, không import vscode.

## Executor Report

### 2026-08-22 · executor · unic-code

EXECUTOR_MODEL: unic-code

Status: PASS

RED_OUTPUT: `npx vitest run src/adapters/__tests__/schemas.test.ts` → 9/9 fail, `TypeError: adapter.listSchemas is not a function` (feature missing, đúng mode).

Implementation notes:
- `SchemaInfo { name }` + `DbAdapter.listSchemas(includeSystem: boolean)` trong types.ts.
- Postgres: SQL-level filter — `WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'` khi includeSystem=false; query qua `pg_namespace`.
- MySQL: query `information_schema.schemata`; includeSystem=false lọc client-side 4 schema (`mysql`/`information_schema`/`performance_schema`/`sys` — `Record<string, true>` theo repo convention) để test mock-layer (row cố định) xác minh được contract kết quả.
- MSSQL: query `sys.schemas`; includeSystem=false lọc client-side `sys`/`INFORMATION_SCHEMA`/`guest`/`db_*` (cùng lý do).
- Ripple: factory.test.ts duck-type thêm listSchemas; connectionForm.test.ts fakeAdapter thêm stub (bắt buộc cho tsc — return type được annotate là DbAdapter). Các fake còn lại (connectionManager/queryRunner/schemaTree/statusBar) dùng cast `as unknown` — TASK-103 phụ trách cập nhật đồng bộ.

Verification Output:
1. `npx tsc --noEmit` → PASS (0 error).
2. `npx vitest run src/adapters/__tests__/schemas.test.ts` → 9/9 pass.
3. `npx vitest run` → 15 files, 149/149 pass (stderr của resultsPanel.test.ts là output kỳ vọng của chính test đó).

Acceptance: DbAdapter có listSchemas; 3 adapter implement; TS biên dịch; test mới RED trước GREEN sau; full suite không regression.

## Reviewer Verdict

### 2026-08-22 · reviewer · unic-smart

VERDICT: approved
REVIEWER_MODEL: unic-smart
VERIFICATION_RERUN: PASS (`npx tsc --noEmit && npx vitest run src/adapters/__tests__/schemas.test.ts && npx vitest run`)
BLOCKING: none
NOTES: Adapter interface, PostgreSQL/MySQL/MSSQL listSchemas implementations, schema tests, and fake adapter updates reviewed against TASK-101; no blocking defects found.

