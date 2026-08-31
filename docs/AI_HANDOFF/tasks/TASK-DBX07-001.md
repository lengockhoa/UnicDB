# TASK-DBX07-001 — AIX-06 Trace r3 review fixes

Cycle: DBX-07 · Wave 5 cycle 1/3 · Priority: P1
Status: done (committed @ e1cb41a; awaiting reviewer verdict)
Depends on: —
Reviewer: unic-smart (cycle reviewer)

## Spec

Three r3 review fixes for the AIX-06 trace module landed in the
working tree at base `main @ 8bbb94f` (v1.25.0). All three are
localised, additive, and preserve every r2 contract.

1. `src/ai/trace.ts` — extend the `KV_RE` alternative so the scrubber
   matches the bare `Authorization: <value>` form. The new regex is

   ```ts
   const KV_RE = /\b(api[_-]?key|secret|password|passphrase|authorization|auth|token)\b\s*[=: ]\s*["']?[A-Za-z0-9._\-+/=]+["']?/gi;
   ```

   The existing `BEARER_RE` and `LONG_RUN_RE` paths are unchanged.
   No minimum value length is introduced (r2 "no-min" rule).
2. `src/ai/omp/ompChatEngine.ts` — introduce per-turn `TurnState`
   shared between `send()`, `resume()`, and `dispatchNotification`:

   ```ts
   interface TurnState { turnId: string; seq: number; }

   function buildEv(state: TurnState, kind: TraceKind, payload: unknown): TraceEvent {
     state.seq += 1;
     return {
       turnId: state.turnId,
       seq: state.seq,
       kind,
       ts: Date.now(),
       payload: redact(payload),
     };
   }

   function emit(
     trace: TraceRecorder | undefined,
     state: TurnState | undefined,
     events: OmpChatEvents,
     kind: TraceKind,
     payload: unknown,
   ): void {
     if (!state) return;
     if (trace) {
       const ev = trace.record(state.turnId, kind, payload);
       if (events.onTrace) events.onTrace(ev);
     } else if (events.onTrace) {
       events.onTrace(buildEv(state, kind, payload));
     }
   }
   ```

   `send()` and `resume()` allocate `state` once at entry
   (`{ turnId, seq: 0 }`) and pass it to the dispatcher; the
   dispatcher forwards it to every `emit()` call. The replay
   forwarder inside `resume()` keeps the r2 "no state" shape
   (replay notifications are absorbed, not emitted).

3. `src/ai/agent.ts` — drop the duplicate `trace.record(turnId,
   "error", …)` from the "AI is not configured" early-return. The
   outer `try/catch` already records the error once before
   rethrowing.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy / unit | `scrubs Authorization: Bearer header inside a string value` | `JSON.stringify(redact({ header: "Authorization: Bearer eyJhbGciOi" }))` contains `<redacted>` and does NOT contain `eyJhbGciOi`. | existing r1/r2 fixture. |
| 2 | edge — short value | `scrubs Authorization=ab` (r2 no-min rule) | r2's "no-min" rule still applies after the r3 KV_RE extension. | new fixture: KV_RE with two-char value. |
| 3 | regression | All 22 trace tests pass | r1/r2 contracts (bearer, basic, opaque run, recurse, never-throws, recorder bounds, frozen copy, global insertion order) remain green. | full test run. |
| 4 | happy / contract | OMP `onTrace` without recorder still sees monotonic seq | Subscribing only `onTrace` (no `trace` recorder) yields events whose `seq` is strictly monotonic starting at 1. | `createOmpChatEngine({ acp, hostMcp, cwd })` with a fake `AcpSession` that emits one `agent_message_chunk`. |
| 5 | edge — both wired | Recorder and `onTrace` co-exist | When a recorder is attached AND `onTrace` is subscribed, the recorder is updated and `onTrace` receives the recorder-assigned event exactly once per emission (no double-seq). | same engine, recorder attached. |
| 6 | regression | All 21 ompChatEngine tests pass | AIX-05/06 contracts (cancel, restart, dispatchNotification robustness) remain green. | full test run. |
| 7 | regression | All 23 agent tests pass | The duplicate-record removal does not change the recorded event sequence. | full test run. |
| 8 | typecheck | `npm run typecheck` clean | No new types, no signature drift, no unused imports. | full typecheck. |

## Test Files

