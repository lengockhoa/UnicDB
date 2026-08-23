# TASK-001 — DB tool registry + introspection tools

## Goal
ToolRegistry thật cho agent: class `DbToolRegistry` + 2 introspection tools (`list_tables`, `describe_table`) ăn adapter qua injected async factory.

## Target Files
- `src/ai/tools/registry.ts` (mới)
- `src/ai/tools/schemaTools.ts` (mới)
- `src/ai/tools/__tests__/registry.test.ts`, `src/ai/tools/__tests__/schemaTools.test.ts` (mới)

## Spec (frozen)
```ts
import type { ToolRegistry, AgentTool } from "../agent";
import type { DbAdapter } from "../../adapters/types";
import type { AdapterFactory } from "./types"; // async () => Promise<DbAdapter | null> — đã có sẵn src/ai/tools/types.ts, KHÔNG tạo lại
export class DbToolRegistry implements ToolRegistry { register(tool: AgentTool): void; list(): AgentTool[]; get(name: string): AgentTool | undefined }
export function createDbTools(adapterFactory: AdapterFactory): DbToolRegistry // register list_tables + describe_table (run_sql do TASK-002 add vào bằng register() riêng ở caller — T1 không tạo run_sql)
// schemaTools.ts
export function createListTablesTool(f: AdapterFactory): AgentTool   // name "list_tables", args {schema?: string}
export function createDescribeTableTool(f: AdapterFactory): AgentTool // name "describe_table", args {schema: string, table: string}
```
- `list_tables` → `const adapter = await f();` null → no-connection msg; else `adapter.listTables(schema)` → JSON `[{"schema","name"}]` compact.
- `describe_table` → guard driver: dùng `adapter.listTableDetail(schema, table)` (PG-only; NotImplementedError từ mysql/mssql adapter phải bắt → error string "describe_table is only supported for PostgreSQL connections"); parse rows → JSON columns+constraints gọn.
- Adapter throw → `"Tool failed: <message>"` (không rethrow — agent loop tiếp tục).
- Tool `parameters`: JSON schema thật (object với properties + required).

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | list_tables trả bảng từ fake adapter | JSON string parse ra đúng mảng từ listTables() |
| 2 | happy | describe_table PG trả columns+constraints | JSON có columns array từ listTableDetail fake |
| 3 | edge (null) | factory resolve null → message no active connection | Chuỗi chứa "No active connection", không throw |
| 4 | edge (driver) | describe_table throw NotImplementedError | Chuỗi chứa "only supported for PostgreSQL" |
| 5 | edge (throw) | adapter throw Error("boom") | "Tool failed: boom" |
| 6 | unit | DbToolRegistry register/list/get | list() đúng thứ tự register; get unknown → undefined |
| 7 | regression | createDbTools + runAgent 2-bước tool loop | runAgent với fake provider (tool_call rồi answer) chạy qua registry thật, finalText đúng |

## Test Files
`src/ai/tools/__tests__/registry.test.ts`, `src/ai/tools/__tests__/schemaTools.test.ts`

## Verification Commands
```
npx vitest run src/ai/tools/__tests__/registry.test.ts src/ai/tools/__tests__/schemaTools.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 7 test PASS RED→GREEN (paste output thật)
- [ ] Không import vscode trong src/ai/tools/*
- [ ] Không sửa file cycle J (agent.ts/provider.ts/settings.ts/config.ts) và KHÔNG sửa src/ai/tools/types.ts (đã freeze sẵn)
- [ ] `npx tsc --noEmit` sạch

## Interfaces
- Consumes: `ToolRegistry`/`AgentTool` (src/ai/agent.ts — frozen), `AdapterFactory` (src/ai/tools/types.ts — frozen sẵn), `DbAdapter.listTables/listTableDetail` (src/adapters/types.ts).
- Produces: `DbToolRegistry`, `createDbTools`, `createListTablesTool`, `createDescribeTableTool` (T2, T3, T4 consume).
