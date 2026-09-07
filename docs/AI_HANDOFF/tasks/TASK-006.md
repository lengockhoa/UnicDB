# TASK-006 — Codex JSON protocol process/session adapter

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3(2), §7

## Goal

Wrap the Codex CLI behind an injectable, bounded JSON/NDJSON process adapter with a normalized event surface for TASK-010. The adapter must make text and image blocks transportable, preserve cwd and host-MCP boundaries, and fail safely on protocol/process errors.

## Target Files

- `src/ai/codex/codexProcess.ts` (new) — spawn/lifecycle/protocol translation adapter.
- `src/ai/codex/__tests__/codexProcess.test.ts` (new) — fake-child process/unit fixtures.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | spawns an accepted Codex protocol turn and maps assistant delta | exact, documented protocol args/frame supplied to fake spawn; normalized `onDelta("hello")`, then `onDone()` | recorded documented JSON fixture |
| 2 | edge (malformed input) | unknown or malformed JSON stdout record | adapter surfaces at most one useful `onError`/skips it, continues to valid terminal event; no throw | invalid line followed by valid event |
| 3 | edge (lifecycle) | cancellation/dispose during active turn | cancellation signal sent once; dispose settles ≤ `CODEX_DISPOSE_TIMEOUT_MS` (= 2000); repeat calls idempotent | never-exiting fake child |
| 4 | edge (process failure) | spawn error or nonzero exit + stderr | normalized failure contains bounded ≤8 KiB tail and no input base64/secret echo | error-emitting fake child |
| 5 | edge (boundary) | image + text turn encoding | translated input carries one image `mime` + base64/content reference and one text part, in original order | small PNG fixture + "describe this" |

## Test Files

- `src/ai/codex/__tests__/codexProcess.test.ts` — all tests above.

## Verification Commands

```bash
npx vitest run src/ai/codex/__tests__/codexProcess.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] Uses detected `CodexDetection.path` if available; mandatory spawn `cwd`; no shell interpolation.
- [ ] Has the same 6-state lifecycle set and bounded 2000ms dispose posture as omp/Claude adapter.
- [ ] Protocol command/arguments and frame fields are verified from the installed Codex CLI or official Codex CLI documentation and cited in Discussion BEFORE implementation; no invented `codex proto` assumption.
- [ ] Host MCP URL/config has a documented injection seam, but DB credentials/apiKey/base64 never enter logs or stderr messages.
- [ ] All listed tests pass.

## Dependencies

- TASK-003 — consumes the detected Codex binary path + version-gated contract.

## Interfaces

- Consumes: `CodexDetection` and `path?: string` from `src/ai/codex/detect.ts` (TASK-003); existing HostMcp/McpBridge local descriptor surface.
- Produces:
  - `export type CodexEngineState = "stopped" | "starting" | "ready" | "cancelling" | "crashed" | "fallback-builtin"`
  - `export interface CodexProcessHandle { state(): CodexEngineState; send(input: CodexTurnInput, events: CodexProcessEvents): Promise<void>; cancel(): void; dispose(): Promise<void>; getStderrTail?(): string }`
  - `export interface CodexTurnInput { text: string; attachments?: ReadonlyArray<{ mime: string; base64: string }>; mcpConfigPath?: string }`
  - `export function createCodexProcess(options: CodexProcessOptions): CodexProcessHandle`
  — consumed by TASK-010 and wired live by TASK-012.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Codex is not installed in this workspace (`command -v codex` failed), so CLI protocol syntax is deliberately unverified. This is NOT permission to guess. Resolve against official OpenAI Codex CLI documentation at implementation time; put the actual command/flags/frame source in this Discussion. TASK-014's `UnicDB_CODEX_SMOKE=1` live smoke is the required final proof when a Codex-installed environment is available.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
