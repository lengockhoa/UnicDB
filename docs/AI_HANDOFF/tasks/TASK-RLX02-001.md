# TASK-RLX02-001 — Cancel live MySQL query ownership safely

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_RLX02.md` §1–§3

## Goal

Implement the released optional cancellation seam for MySQL work that is actually live, including the non-streaming held connection and the short streaming interval before a `BatchedQuery` reaches `QueryRunner`. Keep cancellation best-effort, resource-local, and a no-op after each ownership window closes.

## Target Files

- `src/adapters/mysql.ts` — track live non-cursor connection/stream cancellation closures, implement `cancelActiveQuery(): Promise<void>`, and remove each exact record from its terminal path without pool/adapter shutdown.
- `src/adapters/__tests__/adapterQueryShape.test.ts` — extend the existing injected-pool/fake-stream lifecycle fixture with MySQL cancellation ownership tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | `cancelActiveQuery destroys one live non-streaming held connection` | During a deferred non-SELECT `connection.query()`, `cancelActiveQuery()` calls that connection’s `destroy()` exactly once; `pool.end()`, adapter `close()`, and `release()` are not used as cancellation fallbacks; the run can subsequently settle. | Existing injected MySQL transaction-pool fixture with one deferred statement query. |
| 2 | edge — streaming timing | `cancel during pre-handoff stream setup destroys the exact stream connection` | With `fields` pending after `coreConnection.query(...)`, cancellation calls `stream.destroy()` and `promiseConnection.destroy()` once, settles the awaiting setup path, and never leaves a fetch waiter unresolved. | Existing fake-stream helper, deferred `fields`, and inspectable wrapped connection. |
| 3 | edge — ordering/lifecycle | `late or repeated cancel after terminal cleanup is a no-op` | After success, stream end, or query failure removes the record, one or two later `cancelActiveQuery()` calls make zero additional `destroy()`, `release()`, `pool.end()`, or `close()` calls. | Completed and rejected fake connection/stream fixtures. |
| 4 | regression | `single-SELECT BatchedQuery behavior remains cursor-owned` | `runQuery("SELECT * FROM t")` still returns `{ results: [], batched }`, never opens a transaction, and its returned `BatchedQuery.cancel()` keeps the established stream-destroy behavior. | Existing TASK-002 streaming regression fixture. |

## Test Files

- `src/adapters/__tests__/adapterQueryShape.test.ts` — fake MySQL connection/stream lifecycle and cancellation assertions.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts src/adapters/__tests__/mysql.integration.test.ts src/adapters/__tests__/mysql.sortQuery.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] `MySqlAdapter` implements `cancelActiveQuery(): Promise<void>` without changing `DbAdapter.runQuery(sql: string): Promise<RunResult>`.
- [ ] Only a live non-cursor connection or pre-handoff stream record is cancelled; each record is removed by its exact terminal path so later/repeated cancellation is a silent no-op.
- [ ] Cancellation uses the source-proven `stream.destroy()` and/or owned connection `destroy()` path, never unverified `KILL QUERY`, `pool.end()`, or adapter `close()`.
- [ ] Existing cursor handle cancellation, atomic transaction/release semantics, and all listed tests remain green.
- [ ] Focused verification commands pass and reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: `DbAdapter.cancelActiveQuery?(): Promise<void>`, `DbAdapter.runQuery(sql: string): Promise<RunResult>`, and `BatchedQuery.cancel(): Promise<void>` from `src/adapters/types.ts`; `MySqlAdapter.runQuery(sql: string): Promise<RunResult>` and `private openStreamingQuery(sql: string): Promise<BatchedQuery>` from `src/adapters/mysql.ts`.
- Produces: `MySqlAdapter.cancelActiveQuery(): Promise<void>` that best-effort cancels only tracked live work; returned `BatchedQuery.cancel(): Promise<void>` remains the exclusive post-handoff cursor seam for `QueryRunner`.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Use the existing fake pool and stream fixture in `adapterQueryShape.test.ts`; do not add an unverified MySQL server thread-ID or `KILL QUERY` flow. A cancellation attempt after the run/stream has settled must be a no-op rather than a UI-facing failure.

---

## Executor Report

(pending)
