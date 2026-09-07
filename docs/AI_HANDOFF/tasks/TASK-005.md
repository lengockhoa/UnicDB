# TASK-005 — Claude Code stream-json process/session adapter

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3(2), §7

## Goal

Wrap the real Claude Code CLI JSON streaming protocol behind an injectable, bounded process adapter. It must run CLI prompt turns with workspace `cwd`, preserve its process lifecycle, translate stream-json output into normalized agent events, and provide the seam TASK-009 needs.

## Target Files

- `src/ai/claudeCode/claudeCodeProcess.ts` (new) — spawn/lifecycle/frame translation adapter.
- `src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts` (new) — fake-child process/unit fixtures.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | spawns a text prompt turn and maps a valid assistant stream event | `spawnFn` receives detected `claudePath`, `cwd`, `stdio: "pipe"`, and flags `--print --input-format stream-json --output-format stream-json --verbose`; normalized `onDelta("hello")` occurs | fake child emits newline-delimited known Claude assistant event |
| 2 | edge (malformed input) | malformed JSON line from stdout | line is ignored or produces one `onError`; adapter does not throw, kill child, or hang | fake stdout line `{bad-json}\n` then valid completion |
| 3 | edge (lifecycle) | dispose while a turn is in flight | sends SIGTERM, resolves no later than `CLAUDE_CODE_DISPOSE_TIMEOUT_MS` (= 2000); second dispose no-ops | fake child does not exit until timer escalation |
| 4 | edge (process failure) | child emits error / nonzero exit with stderr | returned promise rejects or invokes normalized `onError` including bounded (≤8 KiB) stderr tail, never secret-bearing config content | fake child error + >8KiB stderr fixture |
| 5 | edge (boundary) | prompt contains image data URL plus text in stream-json input | one valid JSON stdin frame has text and image blocks intact; no base64 appears in error/log callback | 1 PNG attachment fixture + prompt text |

## Test Files

- `src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts` — all tests above.

## Verification Commands

```bash
npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] Adapter uses the resolved `ClaudeCodeDetection.path`, never bare `"claude"` when a path is supplied (Windows `.cmd` compatibility).
- [ ] Every `spawn()` has mandatory workspace `cwd`; no shell interpolation of prompt/image data.
- [ ] Process invocation is grounded in locally verified Claude 2.1.261 help: `--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, and `--mcp-config` (when descriptor config is supplied).
- [ ] `--permission-mode` must NOT enable automatic bypass; use host/default-deny semantics and record exact compatible flag selection in Discussion.
- [ ] State union is closed and lifecycle is idempotent/bounded; all test cases green.

## Dependencies

- TASK-002 — consumes the detected Claude binary path + version-gated contract.

## Interfaces

- Consumes: `ClaudeCodeDetection` and detected `path?: string` from `src/ai/claudeCode/detect.ts` (TASK-002); `HostMcp` descriptor URL shape via `src/ai/omp/hostMcp.ts:64` / `src/ai/omp/mcpBridge.ts:40` (existing).
- Produces:
  - `export type ClaudeCodeEngineState = "stopped" | "starting" | "ready" | "cancelling" | "crashed" | "fallback-builtin"`
  - `export interface ClaudeCodeProcessHandle { state(): ClaudeCodeEngineState; send(input: ClaudeCodeTurnInput, events: ClaudeCodeProcessEvents): Promise<void>; cancel(): void; dispose(): Promise<void>; getStderrTail?(): string }`
  - `export interface ClaudeCodeTurnInput { text: string; attachments?: ReadonlyArray<{ mime: string; base64: string }>; mcpConfigPath?: string }`
  - `export function createClaudeCodeProcess(options: ClaudeCodeProcessOptions): ClaudeCodeProcessHandle`
  — TASK-009 must use these exact exports; TASK-012 supplies the live mcp config path/host bridge.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Local evidence: `claude --version` = `2.1.261`; `claude --help` explicitly supports `--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--mcp-config`, and `--permission-prompts host|none`. The exact JSON frame/event field mapping is NOT verified by local help output: establish it from `claude --help`/a no-network probe or public CLI protocol docs, pin recorded fixtures, and state the source here. Never use `--dangerously-skip-permissions`.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report

EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

### Discussion (executor additions)

