# TASK-RLX-001 — Cancel active PostgreSQL non-cursor queries

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Make the existing `vsdb.cancelQuery` path cancel the PostgreSQL operation currently owned by `QueryRunner` when it is not a `BatchedQuery`, without closing the adapter or changing cursor cancellation.

## Target Files

- `src/adapters/types.ts` — add the optional, backward-compatible `cancelActiveQuery?(): Promise<void>` adapter seam.
- `src/core/queryRunner.ts` — retain the adapter only for active `run()` work and invoke its cancellation seam only when no active batched cursor owns cancellation.
- `src/adapters/postgres.ts` — track the active non-cursor backend operation only during `runQuery()` and implement targeted cancellation through its existing dedicated-client mechanism.
- `src/core/__tests__/queryRunner.test.ts` — add runner contract/regression tests.
- `src/adapters/__tests__/postgres.test.ts` — add PostgreSQL lifecycle/targeting tests using existing adapter test style.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy / contract | cancel active non-batched run | `cancelActiveQuery()` is called once; resolved in-flight statement has status `cancelled`, not `done`. | Deferred `adapter.runQuery`; adapter implements seam. |
| 2 | edge — race | cancel before adapter resolves | No seam is invoked later against an adapter that resolves after cancellation; result is cancelled when run settles. | Deferred adapter-provider promise. |
| 3 | edge — ordering | cancel after statement settles and PID window closes | `cancelActiveQuery()` is never called; the completed statement remains `done` with no false error or `cancelled` status. | Resolved `adapter.runQuery` followed by `QueryRunner.cancel()`. |
| 4 | edge — lifecycle | Postgres cancel failure releases only once | Dedicated cancel failure is swallowed as best effort, the query termination path remains observable, and checked-out client release occurs exactly once. | Mocked PoolClient + dedicated Client cancellation rejection. |
| 5 | regression | batched cursor uses cursor cancellation only | `BatchedQuery.cancel()` is called once and adapter `cancelActiveQuery()` is never called. | Deferred batched `fetchBatch()` fixture. |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — runner cancellation behavior.
- `src/adapters/__tests__/postgres.test.ts` — PostgreSQL backend PID/cancel/release lifecycle.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/postgres.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] `DbAdapter` keeps `runQuery(sql: string): Promise<RunResult>` unchanged and declares only an optional cancellation seam.
- [ ] `QueryRunner.cancel()` preserves `BatchedQuery.cancel()` as the exclusive path when `currentBatched` exists.
- [ ] A non-batched PostgreSQL backend cancellation targets only the active QueryRunner run and never closes the shared adapter/pool.
- [ ] Active client/backend tracking is cleared on success, error, and cancellation; no late cancel can target a later query.
- [ ] After a non-cursor statement finishes and the PID-recording window closes, `QueryRunner.cancel()` is a no-op: it does not invoke `cancelActiveQuery()` and does not produce a false error or `cancelled` result.
- [ ] Tests 1–5 pass after an observed RED failure, and both verification commands pass.

## Dependencies

- none

## Interfaces

- Consumes: `DbAdapter.runQuery(sql: string): Promise<RunResult>` and `BatchedQuery.cancel(): Promise<void>` from `src/adapters/types.ts`; `QueryRunner.run(statements, onUpdate, opts?): Promise<StatementResult[]>` and `QueryRunner.cancel(): Promise<void>` from `src/core/queryRunner.ts`.
- Produces: optional `DbAdapter.cancelActiveQuery?(): Promise<void>`; PostgreSQL implementation; QueryRunner behavior that calls it only for active non-batched work.

---

## Discussion

### 2026-08-31 · planner · unic-smart
Use a deferred promise to prove cancellation ordering. Do not add AbortSignal to `runQuery`, close the adapter, or change a non-PostgreSQL adapter in this task.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

### Implementation notes

