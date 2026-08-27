# TASK-001 — Full-DB structure builder + export_structure agent tool

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D1/D4, §4 T1

## Goal

Pure builder `buildDatabaseStructure` renders the whole-DB DDL (multi-schema: tables + views) from introspection results, and the agent tool `export_structure` lets the model fetch the full-DB context on demand (when the system prompt is cut by the budget).

## Target Files

- `src/ui/exportStructure.ts` — add `buildDatabaseStructure(db: DatabaseStructureInput): string` (same pure-builder file, NO vscode import).
- `src/ai/tools/schemaTools.ts` — add `createExportStructureTool(f: AdapterFactory): AgentTool` (name `export_structure`, no-args).
- `src/ui/__tests__/exportStructure.test.ts` — test builder (append describe block).
- `src/ai/tools/__tests__/schemaTools.test.ts` — test tool (append describe block).

## Spec (exact, to prevent the executor from inventing its own shape)

```ts
// src/ui/exportStructure.ts — ADD (keep existing exports intact):
import type {
  SchemaInfo, TableInfo, ViewInfo, TableDetail,
} from "../adapters/types";

export interface DatabaseStructureInput {
  schemas: Array<{ name: string }>;            // SchemaInfo-shape
  tables: Array<{ schema: string; name: string }>;   // TableInfo-shape, every schema already flattened
  views:  Array<{ schema: string; name: string }>;   // ViewInfo-shape
  /** Key "schema.table" → column list cho table/view. */
  columns: Record<string, ExportColumn[]>;
}

/** Render full-DB DDL text. Pure, deterministic. */
export function buildDatabaseStructure(db: DatabaseStructureInput): string;
```

Render contract (each line locked by tests):
1. Header: `-- Database structure (${schemas.length} schemas, ${tables.length} tables, ${views.length} views)`.
2. Per schema (in `schemas` order): the line `-- Schema: <name>` (the identifier is NOT quoted inside the comment).
3. Per table (in `tables` order filtered by schema): call `buildTableStructure(schema, name, columns[key] ?? [])` again — key lookup `"${schema}.${name}"`, missing → empty columns.
4. Per view: call `buildViewStructure(schema, name, columns[key] ?? [])` again.
5. Blocks separated by blank lines. Empty DB → just the header (no schema lines).

```ts
// src/ai/tools/schemaTools.ts — ADD:
export function createExportStructureTool(f: AdapterFactory): AgentTool;
// name: "export_structure"
// description: "Export the FULL database structure (all schemas, tables, views) as CREATE TABLE DDL text. Use when the schema summary above is truncated or when you need complete context to advise the user."
// parameters: { type: "object", properties: {} }  (no required)
// execute():
//   adapter = await f(); null → NO_CONNECTION_MSG ("No active connection. Connect to a database first, then retry.")
//   PG-only introspection: schemas = await adapter.listSchemas(false)
//     per schema: tables = await adapter.listTables(s.name); views = await adapter.listViews(s.name)
//     per table/view: cols = await adapter.listColumns(name, schema) → map to ExportColumn
//       {name, dataType, nullable, isPrimaryKey}
//   NotImplementedError → return the PG_ONLY_EXPORT_MSG string
//     ("export_structure is only supported for PostgreSQL connections.")
//   Track errors per-object (listColumns throw) → skip object, count it as skipped.
//   Return: JSON.stringify({ ddl, schemas: N, tables: N, views: N, skipped: N })
//   Other throws → `Tool failed: <msg>` (keep the existing execute pattern).
```

Note on introspection: `listColumns(table, schema)` — signature follows DbAdapter (types.ts:97). `listSchemas(false)` filters out system schemas (PG adapter filters via SYSTEM_SCHEMAS).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | builder: 2 schemas, tables + views → header + DDL blocks | `-- Database structure (2 schemas, 3 tables, 1 views)` + `-- Schema: public` + `CREATE TABLE public.users (` ... + view block containing `-- View structure` | input 2 schemas, 3 tables (public.users, public.orders, sales.deals), 1 view, columns map fully populated |
| 2 | unit | tool: execute returns JSON with ddl + counts | parse JSON → `ddl` contains the header line, `schemas===2`, `tables===3`, `views===1`, `skipped===0` | fake adapter (schemaTools.test.ts pattern): listSchemas→[{public},{sales}], listTables/listViews/listColumns mock |
| 3 | edge | builder: empty DB (0 schemas/tables/views) | returns exactly 1 line header `(0 schemas, 0 tables, 0 views)`, no schema/table blocks | empty input |
| 4 | edge | tool: mysql adapter throws NotImplementedError | returns the string `"export_structure is only supported for PostgreSQL connections."` (NOT as JSON, does NOT throw) | fake adapter listSchemas rejects with NotImplementedError |
| 5 | edge | tool: 1 table listColumns throws → skipped=1, remaining still rendered | JSON has `skipped===1`, ddl still contains the remaining table | fake adapter: listColumns throws only for "orders" |
| 6 | edge | tool: factory null → no-connection msg | return `"No active connection. Connect to a database first, then retry."` | factory resolves null |
| 7 | regression | tool + registry wiring does not change list_tables/describe_table behaviour | existing tests in the file still pass (existing tools are NOT modified) | full file run |

## Test Files

- `src/ui/__tests__/exportStructure.test.ts` — append `describe("buildDatabaseStructure — full-DB builder", ...)` (#1, #3).
- `src/ai/tools/__tests__/schemaTools.test.ts` — append `describe("export_structure tool", ...)` (#2, #4, #5, #6).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/exportStructure.test.ts src/ai/tools/__tests__/schemaTools.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] All tests in §Test Cases PASS (RED first, then GREEN).
- [ ] `src/ui/exportStructure.ts` still does NOT import vscode.
- [ ] The tool description clearly notes when to use it (i.e. when the context gets truncated).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `buildTableStructure(schema: string, table: string, columns: ExportColumn[]): string`; `buildViewStructure(schema: string, view: string, columns: ExportColumn[]): string`; `ExportColumn { name; dataType; nullable; isPrimaryKey? }` (src/ui/exportStructure.ts, already present); `AdapterFactory` (src/ai/tools/types.ts); `AgentTool` (src/ai/agent.ts); `NotImplementedError` (src/adapters/types.ts); DbAdapter methods `listSchemas(false)`, `listTables(schema)`, `listViews(schema)`, `listColumns(table, schema)`.
- Produces: `buildDatabaseStructure(db: DatabaseStructureInput): string`; `DatabaseStructureInput { schemas; tables; views; columns: Record<string, ExportColumn[]> }` (consumed by TASK-002 + TASK-004); `createExportStructureTool(f: AdapterFactory): AgentTool` — TASK-002 registers it into the registry.

---

## Discussion

(no comment yet)

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
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW Executor Report.
-->

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/exportStructure.test.ts src/ai/tools/__tests__/schemaTools.test.ts
  result: 18 pass / 0 fail / exit 0
  command: npx tsc --noEmit
  result: exit 0 (clean)
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/tools/schemaTools.ts:140 — `tables` count in JSON includes tables whose `listColumns` threw (skipped). Count reflects discovery, not render. Acceptable for consumer code (TASK-002/004) since `skipped` field provides the delta, but semantically `tables` could be confusing. Consider documenting this in the tool description or changing `tables` to count only successfully-rendered objects if consumers expect DDL-length consistency.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Clean implementation. All 7 test cases covered with real assertions. RED→GREEN evidence provided. No vscode import. Builder is pure/deterministic. Tool error policy (null/NotImplementedError/generic) follows established patterns. Minor semantic note on table count vs render count.