#### CLI flag selection (local probe)
Verified on Claude 2.1.261 (local). `claude --help` confirms:
- `--print` — print response and exit (mandatory for non-interactive turns).
- `--input-format stream-json` — chosen from {`text`, `stream-json`}; stream-json lets us pipe newline-delimited user-message envelopes on stdin instead of arg-concatenating the prompt into a shell argv.
- `--output-format stream-json` — chosen from {`text`, `json`, `stream-json`}; stream-json emits Anthropic Messages-style envelopes we can parse incrementally.
- `--verbose` — required by the CLI itself for stream-json output to include intermediate frames (the CLI docstring notes stream-json frames only arrive in `--verbose` mode).
- `--mcp-config <configs...>` — passed ONLY when `input.mcpConfigPath` is supplied (TASK-012 wires the live path; tests omit it).
- `--permission-mode manual` + `--permission-prompts none` — chosen for default-deny semantics. `--permission-mode` choices are `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. We use `manual` (no automatic approval) and pair it with `--permission-prompts none` (the SDK host / `--permission-prompt-tool` does not answer), so any tool that would normally prompt is auto-denied. **NEVER** `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions` (test #1 explicitly forbids both).

#### Stream-json wire shape (best-effort, not locally probed)
Per the planner note that the exact JSON frame/event field mapping is NOT verified by local help output: I implemented a defensive subset that matches the documented Anthropic Messages API streaming shape — the same shape `claude --output-format stream-json` is documented to emit in the public CLI protocol. Concretely:

Input (stdin, newline-delimited JSON):
```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"..."},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
]}}
```

Output (stdout, newline-delimited JSON):
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
{"type":"result","subtype":"success"|"error","is_error":false,...}
{"type":"error","message":"..."}
```

The adapter: (a) extracts text from `assistant.message.content[].type === "text"` → `onDelta`; (b) extracts tool-use from `assistant.message.content[].type === "tool_use"` → `onToolStart`; (c) extracts tool-result from `user.message.content[].type === "tool_result"` → `onToolEnd`; (d) settles the turn on `result.subtype === "success"` and fires `onError` on `result.subtype === "error"` or top-level `error` frames. Unknown frame types are silently ignored (Acceptance §5: malformed/unknown MUST NOT throw, kill, or hang).

A real-wire probe against Claude Code 2.1.261 has NOT been performed in this executor pass — fixture-based testing only. The seam (`ClaudeCodeProcessEvents` + the `extractAssistantText` / `extractToolUse` / `extractToolResult` helpers) is shaped so TASK-009 / TASK-014 can tighten individual mappings without churning the public interface.

#### Per-turn state semantics (deliberate divergence from AcpProcess)
Claude Code `--print` exits after one turn; a clean exit (code 0) after a `result` frame lands at `"stopped"` (per-turn completion), not `"crashed"`. `crashed` is reserved for unexpected failures: non-zero exit, no result frame, spawn error, or error frame. `fallback-builtin` is the terminal reached after `crashed`, mirroring AcpProcess so the panel's fallback/restart owner can observe a uniform terminal across both engines. After `"stopped"` the next `send()` spawns a fresh child; after `"fallback-builtin"` the handle is locked.

### Verification

RED_OUTPUT:
```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-005

 ❯ src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts [ src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts ]
Error: Failed to load url ../claudeCodeProcess (resolved id: ../claudeCodeProcess) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-005/src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
   Start at  18:11:15
   Duration  201ms
```

Verification Output:
```
$ npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-005

 ✓ src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts  (5 tests) 6ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  18:17:40
   Duration  178ms

$ npm run typecheck
> UnicDB@1.53.23 typecheck
> tsc --noEmit
(exit 0, no errors)
```

Status: PASS
Note: Implementation required two fix iterations beyond the initial RED→GREEN pass: (1) `dispose()` was `async`, which wrapped the cached promise in a new Promise on each call and broke the identity contract that second `dispose()` returns the same instance — switched to non-async and now caches the resolved Promise explicitly; (2) when the SIGKILL escalation timer fired before the child actually exited, the pending `send()` promise was never resolved (the exit handler later saw `turnInFlight === false` and bailed) — added `settleInFlightTurn()` to the dispose resolve callback so a turn-in-flight always settles, even when the timer path wins the race.
ProtocolSource: `claude --help` 2.1.261 (local) — `--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--mcp-config`, `--permission-mode` (choices: acceptEdits/auto/bypassPermissions/manual/dontAsk/plan; we pick `manual`), `--permission-prompts` (choices: host/none; we pick `none`). Never `--dangerously-skip-permissions`.
