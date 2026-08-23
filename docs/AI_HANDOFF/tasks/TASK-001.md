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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecK-T001
SUMMARY: Implemented `src/ai/tools/registry.ts` (`DbToolRegistry` + `createDbTools`) and `src/ai/tools/schemaTools.ts` (`createListTablesTool` + `createDescribeTableTool`) to frozen spec; 7/7 TDD cases pass; `npx tsc --noEmit` clean; no vscode imports; frozen cycle-J + types.ts files untouched.
TEST_PLAN_FOLLOWED: task §4 — all 7 cases implemented as RED→GREEN (paste below).
FILES_CHANGED:
  - src/ai/tools/registry.ts (new): DbToolRegistry class (register/list/get) + createDbTools
  - src/ai/tools/schemaTools.ts (new): createListTablesTool + createDescribeTableTool
  - src/ai/tools/__tests__/registry.test.ts (new): tests #6 + #7
  - src/ai/tools/__tests__/schemaTools.test.ts (new): tests #1–#5
TESTS_ADDED:
  - src/ai/tools/__tests__/registry.test.ts: "test #6 register/list/get", "test #7 createDbTools + runAgent 2-step loop"
  - src/ai/tools/__tests__/schemaTools.test.ts: "test #1 list_tables happy", "test #2 describe_table happy", "test #3 null factory", "test #4 NotImplementedError", "test #5 generic Error"
VERIFICATION:
  command: npx vitest run src/ai/tools/__tests__/registry.test.ts src/ai/tools/__tests__/schemaTools.test.ts && npx tsc --noEmit
  result: 7 pass / 0 fail, tsc exit 0
  RED_OUTPUT_excerpt: |
    FAIL src/ai/tools/__tests__/registry.test.ts [ src/ai/tools/__tests__/registry.test.ts ]
    Error: Failed to load url ../registry (resolved id: ../registry) ...
    FAIL src/ai/tools/__tests__/schemaTools.test.ts [ src/ai/tools/__tests__/schemaTools.test.ts ]
    Error: Failed to load url ../schemaTools (resolved id: ../schemaTools) ...
    Test Files  2 failed (2)
         Tests  no tests
  GREEN_OUTPUT_excerpt: |
    RUN  v1.6.1
     ✓ src/ai/tools/__tests__/schemaTools.test.ts  (5 tests) 3ms
     ✓ src/ai/tools/__tests__/registry.test.ts  (2 tests) 3ms
     Test Files  2 passed (2)
          Tests  7 passed (7)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — both files complete, target tests green, no shared-file conflicts.
NEXT: ready for review (T002 owns sqlTool.ts + schemaContext.ts; no shared file with T1 besides frozen types.ts).
