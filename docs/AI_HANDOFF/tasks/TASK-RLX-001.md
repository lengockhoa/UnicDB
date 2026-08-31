# TASK-RLX-001 — Cancel active PostgreSQL non-cursor queries

- Status: `ready`
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

(pending)

## Reviewer Verdict

(pending)