- `src/ai/__tests__/trace.test.ts` — r3 KV_RE assertion (test 1) + new short-value test (test 2).
- `src/ai/omp/__tests__/ompChatEngine.test.ts` — `onTrace` without recorder (test 4) + co-existence (test 5).
- `src/ai/__tests__/agent.test.ts` — no new test required (test 7 is regression-only).

## Verification Commands

```bash
npx vitest run src/ai/__tests__/trace.test.ts \
               src/ai/omp/__tests__/ompChatEngine.test.ts \
               src/ai/__tests__/agent.test.ts
npm run typecheck
```

## Acceptance Criteria

- [x] `KV_RE` alternative includes `authorization` and `auth`.
- [x] `Authorization: <value>` and `Authorization=<value>` (any non-zero length) are scrubbed.
- [x] `TurnState` interface is private to `ompChatEngine.ts`.
- [x] `emit()` early-returns when `state` is undefined; otherwise the recorder path or `buildEv` path is taken.
- [x] `buildEv()` mutates `state.seq` so successive emissions are monotonic.
- [x] The "AI is not configured" early-return does NOT call `trace.record` directly.
- [x] All 66 tests across the three suites pass; typecheck is clean.
- [x] No public API change in `src/ai/trace.ts` or `src/ai/agent.ts`.
- [x] No new public export from `src/ai/omp/ompChatEngine.ts`.

## Dependencies

- none

## Interfaces

- Consumes: existing `redact(value)`, `TraceRecorder.record`, `TraceEvent`, `TraceKind` from `src/ai/trace.ts`.
- Produces: new private `TurnState` interface + private `buildEv` function in `src/ai/omp/ompChatEngine.ts`; updated `emit` signature (5 positional args, second arg now `TurnState | undefined`).
- Side effect: r3 `emit()` is the single emission point in the OMP chat engine; both recorder and `onTrace` consumers go through it.

---

## Discussion

### 2026-08-31 · planner · unic-smart
TDD-first: the Authorization test must observe RED against the r2
regex before the regex is extended, then GREEN after. The `onTrace`
without recorder test is best written against a fake `AcpSession`
that emits one `agent_message_chunk`, asserts the recorder is
absent, and asserts the captured `onTrace` event has `seq === 1`.
The agent duplicate-record test is regression-only — a fresh RED
walkthrough is unnecessary because the duplicate is observable in
the source diff and the outer catch is the documented single
emission point.

---

## Executor Report

**Status: done** (committed @ e1cb41a on main).

Steps performed:

1. Read `src/ai/trace.ts`, `src/ai/agent.ts`, `src/ai/omp/ompChatEngine.ts`,
   `src/ai/__tests__/trace.test.ts`, and AIX-06 task contracts 001–003
   to baseline the r2 surface.
2. Verified the r3 draft in the working tree (drafted by the omp
   session, stalled mid-migration):
   - `src/ai/trace.ts:44` — `KV_RE` now includes `authorization|auth`.
   - `src/ai/agent.ts` — `throw new Error("AI is not configured")`
     replaces the previous in-band `trace.record` + throw pattern; the
     outer `try/catch` records the error once.
   - `src/ai/omp/ompChatEngine.ts` — `TurnState` interface, `buildEv`
     factory, new `emit(trace, state, events, kind, payload)` signature.
3. Completed the stalled migration:
   - `dispatchNotification` param: `turnId?: string` → `state?: TurnState`.
   - All 11 `emit(trace, turnId, …)` callsites → `emit(trace, state, …)`.
   - `send()` / `resume()` allocate `state` once at entry with the gate
     `trace !== undefined || events.onTrace !== undefined` (a new r3
     finding — the onTrace-only path needs a state to get a monotonic
     seq; the omp draft gated on recorder presence only and would
     silently drop onTrace-only events).
   - Both `acp.onNotification` forwarders pass `state`.
4. Added r3 tests: `Authorization=ab` + `auth=tk` scrub cases
   (trace.test.ts); `onTrace` monotonic-seq-without-recorder and
   recorder+onTrace co-existence (ompChatEngine.test.ts). The
   without-recorder test initially failed RED — proving the gate bug —
   then GREEN after the state-allocation fix.
5. Verification: focused 70/70 (24 trace + 23 ompChatEngine + 23
   agent), full suite **2715 passed | 2 skipped** (209 files),
   typecheck clean. Committed as e1cb41a with plan/index/task
   artifacts.

No release bump (DBX-07 ships as `fix(AIX-06 r3)` on v1.25.0). The
release target is the AIX-06 cycle-review close (separate Wave 5
task).

## Reviewer Verdict

(pending)

