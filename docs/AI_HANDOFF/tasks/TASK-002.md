# TASK-002 — Host-tool bridge (set_host_tools ↔ ToolRegistry)

## Goal
Biến DbToolRegistry (cycle K) thành host tools cho omp: defs payload cho `set_host_tools` + executor nhận host_tool_call, chạy qua registry (read-only guard giữ nguyên trong VSDB), trả result/error string.

## Target Files
- `src/ai/omp/hostTools.ts` (mới)
- `src/ai/omp/__tests__/hostTools.test.ts` (mới)

## Spec (frozen)
```ts
import type { ToolRegistry, AgentTool } from "../agent";
export function hostToolDefsFromRegistry(registry: ToolRegistry): Record<string, unknown>[]
// mỗi item: { name, description, parameters } — passthrough từ AgentTool (frozen shape cycle J)
export function createHostToolExecutor(registry: ToolRegistry): (name: string, args: unknown) => Promise<string>
// - unknown tool → "Unknown tool: <name>"
// - args không phải object/JSON-serializable → "Invalid tool arguments"
// - tool.execute throw → "Tool failed: <msg>" (không rethrow)
// - execute thành công → trả nguyên string result
```
- KHÔNG sửa registry/tools cycle K. Guard read-only của `run_sql` chạy ở trong tool execute — bridge không bypass được (test chứng minh bằng DROP TABLE).
- Không import vscode.

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | defs từ registry thật (createDbTools + createSqlTool, fake adapterFactory) | mảng có name/description/parameters đúng 3 tool |
| 2 | happy | executor gọi list_tables với fake factory | JSON string từ fake adapter |
| 3 | edge (unknown) | name không có trong registry | "Unknown tool: x" |
| 4 | edge (args) | args string/number thay vì object | "Invalid tool arguments" |
| 5 | edge (throw) | tool throw | "Tool failed: boom" |
| 6 | regression (guard) | run_sql qua host executor với "DROP TABLE t" | tool RESOLVE với reject reason string (guard trả message, không throw); fake adapter runQuery KHÔNG được gọi |
| 7 | regression (guard) | run_sql "SELECT 1" qua executor với fake adapter có cursor | fetchBatch được gọi, JSON rows |

## Test Files
`src/ai/omp/__tests__/hostTools.test.ts`

## Verification Commands
```
npx vitest run src/ai/omp/__tests__/hostTools.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 7 test PASS RED→GREEN (output thật)
- [ ] Không sửa src/ai/agent.ts hay src/ai/tools/* (chỉ import)
- [ ] Guard test #6 chứng minh DML không bao giờ tới adapter qua bridge
- [ ] `npx tsc --noEmit` sạch

## Interfaces
- Consumes: `ToolRegistry`/`AgentTool` (frozen), `createDbTools`/`createSqlTool`/`AdapterFactory` (cycle K).
- Produces: `hostToolDefsFromRegistry`, `createHostToolExecutor` (T4 consume; T1's OmpRpcClient.handleHostToolCall consumes executor shape).
