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

(to be filled by executor with RED + GREEN evidence)
