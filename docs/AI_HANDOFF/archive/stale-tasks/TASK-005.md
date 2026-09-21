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

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-5
VERIFICATION_RERUN:
  command: npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts && npm run typecheck
  result: 5 pass / 0 fail; typecheck exit 0
TEST_PLAN_COVERAGE: partial — all 5 cases implemented with real assertions and genuine RED output; gaps: error-frame `onError`-once behavior untested, bounded ≤8 KiB stderr tail never asserted (case #4 checks only the short message string, not `getStderrTail()`)
FINDINGS:
  critical:
    - none
  important:
    - src/ai/claudeCode/claudeCodeProcess.ts:728-729 and 745-746 — double `onError`: error/result-error frames fire `events.onError(message)` then call `failTurn()`, which fires `events.onError` AGAIN at line 830 on the same events object. Comment at 825-827 claims dedupe but none exists. Fix: pass an `alreadyReported` flag to failTurn (or drop the pre-fire so failTurn is the single source) and add a test driving a `subtype:"error"` result frame asserting exactly one onError.
    - src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts:330-378 — test #4 does not verify the ≤8 KiB bounded tail that Test Case #4 mandates: it asserts only the short `onError` message; the retained tail (`handle.getStderrTail()`) is never checked for length or truncation of the 9 KiB fixture. Fix: assert `handle.getStderrTail!().length <= 8*1024` and that fixture head bytes are gone.
    - src/ai/claudeCode/claudeCodeProcess.ts:488-493 — `spawnLike.stdin.write(frame)`/`end()` has no `stdin.on("error", ...)` listener; a child that dies before consuming stdin emits EPIPE and an unhandled stream 'error' becomes an uncaught exception in the extension host, violating the adapter's own "never throws on mid-turn crash" contract. Fix: attach an error listener that routes to failTurn before writing.
  minor:
    - src/ai/claudeCode/claudeCodeProcess.ts:151,874 — dead `ZERO_BASE64` const + `void ZERO_BASE64` lint-suppressor; delete both.
    - src/ai/claudeCode/claudeCodeProcess.ts:568 — dispose-resolve callback `setState("stopped")` can clobber a `fallback-builtin` landed by failTurn during a crash-in-dispose race; handle is locked but the read view is misleading.
    - src/ai/claudeCode/claudeCodeProcess.ts:456-458 — stderr tail slice can split a surrogate pair at the 8 KiB boundary (cosmetic).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Flag claims independently verified against my own `claude --help` probe (2.1.261): `--permission-mode manual` + `--permission-prompts none` are valid choices and default-deny; no bypass flag anywhere. R4 checklist (path, cwd, 4 CLI flags, 6-state union, 2000ms dispose, 8 KiB stderr, ProtocolSource) all pass. The three important findings are narrow and fixable in one executor round.

---

## R4.5 Fix Report

R4.5 round addressed the three IMPORTANT reviewer findings in one executor pass. (1) Double-`onError` on error/result-error frames (`claudeCodeProcess.ts` lines 728/745 vs. `failTurn` at 830): removed the pre-fire at the two error frame sites (`type === "result"` with `subtype:"error"`/`is_error:true`, and top-level `type === "error"`); `failTurn` is now the single source of truth for `onError` on the failure path, and the stale "already saw onError" comment in `failTurn` was rewritten to document the new contract. (2) Test #4 strengthened per Test Plan §Test Cases #4: the 9 KiB stderr fixture was rebuilt so the secret + base64 markers land in the first ~1 KiB (the slice-drop window) and the test now asserts `handle.getStderrTail!().length <= 8 * 1024`, that `typeof tail === "string"`, and that neither marker survives in the tail. (3) EPIPE on early-child-death stdin write (`claudeCodeProcess.ts` lines 488-493): a `spawnLike.stdin.on("error", ...)` listener was attached BEFORE `write`/`end`; it routes through `failTurn(wrapError(err, this.stderrTail))` so the adapter never lets an unhandled stream 'error' escape. Test coverage: added two new RED tests — `result-error frame fires onError exactly once (no double-fire)`, `top-level error frame fires onError exactly once (no double-fire)`, and `EPIPE on stdin write (child died early) does not throw uncaught; routes through failTurn` (captures `process.on("unhandledRejection")` to assert zero escapees). TDD RED→GREEN verified: RED had 3 failures on the new tests (double onError x2, unhandled EPIPE), GREEN has all 8/8 pass. Verification: `npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts` → 8 passed (8), exit 0; `npm run typecheck` → `tsc --noEmit` exit 0, no errors. The minor findings (dead `ZERO_BASE64` const + `void ZERO_BASE64`, `setState("stopped")` clobber race in dispose-resolve, surrogate pair split at 8 KiB boundary) are out of R4.5 scope per the reviewer and remain for a later round.

---

## Reviewer Verdict (R4.5 round 2)

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-5
VERIFICATION_RERUN:
  command: npx vitest run src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts && npm run typecheck
  result: 8 pass / 0 fail (fresh run); typecheck exit 0
TEST_PLAN_COVERAGE: all-followed — all 5 original cases plus 3 new R4.5 regression tests (result-error dedupe, top-level error dedupe, EPIPE no-uncaught), all with real expect assertions
FINDINGS:
  critical:
    - none
  important:
    - none — all 3 R4 blocking findings independently verified fixed on disk (not from report alone):
      (1) onError dedupe — pre-fires removed at both frame sites; grep confirms failTurn (claudeCodeProcess.ts:845) is now the ONLY onError fire site; two new tests assert errors.length === 1 for both result-error and top-level error frames.
      (2) Test #4 (claudeCodeProcess.test.ts:390-398) — now asserts getStderrTail() is string, length <= 8*1024, and secret+base64 markers truncated; fixture rebuilt with markers in the dropped head, matching the slice(-8KiB) direction at claudeCodeProcess.ts:455-457.
      (3) EPIPE — stdin.on("error") attached BEFORE write/end (claudeCodeProcess.ts:497-500), routes through failTurn; new test captures process "unhandledRejection" and asserts zero escapees, so removing the listener would fail the test.
  minor:
    - src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts:477-484 — EPIPE test emits child exit before the stdin error, so the asserted onError may arrive via the exit path rather than the EPIPE path; the load-bearing no-uncaught-escape assertion is still genuine, but emitting the stdin error while turnInFlight is still true would pin the attribution.
    - carried from R4 round 1 (explicitly out of R4.5 scope, non-blocking): dead ZERO_BASE64 const + void suppressor (claudeCodeProcess.ts:151,874), dispose-resolve setState("stopped") clobber view (568), surrogate-pair split at 8 KiB boundary (456-458).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Verified fix commit 9926866 diff directly; 8/8 tests re-run fresh by reviewer, typecheck clean. Quality gate satisfied for TASK-005 handoff; remaining minors are cosmetic or deferred by agreed scope.
