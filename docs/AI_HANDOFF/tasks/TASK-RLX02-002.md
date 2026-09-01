# TASK-RLX02-002 — Cancel live SQL Server Requests safely

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_RLX02.md` §1–§3

## Goal

Expose SQL Server’s existing active `tedious.Request` ownership as the RLX-01 optional non-cursor cancellation seam. Cancel only requests live in `activeRequests`, retain the shared connection, and make completion/cancel races harmless.

## Target Files

- `src/adapters/mssql.ts` — implement `cancelActiveQuery(): Promise<void>` as a best-effort snapshot over the existing `private readonly activeRequests = new Set<Request>()` lifecycle.
- `src/adapters/__tests__/mssql.parameterized.test.ts` — add fake-connection/request lifecycle tests using its existing real `Request` plus `execSql` wiring pattern.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | `cancelActiveQuery cancels exactly one deferred non-streaming Request` | A fake deferred `execSql` request is in `activeRequests`; the seam calls that request’s `cancel()` exactly once, does not call `connection.close()`, and its callback completion removes the request. | Existing `makeWiredAdapter()` pattern with a request callback deliberately held. |
| 2 | edge — cancellation race | `request.cancel throw is swallowed and completion still cleans up` | A request whose `cancel()` throws resolves the seam; later callback/error completion leaves `activeRequests` empty and emits no second cancellation. | Instance-level request override or spy with controlled `cancel` throw and callback. |
| 3 | edge — empty/finished boundary | `empty or already-completed activeRequests is a no-op` | With no active request or after callback cleanup, the seam calls neither `Request.cancel()` nor `connection.execSql()`, does not alter `operationQueue`, and does not close the connection. | Fresh wired adapter and completed request fixture. |
| 4 | regression | `streaming BatchedQuery cancellation remains request-local` | Existing `BatchedQuery.cancel(): Promise<void>` still invokes its own `request.cancel()` and deletes its request; adapter-level seam is not required to close the connection or create SQL. | Fake SQL Server streaming Request lifecycle fixture. |

## Test Files

- `src/adapters/__tests__/mssql.parameterized.test.ts` — fake `tedious.Request`/connection cancellation and cleanup tests.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts src/adapters/__tests__/mssql.integration.test.ts src/adapters/__tests__/mssql.sortQuery.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] `MsSqlAdapter.cancelActiveQuery(): Promise<void>` snapshots and best-effort invokes `Request.cancel()` only for objects that are live in `activeRequests`.
- [ ] A cancellation exception, an empty set, a completed request, and repeated cancellation resolve silently; each request’s existing terminal path removes its exact record.
- [ ] The seam never calls `this.close()`, `connection.close()`, `execSql`, `KILL`, `sp_cancel`, `ALTER ... CANCEL`, or a guessed SQL Server session-ID protocol.
- [ ] Existing request queue, streaming cursor, connection, and parameter-binding behavior remain green.
- [ ] Focused verification commands pass and reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: `DbAdapter.cancelActiveQuery?(): Promise<void>`, `DbAdapter.runQuery(sql: string): Promise<RunResult>`, and `BatchedQuery.cancel(): Promise<void>` from `src/adapters/types.ts`; `MsSqlAdapter.runQuery(sql: string): Promise<RunResult>`, `private runRequest(sql: string, params?: MssqlQueryParam[]): Promise<QueryResult>`, and `private readonly activeRequests = new Set<Request>()` from `src/adapters/mssql.ts`.
- Produces: `MsSqlAdapter.cancelActiveQuery(): Promise<void>` using `Request.cancel()` only for the existing live request set; `MsSqlAdapter.close(): Promise<void>` remains the separate adapter-shutdown boundary.

---

## Discussion

### 2026-09-01 · planner · unic-smart
`activeRequests` is the real source-proven Request identity. Do not invent a server session lookup or cancellation SQL. The existing `close()` loop proves `Request.cancel()` is the supported best-effort primitive; this task reuses it without closing the connection.

---

## Executor Report

(pending)
