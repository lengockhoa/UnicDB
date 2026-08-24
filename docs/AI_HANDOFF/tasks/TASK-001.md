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

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
