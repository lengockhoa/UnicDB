# TASK-ARP05-003 — MSSQL paused-stream survival, cancel timeout, no enqueue wedge

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§4 (ARP-05.3)

## Goal

Pin the MSSQL adapter's finite-failure contract: a paused streaming SELECT is not timed out
(`requestTimeout: 0` — `mssql.ts:554`), a live request cancels within `cancelTimeout: 5_000`, and a late
completion/cancel cannot wedge the single-in-flight `enqueue` chain (`mssql.ts:574-587`). Production code
changes only where a probe proves a gap — today the MSSQL posture is deliberate (`mssql.ts:548-554`) and is
expected to be pin-only.

## Target Files

- `src/adapters/mssql.ts` — **only if a probe proves a gap** (e.g. a cancel path that never settles, an
  `enqueue` chain that deadlocks on a late rejection). Default expectation: no change (pin-only).
- `src/adapters/__tests__/mssql.parameterized.test.ts` — **the owned test file**; add the ARP-05.3 cases
  below, reusing the existing fake-Connection / instance-level `newRequest`-shadow pattern.
- `docs/decisions/0002-cross-driver-resilience-contract.md` — **append** the measured RED/GREEN probe results
  under a disjoint named section `## Probe: MSSQL` (per PLAN.md §3 wave-1 ADR-update protocol). Append-only,
  section-disjoint docs edit — no same-wave `src/` file is shared. Paste the probe lines verbatim; do not
  modify wave-0 content or other tasks' sections.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (pin) | streaming SELECT not timed out while rows still flow | `requestTimeout: 0` → no timer armed on `execSql`; a long paused stream survives load-more (pins `mssql.ts:548-554`) | fake tedious Connection recording the request options used at `createConnection` |
| 2 | edge: resource | live request cancels within `cancelTimeout` | `request.cancel()` settles the awaiting `runRequest`/stream path within 5s; `activeRequests` drained (pins `mssql.ts:555,205-211`) | fake Request whose `cancel()` invokes the error path; assert `finish(error)` settles and the set empties |
| 3 | edge: late error | late completion cannot wedge the `enqueue` chain | a settled/failed request resolves `next` in `enqueue` so the following queued operation proceeds; no deadlock, no unhandled rejection (pins `mssql.ts:574-587`) | two queued operations; the first rejects; assert the second still runs |
| 4 | edge: connect | `connect()` failure cleans up the connection | fail/error path → `clearConnection` + `connection.close()` best-effort; `connecting` reset in `.finally` (pins `mssql.ts:121-196`) | fake connection whose `connect()` emits `error`; assert `close` called and `connecting` nulled |
| 5 | edge: late/cancel | cancel after settle is a no-op | `request.cancel()` on an already-completed request swallows; `settled` guard keeps state final (pins `mssql.ts:608-624`) | request already settled via `request.callback`; call `request.cancel()`; assert `finish` not re-invoked |

## Test Files

- `src/adapters/__tests__/mssql.parameterized.test.ts` — contains the cases above. (The integration file
  `mssql.integration.test.ts` is DB-gated and excluded from this task's run.)

## Verification Commands

```bash
grep -qi "## Probe: MSSQL" docs/decisions/0002-cross-driver-resilience-contract.md
npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `mssql.ts` → tests-map `[mssql.integration.test.ts, mssql.parameterized.test.ts,
mssql.sortQuery.test.ts]`. The pinned target is `mssql.parameterized.test.ts` (DB-free);
`mssql.integration.test.ts` is DB-gated; `mssql.sortQuery.test.ts` runs in the wave/cycle `npm test` net.)

## Acceptance Criteria

- [ ] Cases 1–5 pass (TDD: RED probe output pasted before implementation; pin cases stay GREEN on today's code).
- [ ] The RED/GREEN probe results are appended to the ADR under `## Probe: MSSQL` (grep check exits 0); wave-0 ADR content and other tasks' sections untouched.
- [ ] If a production gap was found: the probe that proved it is pasted and the change is minimal; if no gap: `git diff 65b9c4f -- src/adapters/mssql.ts` is empty (pin-only, recorded in the Executor Report).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] No regression: `requestTimeout: 0` streaming, `cancelTimeout: 5_000`, and the one-request `enqueue` chain preserved; cancel-in-`close()` (ARP-02 seam) preserved.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP05-000 — the ADR records the SLO/no-replay decision this task must not violate, and the MSSQL rows of the matrix are its source of truth.

## Interfaces

- Consumes: (none). Reads the ADR `docs/decisions/0002-cross-driver-resilience-contract.md` (MSSQL matrix +
  SLO/no-replay). Grounding: `MsSqlAdapter` (`connect` :113-196, `close` :198-223, `enqueue` :574-587,
  `runRequest` :589-657, `openStreamingQuery` :671, `createConnection` :514-559 with `requestTimeout: 0` at
  :554 and `cancelTimeout: 5_000` at :555). Driver import is top-level (`import { Connection, Request, TYPES } from "tedious"` at :1).
- Produces: (none) for later tasks — the pins live in `mssql.parameterized.test.ts`. **The ADR append
  (`## Probe: MSSQL`) feeds ARP-05.4's gate** and completes the wave-0 measurement contract. If a production
  change was made, it must stay within `src/adapters/mssql.ts` and preserve the signatures above.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
