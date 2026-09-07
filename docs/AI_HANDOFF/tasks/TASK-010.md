# TASK-010 — Codex chat engine (normalized events + image turn)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3(3), §4

## Goal

Build `CodexChatEngine`, a panel-facing chat-level adapter over TASK-006’s Codex process protocol. It exposes the existing event shape, accepts text and image content, and owns safe lifecycle/error behavior.

## Target Files

- `src/ai/codex/codexChatEngine.ts` (new) — chat-level glue.
- `src/ai/codex/__tests__/codexChatEngine.test.ts` (new) — unit tests with fake process/HostMcp.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | text send maps a complete Codex turn | fake process gets `text:"explain query"`; all seven callbacks forwarded in correct values/order | event-emitting fake process |
| 2 | edge (empty) | text-only invocation does not create image payload | input has `attachments: undefined`, exact text preserved | `send("hello", events)` |
| 3 | edge (image boundary) | multiple (up to panel-validated 4) image attachments preserve order | process gets four `{mime,base64}` blocks in input order alongside text | PNG/JPEG fixture list |
| 4 | edge (error path) | protocol/process error becomes one onError and settles | caller sees concrete error; no uncaught rejection, no hostMcp leak | fake process rejects |
| 5 | edge (lifecycle) | idempotent dispose then send | process/HostMcp disposed exactly once; later send does not spawn and emits disposed error | spy fakes |

## Test Files

- `src/ai/codex/__tests__/codexChatEngine.test.ts` — all tests above.

## Verification Commands

```bash
npx vitest run src/ai/codex/__tests__/codexProcess.test.ts src/ai/codex/__tests__/codexChatEngine.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] Callback signatures/meaning mirror `OmpChatEvents` exactly; panel can consume without Codex-specific branches beyond dispatch.
- [ ] A nonempty attachment list is passed as structured `{mime,base64}` blocks, never appended into user text.
- [ ] `resume` either uses verified Codex session-resume protocol or explicitly returns `onError("Codex session resume is unavailable")` without spawn; behavior test-pinned.
- [ ] Host MCP starts before a live turn and stops on dispose; errors cannot leak credentials/base64.
- [ ] All test cases pass.

## Dependencies

- TASK-006 — consumes `CodexProcessHandle`, `CodexTurnInput`, and process normalized events.

## Interfaces

- Consumes: `CodexProcessHandle` / `createCodexProcess` from TASK-006; existing HostMcp / trace types from omp modules.
- Produces:
  - `export interface CodexChatEvents` matching `OmpChatEvents` callback signatures.
  - `export interface CodexChatEngine { send(text: string, events: CodexChatEvents, attachments?: ReadonlyArray<{ mime:string; base64:string }>): Promise<void>; resume(sessionId: string, events: CodexChatEvents): Promise<void>; dispose(): void | Promise<void> }`
  - `export function createCodexChatEngine(deps: ...): CodexChatEngine`
  — TASK-011 consumes as `AiChatPanelOptions.codexChatEngine`; TASK-012 builds it.

---

## Discussion

### 2026-09-07 · planner · unic-smart
This must remain independent from TASK-009: do not introduce a shared agent-engine abstraction in this task. TASK-004 audit should nominate that as a separately reviewed future refactor if warranted.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  FAIL  src/ai/codex/__tests__/codexChatEngine.test.ts [ src/ai/codex/__tests__/codexChatEngine.test.ts ]
  Error: Failed to load url ../codexChatEngine (resolved id: ../codexChatEngine) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-010/src/ai/codex/__tests__/codexChatEngine.test.ts. Does the file exist?
   Test Files  1 failed (1)
        Tests  no tests
Verification Output: |
  > npx vitest run src/ai/codex/__tests__/codexProcess.test.ts src/ai/codex/__tests__/codexChatEngine.test.ts
   ✓ src/ai/codex/__tests__/codexChatEngine.test.ts  (11 tests) 5ms
   ✓ src/ai/codex/__tests__/codexProcess.test.ts  (10 tests) 2055ms
    Test Files  2 passed (2)
         Tests  21 passed (21)

  > npm run typecheck
  > tsc --noEmit
   (clean exit, no diagnostics)
Status: PASS
Note: none
ResumeBehavior: "explicit onError(\"Codex session resume is unavailable\") without spawn — TASK-006 noted Codex resume unverified"
IndependenceNote: "no shared extraction with TASK-009; duplicated ompChatEngine-shape locally as instructed — local CodexHostMcp interface, local CodexProcessHandle surface, local bridgeProcessEvents dispatcher"
