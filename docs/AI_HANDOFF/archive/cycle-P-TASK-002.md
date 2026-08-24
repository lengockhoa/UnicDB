# TASK-002 — Builtin engine: stream tool-call step lines live

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 Slice 2

## Goal

Builtin engine (Cycle N) streams text deltas but tool calls surface only after the whole
step (model reply + tool execution) completes — a running multi-tool turn looks frozen.
Add one additive agent-loop callback firing immediately before each tool executes; the
panel posts a live `step` line per call. Do NOT restructure the agent loop.

## Target Files

- `src/ai/agent.ts` — `AgentCallbacks` (~line 78-89): add `onToolCall?`; fire in the tool
  loop (`for (const call of result.toolCalls)`, ~line 259) immediately before
  `executeToolCall`. No other loop change.
- `src/ui/aiChatPanel.ts` — `runBuiltinTurn` callbacks (~lines 341-356): add
  `onToolCall: (call) => { if (token?.aborted) return; this.post({type:"step", label: call.name || "tool"}); }`;
  DELETE the dead tool-step branch in `onStep` (~lines 399-406) so each call posts exactly
  once (clean cutover). ACP engine path untouched.
- `src/ai/__tests__/agent.test.ts` — cases 1-4
- `src/ai/__tests__/agentStream.test.ts` — case 5 (stream-path interplay)
- `src/ui/__tests__/aiChatPanel.test.ts` — cases 6-9

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | onToolCall fires once per call, before execution, in order | 2 tool calls → callback order `[a,b]`, each observed before its tool result message is appended | fake registry, provider returns both calls in one step |
| 2 | edge (absence) | no tool calls → callback never fires | call count 0 | provider returns plain text |
| 3 | edge (boundary) | empty tool name | callback still fires; panel posts label `"tool"` | `ToolCall{name:"", argumentsJson:"{}"}` |
| 4 | unit | missing onToolCall stays backward-compatible | run without the callback completes normally | existing deps, no callbacks |
| 5 | unit | stream path unaffected | with `streamComplete` wired, deltas stream and onToolCall still fires exactly per call | streaming fake provider (agentStream harness) |
| 6 | unit (panel) | live step line during builtin turn | one `{type:"step"}` posted per call BEFORE tool promise resolves; exactly N step posts total (no duplicate from onStep) | mocked deps per aiChatPanel harness, 1 tool call |
| 7 | edge (abort) | stop mid-tool-run | after token flip, no further step posts; no error bubble; done posted | abort inside tool execute |
| 8 | edge (fallback) | stream fallback label still posts once | `{type:"step", label:"stream fallback"}` exactly once when stream pre-fails | onStreamFallback harness |
| 9 | regression | assistant-only turn | no step message; existing `stepIdx < assistantIdx` ordering assertion (aiChatPanel.test.ts ~line 292-299) still green — update it only if the fixture relied on the deleted onStep branch, keeping the ordering invariant | existing case #2 |

## Test Files

- `src/ai/__tests__/agent.test.ts` — cases 1-4
- `src/ai/__tests__/agentStream.test.ts` — case 5
- `src/ui/__tests__/aiChatPanel.test.ts` — cases 6-9

## Verification Commands

```bash
npm run typecheck && npm test -- src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts src/ui/__tests__/aiChatPanel.test.ts
```

## Acceptance Criteria

- [ ] Cases 1-9 PASS fresh (RED pasted for new tests first)
- [ ] Agent loop shape unchanged except the single callback invocation
- [ ] Each tool call posts exactly one step line; deleted onStep branch leaves no duplicate
- [ ] ACP engine turn flow untouched (no edits outside runBuiltinTurn/onStep in panel)
- [ ] Full `npm test` green at wave boundary (819 baseline + new)

## Dependencies

- TASK-001 (same-file ownership of `src/ui/aiChatPanel.ts` — serialized wave 2)

## Interfaces

- Consumes: `AgentCallbacks` (`src/ai/agent.ts:78-89`), `ToolCall` (`src/ai/provider.ts:29-33`
  `{id,name,argumentsJson}`), existing `{type:"step"; label:string}` message
  (`src/ui/aiChatPanelMessages.ts:22-26`) — message shape unchanged.
