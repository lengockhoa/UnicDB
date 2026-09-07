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
