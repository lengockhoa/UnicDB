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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecL-T002
SUMMARY: Created src/ai/omp/hostTools.ts with hostToolDefsFromRegistry (passthrough {name, description, parameters} per AgentTool) and createHostToolExecutor (lockstep error policy: unknown tool → "Unknown tool: …", non-object args → "Invalid tool arguments", tool throw → "Tool failed: <msg>", success returns the execute string verbatim). 7 RED→GREEN vitest tests cover defs shape, list_tables success, unknown tool, invalid args (string/number/null), tool throw, run_sql DROP TABLE regression (runQuery never called, guard reason returned), and SELECT 1 cursor path (fetchBatch + close fired, JSON rows).
TEST_PLAN_FOLLOWED: inline §Test Cases 1-7
FILES_CHANGED:
  - src/ai/omp/hostTools.ts: new — bridge functions
  - src/ai/omp/__tests__/hostTools.test.ts: new — 7 vitest tests
TESTS_ADDED:
  - src/ai/omp/__tests__/hostTools.test.ts: 7 it() cases (defs passthrough; list_tables success; unknown tool; invalid args x3; throw wraps; DROP TABLE regression; SELECT cursor path)
VERIFICATION:
  command: npx vitest run src/ai/omp/__tests__/hostTools.test.ts && npx tsc --noEmit
  result: 7 pass / 0 fail (exit 0); tsc clean
  output_excerpt: |
    ✓ src/ai/omp/__tests__/hostTools.test.ts  (7 tests) 4ms
    Test Files  1 passed (1)
         Tests  7 passed (7)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review (cycle L wave 1 sibling TASK-001 owns src/ai/omp/rpc.ts + process.ts; no shared file overlap)

