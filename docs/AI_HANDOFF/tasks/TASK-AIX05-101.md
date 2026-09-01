# TASK-AIX05-101 — ACP child lifecycle and bounded reaping

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX05.md` §3

## Goal

Make `AcpProcess` the observable, bounded owner of its `omp acp` child. Pin explicit lifecycle state, fail closed on ACP protocol drift, and ensure disposal/cancellation cannot leave an orphan child.

## Target Files

- `src/ai/omp/acpProcess.ts` — export the six-literal `OmpEngineState`; add lifecycle observation and idempotent cancellation/disposal with bounded child reaping; validate initialize-result protocol version before sending `initialized` or `session/new`.
- `src/ai/omp/__tests__/acpProcess.test.ts` — extend the existing `FakeChildProcess` fixture and add lifecycle, protocol mismatch, cancellation, and bounded-reap tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | valid initialize and session/new reaches ready | State observer sees exactly `"starting"`, `"ready"`; handle exposes returned session ID and no kill occurs before explicit teardown. | Existing PassThrough fake child replies `{ protocolVersion: 1 }` to initialize, then a string `sessionId` to session/new. |
| 2 | edge — child exit while starting | handshake never completes after clean child exit | Fake child exits with `0` before initialize response; `start()` rejects rather than timing out; exact state events are `"starting"`, `"crashed"`, `"fallback-builtin"`, with child reaped. | Existing `FakeChildProcess`; no stdout handshake frame. |
| 3 | edge — child exit while ready | post-handshake crash is classified once | After a ready handshake, fake child exits nonzero; exact appended event is `"crashed"` once and the handle’s close path fires once for the panel restart/fallback owner. | Existing PassThrough handshake fixture and `AcpClient.onClose` spy. |
| 4 | edge — child exit while cancelling | cancel-initiated exit reaches stopped, never crash | Ready handle’s `cancel()` emits `"cancelling"`, sends exactly one cancellation notification/termination; fake child exit then emits exactly `"stopped"`, with no `"crashed"` or `"fallback-builtin"` event. | Deferred ready fake child; call `cancel()` twice, then emit exit. |
| 5 | edge — spawn failure | spawn error transitions to fallback | `start()` rejects with the spawn error; observed terminal state is exactly `"fallback-builtin"`; no usable handle is returned. | Fake child emits `Error("spawn omp ENOENT")` before initialize reply. |
| 6 | edge — protocol boundary | incompatible initialize version is rejected | `start()` rejects with exactly `OMP ACP protocol version mismatch: expected 1, received 2`; state sequence ends `"fallback-builtin"`; stdin never receives `initialized` or `session/new`; child is terminated. | Fake child replies to initialize with `{ protocolVersion: 2 }`. |
| 7 | regression — non-exiting child | dispose has a bounded reap and ignores late exit | With fake timers, dispose waits `OMP_ACP_DISPOSE_TIMEOUT_MS = 2000`, escalates termination once, reports `"stopped"` once, and a later exit emits neither a new state nor another kill. | Ready fake child ignores initial terminate until test emits a late exit. |

## Test Files

- `src/ai/omp/__tests__/acpProcess.test.ts` — all cases above; follow its existing PassThrough/EventEmitter fake-ACP fixture style.

## Verification Commands

```bash
npx vitest run src/ai/omp/__tests__/acpProcess.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `OmpEngineState` is exactly `"stopped" | "starting" | "ready" | "cancelling" | "crashed" | "fallback-builtin"` and `AcpProcess` emits only valid transitions for one runtime generation: starting exit → crashed → fallback-builtin; ready exit → crashed; cancelling exit → stopped with no crash/fallback.
- [ ] `AcpProcess.start(handlers?: AcpStartHandlers): Promise<AcpProcessHandle>` rejects initialize results whose `protocolVersion !== 1` with exactly `OMP ACP protocol version mismatch: expected 1, received <received>`.
- [ ] An incompatible initialize result sends neither `initialized` nor `session/new`, terminates/reaps the child, and has terminal state `"fallback-builtin"`.
- [ ] Returned ready handles provide idempotent current-turn cancellation; disposal is bounded by `OMP_ACP_DISPOSE_TIMEOUT_MS = 2000` and leaves no child ownership/live callbacks behind.
- [ ] The current spawn invariants remain: `cwd` passed to spawn unconditionally, `--cwd` conditional on `supportCwdFlag`, no approval-auto arguments, and Windows-specific quoting/shell behavior unchanged.
- [ ] All verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes:
  - `AcpProcess.start(handlers: AcpStartHandlers = {}): Promise<AcpProcessHandle>` at `src/ai/omp/acpProcess.ts:117`, extended in this task with `AcpProcess.cancel(): void` for cancellation before a pending `start()` resolves.
  - `AcpClient.request<T = unknown>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>` at `src/ai/omp/acp.ts:143-147`.
  - Existing initialize payload `{ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "vsdb-extension", version: "1.5.1" } }` at `src/ai/omp/acpProcess.ts:229-235`.
