# TASK-ARP05-002 — MySQL held-connection streaming + bounded acquire wait

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§4 (ARP-05.2)

## Goal

Pin the MySQL adapter's streaming/cancel/terminal-error contract around the single held `connectionLimit: 1`
connection, and **bound the source-proven unbounded wait**: `queueLimit: 0` (`mysql.ts:157`) with the only
slot held makes every later connect/query enqueue forever. This is the one production change the cycle
expects — an `acquireTimeout` bound so a late request with a held connection terminates within a bounded
wait — while preserving streaming, atomic batches, and terminal (no-replay) cancellation.

## Target Files

- `src/adapters/mysql.ts` — add a bounded acquire wait to the pool (`mysql.ts:149-158`): read
  `acquireTimeout` from a **module-scoped constant `POOL_ACQUIRE_TIMEOUT_MS`** (default `10_000`, aligned
  with `connectTimeout`), keep `waitForConnections: true`. The constant must be overridable so the DB-free
  suite can exercise the bound deterministically without a real 10s wait. Record the chosen value in the ADR
  (`docs/decisions/0002-cross-driver-resilience-contract.md`). Do NOT change
  `connectionLimit: 1`, `timeout: 0` streaming, or the batch/cancel paths — pin those instead.
- `src/adapters/__tests__/mysqlQueueBound.test.ts` — **new focused DB-free unit suite** (new) for the
  queue-bound + streaming/cancel/terminal pins, mocking `mysql2/promise` (`createPool`, `PoolConnection`,
  stream).
- `src/adapters/__tests__/adapterQueryShape.test.ts` — add the routing/shape regression (case 1) reusing the
  existing pattern that monkeypatches the adapter's private `query()`; no mysql2 module mock needed for the
  pure routing assertion.
- `docs/decisions/0002-cross-driver-resilience-contract.md` — **append** the measured RED/GREEN probe results
  under a disjoint named section `## Probe: MySQL` (per PLAN.md §3 wave-1 ADR-update protocol), and record
  the chosen `acquireTimeout` bound there. Append-only, section-disjoint docs edit — no same-wave `src/` file
  is shared. Paste the probe lines verbatim; do not modify wave-0 content or other tasks' sections.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (pin) | single-SELECT routes to streaming; multi-statement batch atomic | `singleSelect` → `openStreamingQuery` returns `{ results: [], batched }`; a multi-statement batch holds ONE connection and runs `beginTransaction`/each statement/`commit`/`release` exactly once (pins `mysql.ts:231-304`) | mocked `PoolConnection` recording `beginTransaction`/`commit`/`release` calls |
