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

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts (before implementation):

   FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter.cancelActiveQuery (TASK-RLX02-002) > cancelActiveQuery cancels exactly one deferred non-streaming Request
  TypeError: adapter.cancelActiveQuery is not a function
   ❯ src/adapters/__tests__/mssql.parameterized.test.ts:384:26

   FAIL  ... > request.cancel throw is swallowed and completion still cleans up
  TypeError: adapter.cancelActiveQuery is not a function
   ❯ src/adapters/__tests__/mssql.parameterized.test.ts:413:26

   FAIL  ... > empty or already-completed activeRequests is a no-op
  TypeError: adapter.cancelActiveQuery is not a function
   ❯ src/adapters/__tests__/mssql.parameterized.test.ts:432:19

   FAIL  ... > streaming BatchedQuery cancellation remains request-local
  TypeError: adapter.cancelActiveQuery is not a function
   ❯ src/adapters/__tests__/mssql.parameterized.test.ts:475:19

   Test Files  1 failed (1)
        Tests  4 failed | 8 passed (12)

  RED reason is exactly the missing seam (`cancelActiveQuery is not a function`); the 8 pre-existing TASK-002 tests stayed green, so the failures isolate to the new behavior.
Verification Output: |
  Command 1 — npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts src/adapters/__tests__/mssql.integration.test.ts src/adapters/__tests__/mssql.sortQuery.test.ts

   ✓ src/adapters/__tests__/mssql.sortQuery.test.ts  (7 tests) 2ms
   ✓ src/adapters/__tests__/mssql.parameterized.test.ts  (12 tests) 214ms
   (mssql.integration.test.ts: describe.skipIf(!UnicDB_IT) — 0 collected without UnicDB_IT=1)

   Test Files  2 passed (2)
        Tests  19 passed (19)

  Command 2 — npm run typecheck

   > UnicDB@1.30.0 typecheck
   > tsc --noEmit
   (exit 0, no errors)

  Command 3 — npm run compile

   dist/webview.js.map    4.0mb
   dist/webview.css.map  65.2kb
   ⚡ Done in 153ms
   esbuild: build complete
   (exit 0)

  Focused file alone (step-2 GREEN gate): 12 passed (12) — 8 pre-existing TASK-002 tests + 4 new TASK-RLX02-002 tests.
Status: PASS
Note: |
  Implementation notes for the reviewer:
  - `cancelActiveQuery()` snapshots `[...this.activeRequests]` before iterating (a request can complete and remove itself mid-loop), calls `request.cancel()` in a try/catch per entry, and returns early when the set is empty. It never touches `this.connection`, `close()`, `execSql`, `operationQueue`, or any SQL-based cancellation — mirroring the proven shutdown loop in `close()`.
  - Test #1 uses the file's existing `makeWiredAdapter` wiring pattern extended into `makeDeferredAdapter()`: the fake `execSql` deliberately does NOT auto-settle, so the test holds `request.callback` and drives completion explicitly — this exposes the exact mid-flight window the seam targets. The real tedious `Request` is used (per the established prototype-spy pattern), so `cancel()`/`on()` are real.
  - Test #4 (regression) drives the real streaming path via `runQuery()` on a single SELECT, asserts `BatchedQuery.cancel()` cancels its own request once and deletes it, and that the adapter seam afterwards is a full no-op (no re-cancel, no `connection.close`, no extra `execSql`).
  - No `lint` script exists in package.json, per the task file; typecheck + compile are the project gates and both pass.
  - No commit made — files left as-is in the worktree per instructions. `dist/` artifacts from `npm run compile` are untracked build output.


## Reviewer Verdict
VERDICT: approved
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
