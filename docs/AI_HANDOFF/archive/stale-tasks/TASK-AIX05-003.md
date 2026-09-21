# TASK-AIX05-003 — protocol error recovery + detection reason surfacing

Cycle: AIX-05 · Wave 4 · Priority: P1
Status: pending
Depends on: AIX05-002
Reviewer: unic-smart (cycle reviewer)

## Spec

Make the OMP notification path crash-proof and pin the binary-detection
hint mapping:

1. `src/ai/omp/ompChatEngine.ts` — `dispatchNotification` hardening:
   - Unknown methods → dropped silently (no throw, no event).
   - Malformed params (`null`, non-object, missing fields) → dropped
     silently (the existing `isParamsRecord`/`stringField` guards stay;
     add a top-level catch so a bad frame can NEVER reject a turn).
   - `tool_call` frames missing `name`, or `tool_call_update` missing an
     id → dropped without touching `hostMcp.call`.
2. Tests (append to `src/ai/omp/__tests__/ompChatEngine.test.ts`):
   - unknown method frame → no event, no throw, turn still completes.
   - malformed-params frame → same.
## Executor

**RED**: scaffold missing. Added new test files.

**GREEN**:
- `npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts` →
  14 passed (14). Added "dispatchNotification (AIX-05 protocol
  robustness)" block: unknown method + null params dropped silently;
  next valid chunk still streams; tool_call without name does not
  touch hostMcp.
- `npx vitest run src/ai/__tests__/engineChoice.test.ts` →
  6 passed (6). All four detection reasons pinned to the right hint
  (not-installed / spawn-failed / version-unknown → INSTALL_HINT;
  version-too-old → UPDATE_HINT). Builtin/omp ok path regression
  pinned.

Notes:
- `dispatchNotification` got a `isParamsRecord(n)` top guard (defense
  in depth) — guards below already early-return on bad shape, this
  catches a future change that throws before the existing guards.
- `resolveEngine` hint now keys off `detection.reason` instead of
  `detection.available` so the two `available:true` reasons
  (version-too-old vs version-unknown) can diverge correctly.

## Reviewer
   - after a malformed frame, a valid `agent_message_chunk` still
     streams (engine survives).
3. Detection reason → hint mapping tests
   (`src/ai/__tests__/engineChoice.test.ts` — create if missing):
   - `not-installed` → hint contains `OMP_INSTALL_HINT`;
   - `version-too-old` → hint contains `OMP_UPDATE_HINT`;
   - `version-unknown` → INSTALL hint;
   - `spawn-failed` → INSTALL hint.
   Fix `resolveEngine`/hint wiring if any case diverges.

## Acceptance

- [ ] Malformed/unknown frames never throw and never abort a turn.
- [ ] Reason → hint mapping pinned for all four detection reasons.
- [ ] `npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts` and
      `npx vitest run src/ai/__tests__/engineChoice.test.ts` green.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
**Status: done (reviewer APPROVED — see verdict block in TASK-AIX05-001.md)**