| 2 | edge: resource (RED) | held single connection + late request terminates within a bounded wait | with the `connectionLimit: 1` slot held (stream/tx), a second connect/query must fail/throw within a **bounded, injectable** acquire wait. Assert BOTH: (a) config — the pool factory options now include `acquireTimeout` (probe RED on today's code: `queueLimit: 0` + no `acquireTimeout` = unbounded); (b) behavior — a held second checkout rejects within the bound. **No real 10s wait:** override `POOL_ACQUIRE_TIMEOUT_MS` to a short value (e.g. 50ms) and/or use `vi.useFakeTimers`/`vi.advanceTimersByTime` so the test is fast and deterministic | mocked pool whose single connection is held; second `getConnection()` returns a pending promise that the test resolves/rejects on timer advance; `POOL_ACQUIRE_TIMEOUT_MS` stubbed short |
| 3 | edge: cancel | cancel is terminal — no replay | `cancelActiveQuery` destroys the held connection/stream; a later repeat cancel is a silent no-op; the statement/mutation/transaction/cursor is never re-issued (pins `mysql.ts:343-368,796-828`) | mocked connection with `destroy` spy; `activeCancelClosures` set with one closure; call cancel twice |
| 4 | edge: late error | stream ends without `fields`/`error` does not hang | `openStreamingQuery` settles on `end` (empty-result success), releases the pool connection (pins `mysql.ts:682-705`) | mocked stream emitting only `end`, no `fields`; assert `openStreamingQuery` resolves and releases |
| 5 | edge: connect-fail | `connect()` failure closes the pool and nulls it | `getConnectionWithUtcSession`/`ping` throws → `pool.end().catch(()=>undefined)`, `this.pool = null`; a later `connect()` rebuilds a fresh pool (pins `mysql.ts:184-196`) | mocked pool whose `getConnectionWithUtcSession` rejects; `end` spy records calls |

## Test Files

- `src/adapters/__tests__/mysqlQueueBound.test.ts` (new) — cases 2–5 (DB-free, mysql2/promise mocked).
- `src/adapters/__tests__/adapterQueryShape.test.ts` — case 1 (pure routing/shape regression).

## Verification Commands

```bash
grep -qi "## Probe: MySQL" docs/decisions/0002-cross-driver-resilience-contract.md
grep -qi "acquireTimeout" docs/decisions/0002-cross-driver-resilience-contract.md   # chosen bound recorded
npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
npx vitest run src/adapters/__tests__/mysqlQueueBound.test.ts
npm run typecheck
npm run compile
```

(The queue-bound test MUST assert termination within the injected bound — stub `POOL_ACQUIRE_TIMEOUT_MS`
short and/or use `vi.useFakeTimers`; never wait a real 10s in the DB-free suite. The real 10_000 default is
the production value and is recorded in the ADR.)

(Selection per RULES: `mysql.ts` → tests-map `[mysql.integration.test.ts, mysql.sortQuery.test.ts]`.
`mysql.integration.test.ts` is DB-gated; the DB-free pins live in the new `mysqlQueueBound.test.ts` plus the
existing `adapterQueryShape.test.ts`. The mandatory non-empty floor is satisfied by these two DB-free files;
the full suite runs at the wave/cycle boundary.)

## Acceptance Criteria

- [ ] Cases 1–5 pass; case 2 is RED on 65b9c4f (unbounded `queueLimit: 0` + no `acquireTimeout`) and the RED probe output is pasted before the fix.
- [ ] Case 2 asserts termination within a bounded, **injectable** wait (short stubbed bound and/or `vi.useFakeTimers`) — the suite never waits a real 10s.
- [ ] Streaming, atomic batches, and the cancel/terminal-error paths are preserved (regression pins) — only the acquire wait is bounded.
- [ ] The RED/GREEN probe results are appended to the ADR under `## Probe: MySQL` and the chosen bound (`acquireTimeout`) is recorded there (both greps exit 0); wave-0 content and other tasks' sections untouched.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] No mutation/transaction/cursor automatic replay anywhere; ARP-02 destroy-terminal cancel semantics preserved.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP05-000 — the ADR records the MySQL unbounded-wait gap and the SLO/no-replay decision; the chosen bound is recorded there.

## Interfaces

- Consumes: (none). Reads the ADR (MySQL matrix + known-gap section). Grounding: `MySqlAdapter`
  (`connect` :144-196, `close` :198-204, `runQuery` :219-304, `beginTransaction` :306-336,
  `cancelActiveQuery` :357-368, `getConnectionWithUtcSession` :613, `openStreamingQuery` :648-705); pool
  config at :149-158 (`connectionLimit: 1`, `waitForConnections: true`, `queueLimit: 0`, `connectTimeout: 10_000`).
- Produces: (none) for later tasks. If the acquire bound is added, it lives in `src/adapters/mysql.ts` only
  and the pool option shape is `mysql2`'s `PoolOptions` (add `acquireTimeout: POOL_ACQUIRE_TIMEOUT_MS`).
  **The ADR append (`## Probe: MySQL`) + recorded bound feed ARP-05.4's gate** and complete the wave-0
  measurement contract.

---

## Discussion

### 2026-09-02 · executor · claude-code / unic-code
Design decision (resolved per task §Interfaces + ADR §4, recorded for the
reviewer): the task/PLAN spec expected `acquireTimeout` as a mysql2 pool
option. **Measured: mysql2 3.23.4 does not implement that option** — passing
it logs `Ignoring invalid configuration option passed to Connection:
acquireTimeout` (once per `createPool`) and the underlying queue still waits
forever (`mysql2/lib/pool_config.js` knows only `waitForConnections/
connectionLimit/maxIdle/idleTimeout/queueLimit/resetOnRelease`; no timeout in
`base/pool.js getConnection()`). Implementation therefore does BOTH: (1) the
option `acquireTimeout: POOL_ACQUIRE_TIMEOUT_MS` stays on the factory as the
declared contract (case 2a pins it; future drivers converge), and (2) the
ENFORCED bound is a `Promise.race` at the single checkout choke point
`getConnectionWithUtcSession()` — driver-agnostic, and a late loser checkout
that the pool hands out after the timeout is released immediately (no slot
leak). The bound is injectable via `setPoolAcquireTimeoutMsForTests` (suite
stubs 50ms; production default 10_000 aligned with `connectTimeout`). No
change to `connectionLimit: 1`, `timeout: 0` streaming, batch/cancel paths.
Full evidence in ADR §7 `## Probe: MySQL`.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Claude:feature-implementer
Status: PASS

RED_OUTPUT (step 1, base 0dd021e == 65b9c4f content for mysql.ts):

```
$ npx vitest run src/adapters/__tests__/mysqlQueueBound.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-arp05-002

 ❯ src/adapters/__tests__/mysqlQueueBound.test.ts  (5 tests | 2 failed) 2047ms
   ❯ ... > case 2a: pool factory options include acquireTimeout = the injected POOL_ACQUIRE_TIMEOUT_MS
     → expected undefined to be 50 // Object.is equality
   ❯ ... > case 2b: a late request against a held single slot rejects within the injected bound
     → Test timed out in 2000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".

 FAIL  src/adapters/__tests__/mysqlQueueBound.test.ts > MySqlAdapter — bounded acquire wait (TASK-ARP05-002 case 2) > case 2a: pool factory options include acquireTimeout = the injected POOL_ACQUIRE_TIMEOUT_MS
AssertionError: expected undefined to be 50 // Object.is equality

- Expected:
50

+ Received:
undefined

 ❯ src/adapters/__tests__/mysqlQueueBound.test.ts:190:41
    189|     const pool = lastPool();
    190|     expect(pool.options.acquireTimeout).toBe(50);

 FAIL  src/adapters/__tests__/mysqlQueueBound.test.ts > MySqlAdapter — bounded acquire wait (TASK-ARP05-002 case 2) > case 2b: a late request against a held single slot rejects within the injected bound
Error: Test timed out in 2000ms.

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
   Duration  2.32s
```

Exactly the expected RED: today `queueLimit: 0` + no `acquireTimeout` = the
late request waits forever (case 2b hits the 2s test timeout, i.e. unbounded)
and the factory options carry no `acquireTimeout` (case 2a). The 3 pins
(streaming/cancel/terminal) pass on the pre-state — existing behavior,
pinned unchanged.

Verification Output (all six task commands, fresh in this turn):

```
$ grep -qi "## Probe: MySQL" docs/decisions/0002-cross-driver-resilience-contract.md
PASS exit 0
$ grep -qi "acquireTimeout" docs/decisions/0002-cross-driver-resilience-contract.md
PASS exit 0

$ npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
 Test Files  1 passed (1)
      Tests  55 passed (55)   [includes new case 1a/1b routing pins]

$ npx vitest run src/adapters/__tests__/mysqlQueueBound.test.ts
 ✓ src/adapters/__tests__/mysqlQueueBound.test.ts  (5 tests) 88ms
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ npm run typecheck
> tsc --noEmit            (exit 0)

$ npm run compile
⚡ Done in 141ms
esbuild: build complete   (exit 0)
```

Additional (beyond the task's six, regression net): full `npm test` after the
change = `217 passed | 1 skipped (218)`, `3032 passed | 2 skipped (3034)`,
0 failures; on the stashed base the same run gives 3025 passed — the 7 new
tests (5 queue-bound + 2 routing) are the only delta. `docs/decisions/0002…`
wave-0 content untouched; only the `## Probe: MySQL` section appended under
§7's merge point (before §8), with the chosen bound `acquireTimeout = 10_000`
recorded there.

### Acceptance criteria

- [x] Cases 1–5 pass; case 2 RED on base (paste above) before the fix.
- [x] Case 2 asserts termination within a bounded, injectable wait
      (`setPoolAcquireTimeoutMsForTests(50)` + elapsed < 1500ms ceiling); the
      suite runs in ~88ms — never a real 10s.
- [x] Streaming, atomic batches, cancel/terminal paths preserved (pins pass
      on base AND after the change); only the acquire wait is bounded.
- [x] RED/GREEN probe results appended to the ADR under `## Probe: MySQL`;
      chosen bound `acquireTimeout = 10_000` recorded (both greps exit 0);
      wave-0 content and other sections untouched.
- [x] `npm run typecheck` + `npm run compile` exit 0.
- [x] No mutation/transaction/cursor automatic replay (case 3 pins the
      statement is issued exactly once, cancel destroys exactly once, repeat
      cancel is a no-op); ARP-02 destroy-terminal semantics preserved.

Note: mysql2 3.23.4 ignores the `acquireTimeout` pool option (measured,
recorded in ADR §7), so the enforced bound is the adapter-side `Promise.race`
at `getConnectionWithUtcSession()`; the option remains on the factory as the
declared contract per the task/PLAN spec. See Discussion entry above and ADR
`## Probe: MySQL` for the full measurement. No other issues.

## Reviewer Verdict

(pending — Phase 4 appends below)
