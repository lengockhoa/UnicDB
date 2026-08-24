# TASK-001 — Full-DB structure builder + export_structure agent tool

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D1/D4, §4 T1

## Goal

Pure builder `buildDatabaseStructure` render DDL toàn DB (đa schema: tables + views) từ introspection results, và agent tool `export_structure` cho model tự lấy full-DB context (bù khi system prompt bị budget-cut).

## Target Files

- `src/ui/exportStructure.ts` — thêm `buildDatabaseStructure(db: DatabaseStructureInput): string` (cùng file pure builder, KHÔNG vscode import).
- `src/ai/tools/schemaTools.ts` — thêm `createExportStructureTool(f: AdapterFactory): AgentTool` (name `export_structure`, no-args).
- `src/ui/__tests__/exportStructure.test.ts` — test builder (append describe block).
- `src/ai/tools/__tests__/schemaTools.test.ts` — test tool (append describe block).

## Spec (chuẩn xác để executor không tự chế shape)

```ts
// src/ui/exportStructure.ts — THÊM (giữ nguyên các export hiện có):
import type {
  SchemaInfo, TableInfo, ViewInfo, TableDetail,
} from "../adapters/types";

export interface DatabaseStructureInput {
  schemas: Array<{ name: string }>;            // SchemaInfo-shape
  tables: Array<{ schema: string; name: string }>;   // TableInfo-shape, đã flatten mọi schema
  views:  Array<{ schema: string; name: string }>;   // ViewInfo-shape
  /** Key "schema.table" → column list cho table/view. */
  columns: Record<string, ExportColumn[]>;
}

/** Render full-DB DDL text. Pure, deterministic. */
export function buildDatabaseStructure(db: DatabaseStructureInput): string;
```

Render contract (test khóa từng dòng):
1. Header: `-- Database structure (${schemas.length} schemas, ${tables.length} tables, ${views.length} views)`.
2. Per schema (theo thứ tự `schemas`): line `-- Schema: <name>` (identifier KHÔNG quote trong comment).
3. Per table (thứ tự `tables` lọc theo schema): gọi lại `buildTableStructure(schema, name, columns[key] ?? [])` — key lookup `"${schema}.${name}"`, missing → empty columns.
4. Per view: gọi lại `buildViewStructure(schema, name, columns[key] ?? [])`.
5. Blocks cách nhau bằng blank line. Empty DB → chỉ header (không schema lines).

```ts
// src/ai/tools/schemaTools.ts — THÊM:
export function createExportStructureTool(f: AdapterFactory): AgentTool;
// name: "export_structure"
// description: "Export the FULL database structure (all schemas, tables, views) as CREATE TABLE DDL text. Use when the schema summary above is truncated or when you need complete context to advise the user."
// parameters: { type: "object", properties: {} }  (no required)
// execute():
//   adapter = await f(); null → NO_CONNECTION_MSG ("No active connection. Connect to a database first, then retry.")
//   PG-only introspection: schemas = await adapter.listSchemas(false)
//     mỗi schema: tables = await adapter.listTables(s.name); views = await adapter.listViews(s.name)
//     mỗi table/view: cols = await adapter.listColumns(name, schema) → map sang ExportColumn
//       {name, dataType, nullable, isPrimaryKey}
//   NotImplementedError → trả string PG_ONLY_EXPORT_MSG
//     ("export_structure is only supported for PostgreSQL connections.")
//   Tham vết errors per-object (listColumns throw) → skip object, đếm skipped.
//   Return: JSON.stringify({ ddl, schemas: N, tables: N, views: N, skipped: N })
//   Throw khác → `Tool failed: <msg>` (giữ pattern execute hiện có).
```

Note introspection: `listColumns(table, schema)` — signature theo DbAdapter (types.ts:97). `listSchemas(false)` loại system schemas (PG adapter lọc bằng SYSTEM_SCHEMAS).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | builder: 2 schemas, tables + views → header + DDL blocks | `-- Database structure (2 schemas, 3 tables, 1 views)` + `-- Schema: public` + `CREATE TABLE public.users (` ... + view block chứa `-- View structure` | input 2 schemas, 3 tables (public.users, public.orders, sales.deals), 1 view, columns map đủ |
| 2 | unit | tool: execute trả JSON có ddl + counts | parse JSON → `ddl` chứa header line, `schemas===2`, `tables===3`, `views===1`, `skipped===0` | fake adapter (pattern schemaTools.test.ts): listSchemas→[{public},{sales}], listTables/listViews/listColumns mock |
| 3 | edge | builder: empty DB (0 schemas/tables/views) | return đúng 1 line header `(0 schemas, 0 tables, 0 views)`, không schema/table blocks | input rỗng |
| 4 | edge | tool: mysql adapter throw NotImplementedError | return string `"export_structure is only supported for PostgreSQL connections."` (KHÔNG phải JSON, KHÔNG throw) | fake adapter listSchemas rejects NotImplementedError |
| 5 | edge | tool: 1 table listColumns throw → skipped=1, còn lại render | JSON có `skipped===1`, ddl vẫn chứa table còn lại | fake adapter: listColumns throw cho "orders" only |
| 6 | edge | tool: factory null → no-connection msg | return `"No active connection. Connect to a database first, then retry."` | factory resolves null |
| 7 | regression | tool + registry wiring không đổi hành vi list_tables/describe_table | các test cũ trong file vẫn pass (không sửa tool hiện có) | full file run |

