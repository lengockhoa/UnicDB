# TASK-AIX05-001 — session state visibility

Cycle: AIX-05 · Wave 4 · Priority: P1
Status: pending
Depends on: —
Reviewer: unic-smart (cycle reviewer)

## Spec

Give the AI chat webview a clear OMP turn-lifecycle state, beyond the
static engine banner:

1. `src/ui/aiChatPanelMessages.ts`: new
   `AiChatPanelSessionState {type:"session_state", state:"connecting"|
   "running"|"done"|"error", turnId: string}` added to the
   `AiChatPanelHostMessage` union.
2. `src/ui/aiChatPanel.ts` `runOmpEngineTurn` posts transitions:
   - `connecting` before `engine.send(...)`,
   - `running` on the FIRST delta/thought/tool-start event of the turn
     (post once, not per chunk),
   - `done` in `finally` (alongside the existing `done` post),
   - `error` in the `onError` callback (before the error bubble).
   `turnId` is a monotonically increasing per-panel counter.
3. `webview/aiChatPanelMain.ts`: new `session_state` case rendering a
   status chip (textContent-only) next to/inside the engine banner area;
   distinct label per state (`Connecting…` / `Running…` / `Done` /
   `Error`), cleared/replaced on each transition.

## Acceptance

## Reviewer Verdict (unic-smart, cycle reviewer Aix05Reviewer)

### Round 1 — APPROVED-WITH-MINOR
Webview HostMsg union was missing the new `session_state` kind (compiler didn't catch it because the case was added at the wire switch but the type was widened elsewhere).

### Round 2 — APPROVED-WITH-MINOR
Pending-cancel path violated the `cancel()` no-op/idempotency contract (idle cancel set `pendingCancel=true`; drain left `currentSessionId` populated so a later `cancel()` duplicated the notify).

### Round 3 — APPROVED
`sessionNewInFlight` flag gates `pendingCancel` to the in-flight window only; drain clears `currentSessionId` so a follow-up `cancel()` is a true no-op. Idle cancel pinned: `idle cancel() (no turn) is a true no-op and does NOT cancel the next send`. Duplicate-notify guard pinned: `after pendingCancel drains, a subsequent cancel() is a no-op`.

### Verified behavior
- `session_state` posts connecting → running (exactly once) → done/error in `runOmpEngineTurn`. Webview `#sessionChip` textContent-only. Wire kind present in both `AiChatPanelHostMessage` and the webview `HostMsg` union.
- `OmpChatEngine.cancel` addresses the active sessionId; idempotent across a single turn; no-op when idle; cancel-during-session/new is captured by `pendingCancel` and drained on resolution. Restart-safe: send→cancel→send opens a fresh session; crash mid-turn clears the active id; the post-drain second cancel is a no-op.
- `dispatchNotification` is crash-proof: top-level `isParamsRecord(n)` guard; unknown method + null params + tool_call without name + tool_call_update without `toolCallId` are all dropped silently. Valid frames still stream after malformed ones.
- `resolveEngine` hint keyed off `detection.reason` (not `detection.available`): not-installed/spawn-failed/version-unknown → OMP_INSTALL_HINT, version-too-old → OMP_UPDATE_HINT.
- `registerStandardToolset` is the single registration call on both the builtin and the OMP/MCP paths; parity test (`aiChatPanelToolParity.test.ts`) lists both registries and asserts the tool-name sets are equal (plan_change present on both). AIX-04 scaffold test updated for the helper consolidation.
- `session_state` path uses textContent only; no `as any`/`: any`, `shell:true`, `execSync`, or `child_process` additions in the changed production modules. `ompChatEngine` byte-scan for `apiKey` / `token` literal in wire frames clean.
- Reviewer did not independently run the suite/typecheck/compile (read-only source/diff verification).

### Final per-task verdicts
- TASK-AIX05-001: APPROVED
- TASK-AIX05-002: APPROVED
- TASK-AIX05-003: APPROVED
- TASK-AIX05-004: APPROVED

**Final: VERDICT: APPROVED**

- [ ] Host posts connecting → running → done in order for a clean omp
      turn; error state before the error bubble on crash.
## Executor

**RED**: `npx vitest run src/ui/__tests__/aiChatPanelSessionState.test.ts`
→ 3 failed (no `session_state` posts). Plus webview: 4 failed (no chip).

**GREEN**: `npx vitest run src/ui/__tests__/aiChatPanelSessionState.test.ts
src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts` → 7 passed
(7). Typecheck 0.

Notes:
- Added `AiChatPanelSessionState` to the `AiChatPanelHostMessage` union
  (also re-added `AiChatPanelEngine` + `AiChatPanelGroundingState` which
  had drifted out of the union).
- `runOmpEngineTurn` now: connecting (before send) → running (first
  non-aborted stream event, posted exactly once) → done in finally
  (gated `!postedError` so a crashed turn ends on the error state, not a
  misleading "done") → error in onError/catch.
- Webview `#sessionChip` textContent-only; re-uses or creates
  `#sessionChip` inside the engine banner; class names
  `UnicDB-chat-session-{connecting|running|done|error}`.

## Reviewer


(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
