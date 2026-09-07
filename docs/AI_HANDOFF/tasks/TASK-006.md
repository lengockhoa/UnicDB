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

### 2026-09-07 · executor · unic-code

Verified against the official OpenAI Codex CLI documentation before implementation:

**Primary source (URL):** https://developers.openai.com/codex/noninteractive (live markdown fetched 2026-09-07, redirected from `learn.chatgpt.com/docs/non-interactive`).

**Command shape (verified from `codex-rs/exec/src/cli.rs` in `openai/codex` main branch, lines 10-81):**

```
codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]
```

Relevant flags (clap `long = "..."` form, all on the root `Cli` struct unless noted):
- `--json` (alias `--experimental-json`) — print events to stdout as JSONL. **Required** for our adapter. Without it, codex prints only the final agent message to stdout.
- `-o <FILE>` / `--output-last-message <FILE>` — write final message to file (still also printed to stdout).
- `--output-schema <FILE>` — JSON Schema for the final response shape (NOT used here, kept for parity).
- `--ephemeral` — run without persisting session files.
- `--ignore-user-config` — skip `$CODEX_HOME/config.toml`.
- `--ignore-rules` — skip user/project `.rules` execpolicy files.
- `--strict-config`, `--thread-source <SOURCE>`, `--skip-git-repo-check` — global.
- `PROMPT` positional — if `-` is supplied, codex reads the prompt from stdin. If stdin is also piped AND a prompt arg is given, stdin is appended as a `<stdin>` block (per the noninteractive doc).