## Test Files

- `src/ui/__tests__/exportStructure.test.ts` — append `describe("buildDatabaseStructure — full-DB builder", ...)` (#1, #3).
- `src/ai/tools/__tests__/schemaTools.test.ts` — append `describe("export_structure tool", ...)` (#2, #4, #5, #6).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/exportStructure.test.ts src/ai/tools/__tests__/schemaTools.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước, GREEN sau).
- [ ] `src/ui/exportStructure.ts` vẫn KHÔNG import vscode.
- [ ] Tool description nhắc rõ dùng khi context bị truncate.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `buildTableStructure(schema: string, table: string, columns: ExportColumn[]): string`; `buildViewStructure(schema: string, view: string, columns: ExportColumn[]): string`; `ExportColumn { name; dataType; nullable; isPrimaryKey? }` (src/ui/exportStructure.ts, hiện có); `AdapterFactory` (src/ai/tools/types.ts); `AgentTool` (src/ai/agent.ts); `NotImplementedError` (src/adapters/types.ts); DbAdapter methods `listSchemas(false)`, `listTables(schema)`, `listViews(schema)`, `listColumns(table, schema)`.
- Produces: `buildDatabaseStructure(db: DatabaseStructureInput): string`; `DatabaseStructureInput { schemas; tables; views; columns: Record<string, ExportColumn[]> }` (TASK-002 + TASK-004 tiêu thụ); `createExportStructureTool(f: AdapterFactory): AgentTool` — TASK-002 đăng ký vào registry.

---

## Discussion

(chưa có comment)

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec-T1
SUMMARY: Implemented `buildDatabaseStructure` (src/ui/exportStructure.ts) + `createExportStructureTool` (src/ai/tools/schemaTools.ts) with per-object skip on listColumns errors, appended 6 TDD tests covering all required cases (RED → GREEN), npx tsc --noEmit clean, no vscode import.
TEST_PLAN_FOLLOWED: task §Test Cases (#1, #2, #3, #4, #5, #6, #7)
FILES_CHANGED:
  - src/ui/exportStructure.ts: added DatabaseStructureInput + buildDatabaseStructure() per spec render contract
  - src/ai/tools/schemaTools.ts: added createExportStructureTool() with PG-only NotImplementedError handler, factory-null handler, and per-object skip-on-listColumns-throw with skipped counter
  - src/ui/__tests__/exportStructure.test.ts: appended describe("buildDatabaseStructure — full-DB builder", …) with #1 + #3
  - src/ai/tools/__tests__/schemaTools.test.ts: appended describe("export_structure tool", …) with #2 + #4 + #5 + #6
TESTS_ADDED:
  - src/ui/__tests__/exportStructure.test.ts: test #1 full DB: 2 schemas with tables + views; test #3 empty DB → header line only
  - src/ai/tools/__tests__/schemaTools.test.ts: test #2 execute returns JSON with ddl + counts; test #4 mysql NotImplementedError → PG-only message; test #5 one table listColumns throws → skipped=1, surviving table renders in ddl; test #6 factory null → no-connection message
VERIFICATION:
  command: npx vitest run src/ui/__tests__/exportStructure.test.ts src/ai/tools/__tests__/schemaTools.test.ts
  result: 18 pass / 0 fail / exit 0
  output_excerpt: |
     ✓ src/ui/__tests__/exportStructure.test.ts  (9 tests) 2ms
     ✓ src/ai/tools/__tests__/schemaTools.test.ts  (9 tests) 4ms
     Test Files  2 passed (2)
          Tests  18 passed (18)
  command: npx tsc --noEmit
  result: exit 0 (clean)
ISSUES: test #5 implementation required counting tables from listTables() (not just successfully-rendered objects) to keep `tables` count = 2 while `skipped` = 1 and only `users` appears in the ddl. This matches the §Test Cases expectation.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

### RED output (before implementation, captured)

```
FAIL  src/ui/__tests__/exportStructure.test.ts > buildDatabaseStructure — full-DB builder > test #1 full DB …
TypeError: buildDatabaseStructure is not a function
FAIL  src/ui/__tests__/exportStructure.test.ts > buildDatabaseStructure — full-DB builder > test #3 empty DB …
TypeError: buildDatabaseStructure is not a function
FAIL  src/ai/tools/__tests__/schemaTools.test.ts > export_structure tool > test #2 …
TypeError: createExportStructureTool is not a function
FAIL  src/ai/tools/__tests__/schemaTools.test.ts > export_structure tool > test #4 …
TypeError: createExportStructureTool is not a function
FAIL  src/ai/tools/__tests__/schemaTools.test.ts > export_structure tool > test #5 …
TypeError: createExportStructureTool is not a function
FAIL  src/ai/tools/__tests__/schemaTools.test.ts > export_structure tool > test #6 …
TypeError: createExportStructureTool is not a function
Tests  6 failed | 12 passed (18)
```

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
