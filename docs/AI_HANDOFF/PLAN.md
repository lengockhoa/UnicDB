# PLAN — Hiển thị tất cả schema trong Schema Explorer

Cycle: 2026-08-21-B · Base: main · Planner: orchestrator (unic-smart)

## §1 Intent

**Vấn đề:** Schema Explorer chỉ hiện objects của schema mặc định mỗi driver (Postgres → `public`, MySQL → database đang connect, MSSQL → `dbo`). User có nhiều schema (vd Postgres: `information_schema`, `pg_catalog`, schema nghiệp vụ riêng) nhưng không thấy hết.

**Success definition:** Mở rộng một connection trong tree → thấy **mọi schema** user có thể truy cập (đã lọc system schema noise), mỗi schema mở ra có Tables / Views / Routines; generate SELECT + copy qualified name hoạt động với object thuộc schema bất kỳ. Cache không phá vỡ khi cùng connection có nhiều schema.

## §2 Scope

**In scope:**
- Thêm `listSchemas(includeSystem: boolean)` vào `DbAdapter` + 3 adapter (pg/mysql/mssql). Adapter vscode-free — setting do caller (tree) đọc và truyền tham số.
- Thêm node "schema" vào tree: connection → schema → category (Tables/Views/Routines) → object.
- `schemaTree.ts` getChildren truyền schema từ node.meta vào `listTables/ListViews/listRoutines(schema)`; đọc setting `vsdb.hideSystemSchemas` (default true) → gọi `listSchemas(!hideSystemSchemas)`.
- Cache key thêm schema: `category|<connId>|<schema>|<category>`.
- Cập nhật fake DbAdapter trong các test file dùng interface (connectionForm/statusBar/queryRunner/connectionManager tests) — thuộc TASK-103 (chung đợt sửa tree, mọi fake cần listSchemas stub).
- Setting `vsdb.hideSystemSchemas` (default true): true → includeSystem=false → lọc `pg_*`/`information_schema` (PG), `mysql`/`information_schema`/`performance_schema`/`sys` (MySQL), `sys`/`INFORMATION_SCHEMA`/`guest`/`db_*` (MSSQL); false → trả mọi schema kể cả system.

**Out of scope:**
- Đổi listColumns (đã nhận schema tường minh).
- UI khác (results panel, connection form).
- Search/filter object tree, DDL button, toolbar actions của DataGrip — cycle này chỉ tree structure + badges.

**File ownership (không task cùng wave share file):**
- W1: TASK-101 (types.ts + 3 adapter + adapter tests), TASK-102 (package.json settings) — disjoint files.
- W2: TASK-103 (schemaTree.ts + schemaTree.test.ts + fake adapters in tests) — phụ thuộc TASK-101 interface.

## §3 Approach

**Nguyên tắc:** tham khảo DataGrip explorer: connection → schema list (master/prd/prd_kpoint/public/qas) → object folders (tables/views/routines) với count badge; table list dưới từng schema. Schema trở thành cấp node thật thay vì tham số mặc định ngầm.

1. `DbAdapter.listSchemas(includeSystem: boolean): Promise<SchemaInfo[]>` — `SchemaInfo = { name: string }`:
   - Postgres: `SELECT nspname FROM pg_namespace ... ORDER BY 1`; khi `includeSystem=false` thêm `nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`.
   - MySQL/MariaDB: `SELECT schema_name FROM information_schema.schemata`; khi false lọc `mysql`, `information_schema`, `performance_schema`, `sys`.
   - MSSQL: `SELECT name FROM sys.schemas`; khi false lọc `sys`, `INFORMATION_SCHEMA`, `guest`, `db_%`.