- Produces:
  - `export type OmpEngineState = "stopped" | "starting" | "ready" | "cancelling" | "crashed" | "fallback-builtin"`.
  - `AcpStartHandlers.onStateChange?: (state: OmpEngineState) => void`.
  - Expanded `AcpProcessHandle` members `state(): OmpEngineState`, `cancel(): void`, and `dispose(): Promise<void>`, retaining `acp: AcpClient`, `sessionId: string`, `version: string`, and optional `getStderrTail?: () => string`. `cancel()` is terminal: ready → cancelling → exit-observed → stopped; cancellation during starting aborts handshake → stopped; neither route emits crashed/fallback. TASK-AIX05-103 consumes these exact members.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Grounding: `src/ai/omp/acpProcess.ts` is the only spawn site under `src/ai/omp/`; its current `ChildLike` only exposes `exit`/`error`/`kill`, and `disposeClient()` kills without awaiting exit. `src/ai/omp/__tests__/acpProcess.test.ts` already provides the correct fake ACP transport and handshake driver. Do not invent a second spawn owner. The production interface extension name is intentionally left to RED/GREEN design, but it must be recorded before dependent integration consumes it rather than guessed here.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  7 failing tests added (TASK-AIX05-101 §Test Cases #1..#7). Sample output:

  ❯ AcpProcess > TASK-AIX05-101: lifecycle, protocol mismatch, cancellation, bounded reap
    > valid initialize + session/new reaches ready; onStateChange sees exactly [starting, ready]
      AssertionError: expected undefined to be 'starting'
    > clean child exit while starting emits [starting, crashed, fallback-builtin]
      AssertionError: expected undefined to be 'starting'
    > cancel() on a ready handle emits cancelling, then stopped
      AssertionError: expected [] to deeply equal [ 'starting', 'ready' ]
    > incompatible initialize version rejects with pinned message
      Error: Test timed out in 5000ms.
    > dispose() has a bounded reap
      AssertionError: expected [] to deeply equal [ 'starting', 'ready' ]

  Tests 7 failed | 20 passed (27)
Verification Output: |
  Focused: npx vitest run src/ai/omp/__tests__/acpProcess.test.ts → 27 passed (27)
  Wider regression: npx vitest run src/ai/omp src/extension.test.ts → 205 passed | 2 skipped (207)
  typecheck (npm run typecheck): exit 0
  compile (npm run compile): esbuild build complete
Status: PASS
Note: All 7 new test cases pass; all 20 pre-existing tests and 158 other module tests still pass.

## Reviewer Verdict

VERDICT: approved_minor
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
TEST_PLAN_COVERAGE: all-followed (7/7 §Test Cases implemented and green; typecheck + compile both exit 0)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/omp/acpProcess.ts:201-208 — `spawnErrored` and `lastSpawnError` are dead state: `spawnErrored` is set (line 311) but never read anywhere; `lastSpawnError` is stored on the instance but only consumed by the immediate `reject(...)` at line 313. The field comments claim the outer catch reuses them to surface the original spawn error, but the catch actually reads the thrown `err` (the real mechanism is `Promise.race([acp.request, startError])`). Drop both fields and correct the comments so they describe the path that actually runs.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: State machine, protocol-version validation (pinned literal + fallback), cancel/dispose bounded-reap semantics, and the single spawn site are all correct and match the pinned contract. The instance `cancel()` seam and cancel-during-starting path are consumed by TASK-AIX05-103's integration (outside the pinned §Test Cases list) rather than unit-tested here.

## R4.5 Fix Round 1

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED: not-applicable (dead-field cleanup, no new test surface)
GREEN: npx vitest run src/ai/omp/__tests__/acpProcess.test.ts → 27 passed (27)
       npm run typecheck → exit 0
       npm run compile → esbuild build complete
STATUS: PASS
COMMIT: 9581881 handoff: fix 101 R4.5 — drop dead spawnErrored/lastSpawnError fields
NOTE: Dropped dead `spawnErrored` (line 311 set, never read) and `lastSpawnError` (stored, only consumed by the immediate `reject(...)` at line 313) instance fields. Corrected the `startError` comment so it describes the actual `Promise.race` mechanism: spawn 'error' rejects directly with the original error, and the immediate `reject()` IS the real path — no stored field is involved. All 7 §Test Cases still pass; the 20 pre-existing tests and 158 other module tests stay green.
