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
