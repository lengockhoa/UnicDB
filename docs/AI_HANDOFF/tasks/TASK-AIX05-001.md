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

- [ ] Host posts connecting → running → done in order for a clean omp
      turn; error state before the error bubble on crash.
- [ ] `running` is posted exactly once per turn (first stream event).
- [ ] Webview chip renders each state (textContent-only; no innerHTML in
      the chip function).
- [ ] `npx vitest run src/ui/__tests__/aiChatPanelSessionState.test.ts`
      green (host transitions) and
      `npx vitest run src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts`
      green (chip render).

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
