# TASK-002 — Host-tool bridge (set_host_tools ↔ ToolRegistry)

## Goal
Turn DbToolRegistry (cycle K) into host tools for omp: defs payload for `set_host_tools` + an executor that receives host_tool_call, runs through the registry (read-only guard stays inside VSDB), and returns a result/error string.

## Target Files
- `src/ai/omp/hostTools.ts` (new)
- `src/ai/omp/__tests__/hostTools.test.ts` (new)

## Spec (frozen)
```ts
import type { ToolRegistry, AgentTool } from "../agent";
export function hostToolDefsFromRegistry(registry: ToolRegistry): Record<string, unknown>[]
// each item: { name, description, parameters } — passthrough from AgentTool (frozen shape from cycle J)
export function createHostToolExecutor(registry: ToolRegistry): (name: string, args: unknown) => Promise<string>
// - unknown tool → "Unknown tool: <name>"
// - args not an object/JSON-serializable → "Invalid tool arguments"
// - tool.execute throws → "Tool failed: <msg>" (no rethrow)
// - execute succeeds → return the raw string result
```
- NO edits to cycle K registry/tools. The `run_sql` read-only guard runs inside tool execute — the bridge cannot bypass it (test proves it with DROP TABLE).
- No vscode import.

## Test Cases
| # | Type | Name | Expected |
|---|------|-----|----------|
| 1 | happy | defs from the real registry (createDbTools + createSqlTool, fake adapterFactory) | array has name/description/parameters for exactly 3 tools |
| 2 | happy | executor calls list_tables with fake factory | JSON string from the fake adapter |
| 3 | edge (unknown) | name not in registry | "Unknown tool: x" |
| 4 | edge (args) | args string/number instead of object | "Invalid tool arguments" |
| 5 | edge (throw) | tool throw | "Tool failed: boom" |
| 6 | regression (guard) | run_sql through host executor with "DROP TABLE t" | tool RESOLVES with the rejection reason string (guard returns the message, does not throw); fake adapter runQuery is NEVER called |
| 7 | regression (guard) | run_sql "SELECT 1" through executor with a fake adapter that has a cursor | fetchBatch is called, JSON rows |

## Test Files
`src/ai/omp/__tests__/hostTools.test.ts`

## Verification Commands
```
npx vitest run src/ai/omp/__tests__/hostTools.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 7 tests PASS RED→GREEN (real output)
- [ ] No edits to src/ai/agent.ts or src/ai/tools/* (import only)
- [ ] Guard test #6 proves DML never reaches the adapter via the bridge
- [ ] `npx tsc --noEmit` clean

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


## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart (config handoff.reviewer.model=unic-smart, matches)
EXECUTOR_MODEL: unic-code (differs — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/omp/__tests__/hostTools.test.ts && npx tsc --noEmit
  result: 7 pass / 0 fail; tsc exit 0 (fresh rerun by reviewer)
TEST_PLAN_COVERAGE: all-followed (7 rows → 7 its, real expect()s; RED independently reproduced by reviewer)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - docs/AI_HANDOFF/tasks/TASK-002.md:57 — Executor Report omits the RED_OUTPUT block required by RULES.md:153. Substance verified by reviewer instead: test file copied to isolated worktree at 954f954 fails with real module-not-found (exit 1, "Failed to load url ../hostTools"), proving tests preceded implementation. Future executors: paste the RED block.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Code clean — defs passthrough matches agent.ts toolDefs shape exactly (no execute leakage, key-set asserted); error strings lockstep with executeToolCall; bridge never touches adapter, guard test #6 asserts runQuery-not-called + exact guard reason. Frozen src/ai/agent.ts + src/ai/tools/* untouched (empty diff); no vscode import.