- `src/adapters/types.ts`: added optional `cancelActiveQuery?(): Promise<void>` to `DbAdapter` (backward-compatible; `runQuery` signature untouched).
- `src/core/queryRunner.ts`: new `activeAdapter` field holds the resolved adapter ONLY while a `runQuery` is in-flight inside `executeAll` (PID window). Cleared on success, error, and in `run()`'s finally. `cancel()` keeps `BatchedQuery.cancel()` as the exclusive batched path (early return); only when no `currentBatched` exists does it invoke `adapter.cancelActiveQuery()` best-effort (wrapped in try/catch).
- `src/adapters/postgres.ts`: `activeNonCursorPid` recorded right after `runQuery()` checks out its client (from `client.processID`), cleared in the `finally` (success + error) before `client.release()` — release stays exactly-once in runQuery. `cancelActiveQuery()` is a no-op when no PID is active; otherwise it reuses the existing `cancelBackendViaDedicatedClient()` (one-off Client, pg_cancel_backend, never touches the shared pool).
- Test-note (Test Cases 3 & 5): these two are absence-guards (seam must NEVER be called). They assert correct behavior both before and after implementation by design; the RED signal for the feature is carried by Tests 1, 2, 4a-c below. All 5 observed RED as a set pre-implementation, GREEN after.

### RED_OUTPUT

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/adapters/__tests__/postgres.test.ts > PostgresAdapter — estimateTableRows (TASK-301) > PostgresAdapter — cancelActiveQuery (TASK-RLX-001) > Test #4a — happy: cancelActiveQuery mid-flight targets the active PID via dedicated Client, releases once
TypeError: adapter.cancelActiveQuery is not a function
 ❯ src/adapters/__tests__/postgres.test.ts:390:19
    388| 
    389|     // Cancel mid-flight — seam must use the DEDICATED client.
    390|     await adapter.cancelActiveQuery!();
       |                   ^

 FAIL  ... > Test #4b — edge: dedicated cancel failure is swallowed; checked-out client still releases exactly once
TypeError: adapter.cancelActiveQuery is not a function
 ❯ src/adapters/__tests__/postgres.test.ts:428:26

 FAIL  ... > Test #4c — edge: PID tracking cleared after run; late cancelActiveQuery is a no-op
TypeError: adapter.cancelActiveQuery is not a function
 ❯ src/adapters/__tests__/postgres.test.ts:459:19

 FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — non-batched cancellation seam (TASK-RLX-001) > Test #1 — happy/contract: cancel active non-batched run → seam called once, status cancelled
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ src/core/__tests__/queryRunner.test.ts:657:29
    657|     expect(cancelActiveSpy).toHaveBeenCalledTimes(1);

 FAIL  ... > Test #2 — edge / race: cancel before adapter resolves; seam NOT re-invoked after the late resolution
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ src/core/__tests__/queryRunner.test.ts:701:29
    701|     expect(cancelActiveSpy).toHaveBeenCalledTimes(1);

 Test Files  2 failed (2)
      Tests  5 failed | 41 passed (46)
```

### Verification Output

Command 1: `npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/postgres.test.ts`

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-rlx-001

 ✓ src/adapters/__tests__/postgres.test.ts  (15 tests) 17ms
 ✓ src/core/__tests__/queryRunner.test.ts  (31 tests) 126ms

 Test Files  2 passed (2)
      Tests  46 passed (46)
   Duration  354ms (transform 139ms, setup 0ms, collect 166ms, tests 143ms, environment 0ms, prepare 70ms)
```

Command 2: `npm run typecheck`

```
> vsdb@1.26.0 typecheck
> tsc --noEmit

exit=0
```

Regression net (extra, not required by task): full `npx vitest run` → 11 failures, ALL pre-existing on the clean tree (git stash verified): `dist/` bundle-artifact tests (`consolePanelBundle`, `agGridSmoke`, one `extension.test.ts` compile check) — the worktree has no compiled `dist/`. Unrelated to this change.

Status: PASS
Note: Test Cases 3 & 5 are absence-guards that pass pre-implementation by design (documented above); RED for the feature carried by Tests 1, 2, 4a-c. node_modules was symlinked from the main repo per orchestrator instruction. No git add/commit/push performed.


## Reviewer Verdict

(pending)
