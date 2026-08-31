# TASK-AIX05-002 — OMP cancellation + restart hardening

Cycle: AIX-05 · Wave 4 · Priority: P1
Status: pending
Depends on: AIX05-001
Reviewer: unic-smart (cycle reviewer)

## Spec

Fix the OMP cancellation gap and pin restart safety:

1. `src/ai/omp/ompChatEngine.ts`:
   - Add `cancel(): void` to the `OmpChatEngine` interface.
   - The engine closure tracks `currentSessionId` (set after
     `session/new` in `send()` and after `session/load` in `resume()`;
     cleared when the turn settles / on error).
   - `cancel()` sends `acp.notify("session/cancel", {sessionId})`
     fire-and-forget; no-op when no turn is in flight; idempotent
     (double-cancel sends once per active session).
2. `src/ui/aiChatPanel.ts` `handleStop()`: when
   `this.engine === "omp"` AND `this.options.ompChatEngine` is present,
   call `engine.cancel()` (in addition to `token.aborted`). The legacy
   `acpSession` branch stays for `runAcpTurn`.
3. Restart pins (tests):
   - send → cancel → send: the second `send()` performs a NEW
     `session/new` (fresh sessionId; the engine never reuses a cancelled
     session).
   - crash mid-turn (session/prompt rejects) → next `send()` creates a
     fresh session (restart edge).
   - Stop in omp mode must NOT double-cancel (panel calls cancel; the
     engine dedupes).

## Acceptance

- [ ] `OmpChatEngine.cancel` sends `session/cancel` with the ACTIVE
      sessionId; no-op without a turn; idempotent.
- [ ] Panel Stop in omp-engine mode invokes `engine.cancel()`.
- [ ] Restart pins green: fresh session after cancel and after crash.
- [ ] `npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts` +
      `npx vitest run src/ui/__tests__/aiChatPanelEngine.test.ts` green
      (new cases appended to existing files).

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