**Note on `--cd`/`-C`:** `--cd` exists on `codex resume` / `codex fork` (per `developer-commands.md` line 310) but is NOT a root-`Cli` flag on `codex exec`. Workspace boundary is enforced via the spawn `cwd` option (matches the omp adapter's posture).

**Note on image attachment:** `--image <path>` only exists on the `exec resume` and `exec fork` subcommands (`cli.rs` lines 167-227), not on a fresh `codex exec` invocation. For a fresh turn, image content is encoded into the wire payload the adapter writes to stdin (see `buildInputFrame` in `codexProcess.ts`); the spawn always uses `codex exec --json -` (the `-` sentinel forces prompt-from-stdin) so the adapter can ship structured input deterministically.

**Wire event surface (verified from `codex-rs/exec/src/exec_events.rs`, `#[serde(tag = "type")]`):**

Top-level event envelope (one JSON object per line on stdout):
- `thread.started` — `{ "type": "thread.started", "thread_id": "<uuid>" }`
- `turn.started` — `{ "type": "turn.started" }`
- `turn.completed` — `{ "type": "turn.completed", "usage": { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }`
- `turn.failed` — `{ "type": "turn.failed", "error": { "message": "<text>" } }`
- `item.started` / `item.updated` / `item.completed` — each carries `"item": <ThreadItem>` (see below)
- `error` — `{ "type": "error", "message": "<text>" }` (mid-turn error)

`ThreadItem` is tagged (`#[serde(tag = "type", rename_all = "snake_case")]`); relevant variants the adapter normalises:
- `agent_message` — `{ "id": "item_<n>", "text": "<delta>" }` — drives `onDelta` and `onDone` (terminal).
- `reasoning` — `{ "id": "...", "text": "<reasoning>" }` — drives `onThought` (kept for parity with omp; not surfaced by task tests).
- `command_execution` — `{ "id": "...", "command": "...", "aggregated_output": "...", "exit_code": <n>, "status": "in_progress|completed|failed|declined" }` — tool-call analogue.
- `file_change` / `mcp_tool_call` / `web_search` / `todo_list` — not used by these tests; tolerated (dropped silently by the dispatcher).

**Adapter translation (what the implementation will do, derived from the above):**

1. Spawn: `<codexPath> exec --json -` with mandatory `cwd` spawn option (no shell interpolation). The `-` sentinel forces stdin-prompt so the adapter can stream the input payload deterministically regardless of length / special chars.
2. Wire input frame (one JSON object written to stdin, followed by EOF): `{ "prompt": "<text>", "parts": [{ "type": "text", "text": "..." }, { "type": "image", "mime": "image/png", "base64": "..." }, ...] }`. This is a UnicDB-defined translation; the upstream Codex CLI consumes the `<stdin>` block as appended context for the prompt (per noninteractive doc, "stdin is appended as a `<stdin>` block"). The adapter's contract is to encode the input in this documented frame so the panel can recover the original parts (test #5).
3. JSONL stdout → normalized callbacks:
   - `thread.started.thread_id` → captured as sessionId (replaces omp's `sessionId` from `session/new`).
   - `item.completed` with `item.type === "agent_message"` and non-empty `text` → `onDelta(text)`; the subsequent `turn.completed` (or final `item.completed` of agent_message with no further turn event) → `onDone()`.
   - `turn.failed` or top-level `error` → `onError(message)` (resolved; never throws).
   - All other variants silently dropped (per existing TASK-006 acceptance posture, mirrors omp's dispatcher).
4. Stderr bounded ≤8 KiB; appended to any error surfaced to callers. Base64 / DB credentials / apiKey NEVER appear in logs, error messages, or stderr echo.

**Sources:**
- https://developers.openai.com/codex/noninteractive (primary spec — non-interactive mode, JSONL stream, item types, prompt-plus-stdin / `-` sentinel).
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs (root `Cli` flag definitions, JSON flag alias, `--output-last-message` / `--output-schema`).
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs (wire-level `#[serde(tag = "type")]` enum names).
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs (confirms `agent_message.text` is the delta field and `item.completed` is the terminal shape).
- https://developers.openai.com/codex/developer-commands.md (cross-reference for `--cd` scope on `resume`/`fork` only, and `--image` scope on `exec resume`/`exec fork` only — neither applies to a fresh `codex exec` invocation).

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report

EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-006

 ❯ src/ai/codex/__tests__/codexProcess.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/codex/__tests__/codexProcess.test.ts [ src/ai/codex/__tests__/codexProcess.test.ts ]
Error: Failed to load url ../codexProcess (resolved id: ../codexProcess) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-006/src/ai/codex/__tests__/codexProcess.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

(RED was confirmed for the expected reason — adapter module not yet implemented. Test 4/10 first-pass failures after initial implementation were a `settle` const-rebind typo in `send()`; fixed by routing through a `holder` object. Final run below.)

Verification Output:

```
> UnicDB@1.53.23 typecheck
> tsc --noEmit

(exit 0, no output)

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-006

 ✓ src/ai/codex/__tests__/codexProcess.test.ts  (10 tests) 2040ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  18:16:07
   Duration  2.24s
```

Status: PASS
Note: 10/10 tests pass; typecheck clean. The `codex exec --json -` wire shape, stdin-prompt sentinel, and event envelope (`thread.started`, `item.completed` w/ `agent_message.text`, `turn.completed`, `turn.failed`, top-level `error`) were all verified against the official OpenAI Codex CLI documentation before implementation (see Discussion thread above). Same six-state lifecycle (`stopped|starting|ready|cancelling|crashed|fallback-builtin`) and bounded 2000ms dispose posture as the omp/AcpProcess adapter, by design (TASK-006 mirrors TASK-AIX05-101).
ProtocolSource:
- https://developers.openai.com/codex/noninteractive (primary spec — non-interactive mode, JSONL stream shape, item types, prompt-plus-stdin / `-` sentinel)
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs (root `Cli` flag definitions, `--json` alias `--experimental-json`, `-` stdin-prompt sentinel at line 80)
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs (wire-level `#[serde(tag = "type")]` enum: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`; item.tagged `type` w/ `agent_message.text` / `reasoning.text`)
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs (confirms `agent_message.text` is the delta field and `item.completed` is the terminal shape)
- https://developers.openai.com/codex/developer-commands.md (cross-reference for `--cd` scope on `resume`/`fork` only, and `--image` scope on `exec resume`/`exec fork` only — neither applies to a fresh `codex exec` invocation)

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart (claude-opus)
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/codex/__tests__/codexProcess.test.ts && npm run typecheck
  result: 10 pass / 0 fail; tsc --noEmit exit 0
TEST_PLAN_COVERAGE: all-followed — §4 cases #1-#5 all present with real assertions; RED_OUTPUT is genuine module-not-found failure; 4 edge cases (>2 required)
FINDINGS:
  critical:
    - (none)
  important:
    - src/ai/codex/codexProcess.ts:495 — per-turn `child.on("exit", onExit)` is never removed: `settle()`/`detach()` (lines 407-417) removes only the stdout JSONL pump and `ChildLike` (lines 155-162) has no `off`/`removeListener`. Each send() on a long-lived handle permanently accumulates one exit listener (Node MaxListenersExceededWarning at 11 sends); when the child finally exits (dispose/crash after N completed turns), ALL N stale closures fire `events.onError("codex exited mid-turn ...")` on turns that already completed with onDone — TASK-010 will observe spurious post-success failures on every dispose. Fix: add `off(ev, cb)` to ChildLike and call it on onExit inside settle(); add a test with 2+ sends followed by emitChildExit asserting no stale onError.
  minor:
    - src/ai/codex/codexProcess.ts:638 — dispose() after a crash sets state "stopped", erasing the observed "crashed"/"fallback-builtin" terminal state for state observers.
    - src/ai/codex/codexProcess.ts:335 — version probe interpolates codexPath into an unquoted shell string while the spawn path is carefully cmd.exe-quoted (lines 250-257); a Windows install path with spaces breaks the probe (falls back to "unknown" — cosmetic) and bypasses the quoting discipline. Reuse quoteForCmdExe.
    - src/ai/codex/codexProcess.ts:703-721 — the `{prompt, parts}` stdin frame is a UnicDB-defined translation; upstream Codex treats stdin as a `<stdin>` text block per the cited noninteractive doc. Honestly disclosed in Discussion and gated by TASK-014 live smoke, but TASK-010 must not assume upstream parses `parts` (image transport unproven until smoke).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation, protocol citations, and tests are solid; the single important defect is the un-removed per-turn exit listener that misreports completed turns as failed once the child exits. Scope fix to ChildLike.off + settle() + one regression test, then re-verify.

---

## R4.5 Fix Report

EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: feature-implementer

### Reviewer Finding Addressed

`important` finding — `src/ai/codex/codexProcess.ts:495` per-turn `child.on("exit", onExit)` was never removed; `settle()` only detached the stdout JSONL pump and `ChildLike` had no `off`. After N sends, every prior `onExit` closure stayed attached and ALL N stale closures fired `events.onError("codex exited mid-turn ...")` on turns that already completed with `onDone` once the child finally terminated.

### Changes

1. `src/ai/codex/codexProcess.ts` — `ChildLike` interface gains `off(ev, cb)` overloads (exit / error).
2. `src/ai/codex/codexProcess.ts` — `spawnLike` wrapper forwards `on` and `off` directly to the underlying `ChildProcess` while preserving callback identity. The previous wrapper re-wrapped `cb` into a fresh dispatcher closure on every `on()` call, which silently broke `off()` — replaced with an identity-preserving dispatch that uses the same closure instance for register and deregister.
3. `src/ai/codex/codexProcess.ts` — `send()` hoists `onExit` above `settle()` (so settle can pass the same reference to `child.off("exit", onExit)`) and `settle()` now calls `child.off("exit", onExit)` after detaching the JSONL pump. `try/catch` swallows any removal exception since `EventEmitter.removeListener` is a no-op for unknown pairs on real Node emitters but the wrapper itself is internal.
4. `src/ai/codex/__tests__/codexProcess.test.ts` — new regression test "R4.5: stale per-turn exit listeners must NOT fire onError on completed turns after child exit" drives 2 sends, both complete via `turn.completed`, then `emitChildExit(0)` fires the actual exit; asserts `errors1` and `errors2` are empty (no stale onError on already-completed turns).
5. `src/ai/codex/__tests__/codexProcess.test.ts` — added `TolerablePassThrough` helper so the fake child's stdin tolerates writes after end() (real `codex` accepts one frame per `exec -` invocation but the fake is reused across multiple sends within the same test; the wrapper prevents an unrelated `write after end` stderr noise that would have obscured the regression assertion).

### RED Output (before fix)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB

 ❯ src/ai/codex/__tests__/codexProcess.test.ts > CodexProcess > R4.5: stale per-turn exit listeners must NOT fire onError on completed turns after child exit
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   "codex exited mid-turn (code=0)
+ --- codex stderr (tail) ---
+ ",
+ ]
```

RED confirmed: stale `onExit` from turn 1 fired onError on the actual child exit even though turn 1 already completed with `onDone`.

### Verification (after fix)

```
> UnicDB@1.53.23 typecheck
> tsc --noEmit

(exit 0, no output)

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB

 ✓ src/ai/codex/__tests__/codexProcess.test.ts  (11 tests) 2063ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  20:02:16
   Duration  2.28s
```

Status: PASS
Note: 11/11 tests pass (10 pre-existing + 1 new R4.5 regression); `tsc --noEmit` exits 0. The R4.5 reviewer finding is fully resolved; the minor findings (dispose-after-crash state erasure, version-probe unquoted interpolation, stdin frame upstream assumption) are out of scope for this fix and were intentionally not touched per the reviewer-scope instruction.

FILES_CHANGED:
  - src/ai/codex/codexProcess.ts
  - src/ai/codex/__tests__/codexProcess.test.ts

TESTS_ADDED:
  - src/ai/codex/__tests__/codexProcess.test.ts: R4.5 regression test for stale per-turn exit listeners