2. Tree: node "schema" (contextValue `schema`, icon `$(symbol-namespace)`) giữa connection và category. Category node lưu `meta.schema` và có count badge trong `description` sau khi load list (vd `tables 109`).
3. `SchemaTreeProvider` đọc `vsdb.hideSystemSchemas` từ configuration khi load schemas; gọi `adapter.listSchemas(!hideSystemSchemas)`. Adapter KHÔNG import vscode.
4. Category children gọi `adapter.listTables(schema)`, `listViews(schema)`, `listRoutines(schema)` tường minh.
5. Cache: `schemas|<connId>|includeSystem=<0|1>` và `category|<connId>|<schema>|<category>` — không trộn category giữa schema khác nhau.

**Trade-offs:**
- Count badge lấy từ list đã load, không query `COUNT(*)` riêng — zero extra DB roundtrip; count hiện khi category đã expand/load, đủ cho cycle này.
- Lọc system schema ở SQL WHERE (không JS): ít data qua wire; đổi lại mỗi driver có điều kiện riêng.
- Không thêm toolbar/search như DataGrip: scope nhỏ, đúng ask chính là thấy đủ schemas/objects.

**Alternatives rejected:**
- Group object theo schema prefix (`public.users`) trong category hiện có: không giống DataGrip, khó đọc khi nhiều schema.
- Flat list mọi object mọi schema: không scale, mất cấu trúc schema.


## §4 Test Plan

1. Postgres mock 2 schema (`public`, `app`) → getChildren(connection) trả 2 schema node đúng label thứ tự alphabet.
2. Expand schema node → 3 category node (Tables/Views/Routines) như DataGrip object folders.
3. Expand Tables của schema `app` → gọi `adapter.listTables("app")` (spy) → category description/count cập nhật `2`, table node có objectKey `conn.app.users`.

**Edge (loại khác nhau):**
4. Adapter trả [] schemas (DB rỗng/user không có quyền) → node "no schemas" không expand, KHÔNG throw.
5. `vsdb.hideSystemSchemas=false` → tree gọi `listSchemas(true)`; true/default → gọi `listSchemas(false)`.
6. Cache: expand 2 schema của cùng connection → 2 entry category cache riêng; sau refresh() cache trống.
7. (regression) Object thuộc schema không phải default vẫn generate SELECT `schema.table` + copy qualified name đúng.

**Unit tests chạy bằng vitest với fake adapter (pattern schemaTree.test.ts hiện có). Integration tests (docker DB thật) không bắt buộc trong wave — adapter query được review bằng mắt + integration test file được cập nhật signature song song.**

## §5 Verification Commands

```bash
npx tsc --noEmit
npx vitest run src/ui/__tests__/schemaTree.test.ts src/adapters/__tests__/
npx vitest run   # full suite regression
npm run compile  # esbuild 3 bundles
```

## §6 Acceptance Criteria

- [ ] `npx tsc --noEmit` pass
- [ ] `npx vitest run` — tất cả file pass, gồm test mới schema-tree + adapter
- [ ] Postgres connection thật (nếu có docker) mở tree → thấy ≥ public + schemas khác (không chỉ public)
- [ ] Object trong schema bất kỳ: right-click → Generate SELECT / Copy Qualified Name dùng `schema.table`
- [ ] Cache 60s vẫn hoạt động; refresh() clear
- [ ] Default behavior (hideSystemSchemas=true) không hiện pg_*/information_schema/mysql/sys

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Plan Review Log

### Round 1 — Issues Found
- major: `listSchemas()` needed an explicit config channel. Fixed by changing contract to `listSchemas(includeSystem: boolean)`; SchemaTreeProvider reads `vsdb.hideSystemSchemas` and passes `includeSystem = !hideSystemSchemas`.
- low: clarified default non-system filtering vs include-system toggle.
- low: assigned fake DbAdapter test files to TASK-103.
- low: removed vague extension.ts contextValue/when scope.
- user refinement: DataGrip-style explorer includes schema list and category count badges; plan now includes category description/count after list load.

### Round 2 — Approved
- independent reviewer approved revised plan.

