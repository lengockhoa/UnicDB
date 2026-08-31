# PLAN_AIX05 — OMP Agent Workbench

Cycle: AIX-05 (wave 4) · Base: main @ d948ec1 (v1.24.0) · Release target: v1.25.0
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

## Roadmap row

> **AIX-05 OMP Agent Workbench** — Use OMP as an optional agent engine with
> clear session state, cancellation, fallback to built-in chat, and VSDB MCP
> tools. Harden `ompChatEngine`, ACP process/bridge and host MCP.
> Depends AIX-02, AIX-03. **No required OMP installation or hidden
> subprocess capability.**
> Edge: missing/old binary, protocol error, cancellation/restart, tool
> permission parity.

## Current state (evidence)

- `src/ai/omp/ompChatEngine.ts` — `createOmpChatEngine({acp, hostMcp, cwd})`
  returns `{send, resume, shutdown}`. `send()` does `session/new` (per
  turn — restart-safe), registers a notification forwarder
  (agent_message_chunk → onDelta, agent_thought_chunk → onThought,
  tool_call → hostMcp.call, tool_call_update → onToolEnd), awaits
  `session/prompt`, non-throwing (onError fired once). **NO `cancel()`
  on the engine contract.**
- `src/ui/aiChatPanel.ts:2520` `handleStop()` — OMP branch guarded by
  `this.acpSession !== null`, which is ONLY set by the legacy `runAcpTurn`
  path. The current `runOmpEngineTurn` path never sets `acpSession`, so
  **Stop in omp-engine mode flips `token.aborted` (suppresses webview
  deltas) but never sends `session/cancel` to the omp child — the child
  keeps generating server-side** (wasted tokens; late frames dropped by
  the token gate). This is the core cancellation gap.
