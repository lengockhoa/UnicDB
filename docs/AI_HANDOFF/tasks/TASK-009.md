# TASK-009 — Claude Code chat engine (normalized events + image turn)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3(3), §4

## Goal

Build `ClaudeCodeChatEngine`, a panel-facing chat-level adapter that turns the TASK-005 process surface into the existing seven-callback agent event contract and forwards validated text/image turns to Claude Code.

## Target Files

- `src/ai/claudeCode/claudeCodeChatEngine.ts` (new) — chat-level glue.
- `src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts` (new) — unit tests with fake process/HostMcp.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | send text creates a turn and forwards all normalized callbacks | fake process receives `{text:"list tables"}`; caller sees exact onDelta/onThought/onToolStart/onToolEnd/onDone order | fake ClaudeCodeProcessHandle emits each event |
| 2 | edge (empty) | no attachments remains legacy text-only | process input has `attachments: undefined` (not `[]`/invented image block); text exactly preserved | `send("hello", events)` |
| 3 | edge (image boundary) | one validated image + text turn retains binary fields/order | process receives text plus `{mime:"image/png",base64:"..."}`; no base64 in trace/error output | small PNG fixture |
| 4 | edge (error path) | process reports error | engine calls `events.onError("...")` once and still settles; `onDone` follows only if process completion contract says so | fake rejected/error process |
| 5 | edge (lifecycle) | dispose twice / send after dispose | HostMcp stop + process dispose each called once; later send invokes onError with deterministic disposed message, no spawn | spies + disposed engine |

## Test Files

- `src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts` — all tests above.

## Verification Commands

```bash
npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] Event surface matches existing `OmpChatEvents` from `src/ai/omp/ompChatEngine.ts:107-116`: `onDelta`, `onThought`, `onToolStart`, `onToolEnd`, `onError`, `onDone`, `onTrace`.
- [ ] `send(text, events, attachments?)` forwards attachments only when nonempty and never serializes their base64 into traces/logs.
- [ ] `resume(sessionId, events)` has deterministic Claude CLI semantics: resumes using Claude's documented `--resume` only if TASK-005 verified it; otherwise invokes `onError("Claude Code session resume is unavailable")` without spawning. This explicit behavior is test-covered.
- [ ] Host MCP lifecycle is start-before-send and stop-on-dispose; no credential/apiKey reaches it.
- [ ] All test cases pass.

## Dependencies

- TASK-005 — consumes `ClaudeCodeProcessHandle`, `ClaudeCodeTurnInput`, and its normalized process events.

## Interfaces

- Consumes: `ClaudeCodeProcessHandle` / `createClaudeCodeProcess` from TASK-005; existing `HostMcp` surface (start/stop/call) from `src/ai/omp/ompChatEngine.ts:88-102`; `TraceEvent` from `src/ai/trace.ts`.
- Produces:
  - `export interface ClaudeCodeChatEvents { onDelta?; onThought?; onToolStart?; onToolEnd?; onError?; onDone?; onTrace? }` — exact callback signatures must mirror `OmpChatEvents`.
  - `export interface ClaudeCodeChatEngine { send(text: string, events: ClaudeCodeChatEvents, attachments?: ReadonlyArray<{ mime:string; base64:string }>): Promise<void>; resume(sessionId: string, events: ClaudeCodeChatEvents): Promise<void>; dispose(): void | Promise<void> }`
  - `export function createClaudeCodeChatEngine(deps: ...): ClaudeCodeChatEngine`
  — TASK-011 receives it as `AiChatPanelOptions.claudeCodeChatEngine`; TASK-012 builds it.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Do not modify/copy `src/ai/omp/ompChatEngine.ts`; import types where possible. `resume` is required by the panel’s conceptual engine contract, but upstream support must be verified rather than presumed; an explicit user-visible unsupported error is correct if no documented resume protocol exists.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report

EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-009

 ❯ src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts [ src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts ]
Error: Failed to load url ../claudeCodeChatEngine (resolved id: ../claudeCodeChatEngine) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-009/src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
   Start at  18:31:48
   Duration  181ms
```

Verification Output:
```
$ npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-009

 ✓ src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts  (7 tests) 5ms
 ✓ src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts  (5 tests) 5ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  18:35:01
   Duration  177ms

$ npm run typecheck
> UnicDB@1.53.23 typecheck
> tsc --noEmit
(exit 0, no errors)
```

Status: PASS
Note: Initial RED→GREEN pass required two test-side fixes (NOT implementation fixes) before the suite stabilised:
(1) Test #1 originally used `proc.send.mockImplementation(...)` to fire the callback sequence; that shadowed the fake's `receivedInputs.push` side-effect. Switched to the `emit` callback parameter on `createFakeProcess(...)` so the default `send` keeps its side-effect AND fires the test-specific events.
(2) `createCollector()` originally auto-subscribed to `onTrace`, which interleaved trace events into the recorded `order` array and broke test #1's exact-order assertion. Made `onTrace` opt-in via `{ withTrace: true }`; test #3 (image redaction) explicitly opts in so its blob check still works.
Implementation was GREEN on the first compile pass; no engine-side bugs surfaced.
ResumeBehavior: explicit onError("Claude Code session resume is unavailable") without spawn (no documented --resume) — TASK-005's Discussion confirms `claude --help` was probed only for spawn flags (`--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--mcp-config`, `--permission-mode`, `--permission-prompts`); `--resume` was NOT verified, so per Acceptance §3 the engine surfaces the canonical unsupported error and refuses to spawn. Test #6 asserts this contract.
Files changed:
  - src/ai/claudeCode/claudeCodeChatEngine.ts (new, ~230 lines) — factory + types + lifecycle
  - src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts (new, ~330 lines) — 7 tests