- Produces: `onToolCall?(call: ToolCall): void` on `AgentCallbacks` — additive; fires once
  per call immediately before `executeToolCall`, in call order, on steps that have tool
  calls only, regardless of abort state (panel gates posting).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Contract decision: the callback fires even when `signal` is aborted — abort gating belongs to
the consumer (panel token), keeping the loop dumb and the hook testable. Executor must not
add abort checks inside the loop. → @executor


## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: ExecP-T002
SUMMARY: Added additive onToolCall(call: ToolCall) callback to AgentCallbacks; fired once per call, in order, immediately before executeToolCall, regardless of abort state. Wired into runBuiltinTurn with token-gated post; deleted dead onStep tool branch so each call posts exactly once. Cases 1-9 PASS fresh.
TEST_PLAN_FOLLOWED: task §4 (cases 1-9 in agent.test 1-4, agentStream 5, aiChatPanel 6-9)
FILES_CHANGED:
  - src/ai/agent.ts: AgentCallbacks.onToolCall added (line 89-93); for-of tool loop (line 259-264) calls callbacks?.onToolCall?.(call) immediately before executeToolCall. No other loop change.
  - src/ui/aiChatPanel.ts: runBuiltinTurn callbacks (line 342-366) adds onToolCall with token-aborted gate; onStep (line 408-413) reduced to no-op comment (dead tool branch deleted). ACP path untouched.
  - src/ai/__tests__/agent.test.ts: appended describe('runAgent — onToolCall callback (TASK-002)') with 4 cases.
  - src/ai/__tests__/agentStream.test.ts: appended describe('runAgent — stream + onToolCall interplay (TASK-002 case #5)') with 1 case.
  - src/ui/__tests__/aiChatPanel.test.ts: appended describe('AiChatPanel — TASK-002 live step lines') with cases 6-9; updated #2/#4/#4b fixtures to fire onToolCall (since deleted onStep branch).
TESTS_ADDED:
  - src/ai/__tests__/agent.test.ts: case #1 onToolCall fires once per call before execution in order; case #2 no tool calls → callback never fires; case #3 empty tool name → callback still fires; case #4 missing onToolCall backward-compat.
  - src/ai/__tests__/agentStream.test.ts: case #5 stream + onToolCall interplay.
  - src/ui/__tests__/aiChatPanel.test.ts: case #6 one step post per call before tool resolve; case #7 stop mid-tool-run; case #8 stream fallback label exactly once; case #9 assistant-only no step + ordering invariant.
VERIFICATION:
  command: npm run typecheck && npm test -- src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts src/ui/__tests__/aiChatPanel.test.ts
  result: 44 pass / 0 fail / exit 0
  output_excerpt: |
    ✓ src/ai/__tests__/agentStream.test.ts  (8 tests) 6ms
    ✓ src/ai/__tests__/agent.test.ts  (16 tests) 7ms
    ✓ src/ui/__tests__/aiChatPanel.test.ts  (20 tests) 8ms
    Test Files  3 passed (3)
         Tests  44 passed (44)
RED EVIDENCE (verbatim from prior turn, before impl):
  - src/ai/__tests__/agent.test.ts > case #1: expected spy called 2 times, but got 0 times
  - src/ai/__tests__/agent.test.ts > case #3: expected spy called 1 times, but got 0 times
  - src/ai/__tests__/agentStream.test.ts > case #5: expected spy called 2 times, but got 0 times
  - src/ui/__tests__/aiChatPanel.test.ts > case #8: expected length 1 but got 2 (fallback fired twice in fixture; corrected to fire once — agent contract is once per fallback)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — INDEX pending_review
NEXT: ready for review
---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm test -- src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts src/ui/__tests__/aiChatPanel.test.ts
  result: 44 pass / 0 fail (typecheck exit 0)
TEST_PLAN_COVERAGE: all-followed (cases 1-9 present; RED evidence verbatim real — vitest spy-count assertions, case 8 fixture double-fire caught and correctly fixed per agent.ts:147 once-per-fallback contract)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/__tests__/agentStream.test.ts:375 — file ends without trailing newline ("\ No newline at end of file"); cosmetic, add newline next touch.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Loop change is exactly one line (agent.ts:265) before executeToolCall, no abort check in loop per planner decision; panel onStep tool branch fully deleted, token gate at consumer; case #2 ordering invariant (stepIdx>-1, assistantIdx>stepIdx) preserved against new fixture — not weakened; ACP path untouched.