- `src/ai/omp/acp.ts` — `AcpClient.notify("session/cancel", {sessionId})`
  fire-and-forget exists (used by runAcpTurn's Stop path).
- `src/ai/omp/detect.ts` — `detectOmp` returns
  `OmpDetection{available, ok, path, version, reason}` with reason
  `not-installed | version-too-old | version-unknown | spawn-failed`,
  `MIN_OMP_VERSION=17.0.0`, `OMP_INSTALL_HINT`, `OMP_UPDATE_HINT`.
- `src/ai/engineChoice.ts` — `resolveEngine({detection, config})` maps
  reason → hint (omp ok ⇒ engine omp; else builtin + INSTALL/UPDATE hint).
  Hint mapping is NOT unit-tested per reason.
- `src/ai/omp/hostMcp.ts` — in-process Streamable-HTTP MCP server on
  127.0.0.1, per-tool permission gate (allow-once/session/deny,
  default-deny), `call()` JSON-RPC wrapper → `{result, isError}`.
- `webview/aiChatPanelMain.ts` — engine banner only (`applyEngine`); NO
  session-state message exists (`AiChatPanelEngine` carries name/version/
  hint only). Roadmap asks for "clear session state".
- Tests: `src/ai/omp/__tests__/` ~80 unit (detect 13, acp 19,
  acpProcess 18, ompChatEngine 7, hostMcp 13, mcpBridge 10) + 2 gated
  smoke. `src/ui/__tests__/aiChatPanelEngine.test.ts` covers banner/
  failover; `aiChatPanelAcp.test.ts` covers legacy ACP cancel concurrency.

## Goal

Harden the OMP engine surface for the roadmap's four edges without
expanding scope:

1. **Clear session state** — new `session_state` host→webview wire kind;
   the omp path posts transitions (connecting → running → done/error) so
   the banner area shows turn lifecycle, not just the engine name.
2. **Cancellation parity** — `OmpChatEngine.cancel()` added to the engine
   contract; the engine tracks the current sessionId and sends
   `session/cancel` for it. `handleStop()` in omp mode calls
   `engine.cancel()` (fixes the real gap above). Restart-safe: every
   `send()` creates a fresh session (already true) — pinned by test.
3. **Protocol error recovery** — `dispatchNotification` must never throw
   on unknown methods / malformed params; engine survives and the next
   turn works. Detection reason → hint mapping unit-tested (missing/old
   binary edge).
4. **Tool permission parity** — the OMP/MCP registry carries the SAME
   gate-wrapped tool set as builtin (db tools + AIX-03 analysis +
   AIX-04 plan_change); pinned by a registry-parity test + scaffold.

## Non-goals

- No required OMP install; no new subprocess capabilities (spawn surface
  unchanged).
- No protocol version bump; no new MCP server features.
- No trace/audit (AIX-06 scope).

## Tasks (TDD, each RED→GREEN)

### TASK-AIX05-001 — session state visibility
`src/ui/aiChatPanelMessages.ts` + `src/ui/aiChatPanel.ts` +
`webview/aiChatPanelMain.ts`:
- New `AiChatPanelSessionState {type:"session_state", state:"connecting"|
  "running"|"done"|"error", turnId}` added to the HostMessage union.
- `runOmpEngineTurn` posts connecting (before engine.send), running (on
  first delta/thought/tool event), done (finally), error (onError).
- Webview renders a status chip in the engine banner area
  (textContent-only) via a `session_state` case.
- Tests: host (transition order, error state on crash) + webview (chip
  renders states, no innerHTML).

### TASK-AIX05-002 — OMP cancellation + restart hardening
`src/ai/omp/ompChatEngine.ts` + `src/ui/aiChatPanel.ts`:
- Add `cancel(): void` to `OmpChatEngine` contract: tracks the active
  sessionId in the engine closure; `cancel()` sends
  `acp.notify("session/cancel", {sessionId})` fire-and-forget (no-op
  when no turn in flight).
- `handleStop()`: when `engine === "omp"` and `options.ompChatEngine` is
  present, call `engine.cancel()` (in addition to token.aborted).
- Restart pin: send → cancel → send again creates a FRESH sessionId;
  crash mid-turn → next send creates a fresh session (restart edge).
- Tests: engine-level cancel (right sessionId, no-op without turn,
  idempotent double-cancel), panel-level Stop-in-omp-mode sends
  session/cancel, restart-after-cancel, restart-after-crash.

### TASK-AIX05-003 — protocol error recovery + detection reason surfacing
`src/ai/omp/ompChatEngine.ts` + `src/ai/omp/detect.ts` +
`src/ai/engineChoice.ts`:
- `dispatchNotification`: unknown methods and malformed params are
  dropped WITHOUT throwing (isParamsRecord/stringField already guard;
  add a catch-all so a bad frame can never kill a turn). Pin by tests:
  unknown method, missing params, tool_call without name, tool_call
  result without id → engine stays alive, next send works.
- Detection reason → hint: unit tests for `resolveEngine` mapping
  (not-installed → OMP_INSTALL_HINT, version-too-old → OMP_UPDATE_HINT,
  version-unknown → INSTALL_HINT, spawn-failed → INSTALL_HINT). Fix
  mapping if any case diverges.
- Tests: `src/ai/omp/__tests__/ompChatEngine.test.ts` (protocol errors),
  `src/ai/__tests__/engineChoice.test.ts` (reason→hint).

### TASK-AIX05-004 — tool permission parity + scaffold + docs
- Registry parity: in `src/ui/aiChatPanel.ts`, the OMP/MCP path and the
  builtin path must register the SAME gate-wrapped tool set — db tools +
  `createAnalysisTools` + `createChangePlanTools` (AIX-03/04 parity).
  Pin with a test that lists both registries' tool names and asserts
  equality (permission cards identical shape).
- `src/__tests__/aix05Scaffold.test.ts`: ompChatEngine/acp/acpProcess/
  hostMcp pure-ish hygiene (no `shell:true`/execSync; ompChatEngine never
  embeds apiKey — byte-scan for `apiKey`/`token` in wire frames);
  `session_state` wire kind exists; `OmpChatEngine` contract includes
  `cancel`; engineChoice/detect exports present.
- CHANGELOG 1.25.0 section + compare link (re-verify link block);
  README bullet after the 1.24.0 line.

## Verification per task

`npx vitest run <target test>`; cycle: `npm test`, `npm run typecheck`,
`npm run compile`.

## Risk / review focus

- Cancel correctness: the engine must cancel the RIGHT session and be
  idempotent; the panel must not double-cancel.
- Restart safety: a fresh session per send must be pinned (crash/cancel
  must never wedge the panel into a dead session).
- Protocol robustness: malformed frames degrade to a dropped
  notification, never a thrown turn.
- Parity: builtin vs OMP/MCP registries must stay identical (AIX-03/04
  regression — plan_change must appear on BOTH).
