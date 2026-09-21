# TASK-SQLHANG-002 — Postgres + MySQL hard abort and bounded cleanup

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 | Spec: `docs/AI_HANDOFF/SPEC.md` FR-010, FR-011

## Goal

Implement `abortActiveQuery()` on `PostgresAdapter` and `MySqlAdapter` — the hard-abort
seam that terminates in-flight driver work AND releases/destroys the connection handle
it holds — and bound every cleanup await (ROLLBACK / CLOSE / COMMIT / rollback) so an
error path can never hang or poison the pool.

## Target Files

- `src/adapters/postgres.ts` —
  - Track checked-out runQuery clients: `private readonly activeNonCursorClients = new Set<PoolClient>()`
    — add at `pool.connect()` (~line 449), delete in the same `finally` that deletes
    the PID (~line 487).
  - Store `backendPid` on `OpenCursorRecord` (set after DECLARE, ~line 1198) so abort
    can cancel cursor backends too.
  - `async abortActiveQuery(): Promise<void>` (SPEC §8.1 contract): if no tracked
    clients AND no tracked PIDs AND no open cursors → return. Otherwise: dedicated-client
    `pg_cancel_backend` for every PID in `activeNonCursorPids` + every cursor
    `backendPid` (reuse `cancelBackendViaDedicatedClient`, already bounded by its own
    `connectionTimeoutMillis: 5_000`); then `release(true)` on every client in
    `activeNonCursorClients` and every `openCursors` record client. All release calls
    through a swallow-guard helper (`try { c.release(true) } catch {}`) — a
    double-release must never throw. Idempotent; never throws.
  - Bound cleanup: `runQuery`'s error-path `await client.query("ROLLBACK")` (~line 501)
    and cursor `finalize`'s `CLOSE`/`COMMIT` (~lines 1181-1188) wrapped in a local
    `Promise.race` against `CLEANUP_GRACE_MS` (import from `../core/queryRunner`);
    timeout → `release(true)` (destroy, never re-pool) and continue — the ORIGINAL
    error must propagate, never the cleanup error.
  - `runQuery`'s `finally` `client.release()` (~line 507): route through the
    swallow-guard so a client already destroyed by abort can't mask the original error.
- `src/adapters/mysql.ts` —
  - `async abortActiveQuery(): Promise<void>`: fire every closure in
    `activeCancelClosures` (same destroy semantics as `cancelActiveQuery` — may
    delegate to it). Idempotent, never throws.
  - Bound `runQuery`'s catch-path `await connection.rollback()` (~line 335) with
    `Promise.race` against `CLEANUP_GRACE_MS`; timeout → `connection.destroy()` +
    `connectionDestroyed = true`, then rethrow the ORIGINAL error.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (pg) | `abortActiveQuery` with a checked-out runQuery client | dedicated client issues `pg_cancel_backend(pid)`; client `release(true)` called; pending `client.query` rejects | `vi.mock("pg")` per postgres.test.ts; client with `processID` |
| 2 | unit (pg) | second `abortActiveQuery` while first in flight / after settle | resolves; no double dedicated client per PID; no throw | same fixture, call twice |
| 3 | edge (pg) | `abortActiveQuery` with nothing in flight | resolves immediately; NO dedicated `Client` constructed | fresh adapter, empty sets |
| 4 | edge (pg) | stmt errors then `ROLLBACK` hangs | `runQuery` rejects with the ORIGINAL statement error; `release(true)` (destroy) not plain `release` | client.query: stmt→reject, ROLLBACK→never settles |
| 5 | unit (mysql) | `abortActiveQuery` while batch holds connection | `connection.destroy()` called via the registered closure; pending query rejects | `vi.mock("mysql2/promise")` per mysqlQueueBound.test.ts |
| 6 | edge (mysql) | stmt errors then `rollback()` hangs | `connection.destroy()`; `connectionDestroyed` set; ORIGINAL error propagates; no `release()` after destroy | connection mock: query→reject, rollback→never settles |
| 7 | edge (mysql) | `abortActiveQuery` with nothing in flight | resolves; no destroy called | empty `activeCancelClosures` |
| 8 | regression (pg) | multi-stmt batch, stmt 2 rejects inside `BEGIN…COMMIT` script | `runQuery` rejects with stmt-2 error; client released exactly once (destroy path on rollback-timeout) | mirrors the reported hang: error path that used to be able to wedge on ROLLBACK |

## Test Files

- `src/adapters/__tests__/postgresAbort.test.ts` (NEW) — cases 1-4, 8; `vi.mock("pg")`
  hoisted factory + module-scoped queue per `postgres.test.ts` convention;
  `vi.useFakeTimers()` for the cleanup-timeout cases.
- `src/adapters/__tests__/mysqlAbort.test.ts` (NEW) — cases 5-7; `vi.mock("mysql2/promise")`
  per `mysqlQueueBound.test.ts` convention.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/postgresAbort.test.ts src/adapters/__tests__/mysqlAbort.test.ts
npx vitest run src/adapters/__tests__/postgres.test.ts src/adapters/__tests__/mysqlQueueBound.test.ts
npm run typecheck
npm run compile
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] `abortActiveQuery` present on both adapters; never throws; idempotent.
- [ ] pg: abort cancels tracked PIDs via dedicated client AND destroy-releases every
      tracked client (runQuery + open cursors).
- [ ] Cleanup awaits bounded by `CLEANUP_GRACE_MS`; original error always propagates.
- [ ] `npm run typecheck` 0 errors; existing pg/mysql suites still PASS.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — implements the `abortActiveQuery` seam declared by TASK-001; valid TS
  without it (extra class member), and the bounded-cleanup paths call it internally,
  so the task is independently valuable.

## Interfaces

- Consumes: `CLEANUP_GRACE_MS` from `src/core/queryRunner.ts` (produced by TASK-001;
  if not yet landed, define the same `3_000` constant locally and note it — do NOT
  block); `PoolClient`/`OpenCursorRecord`/`activeNonCursorPids`/`activeCancelClosures`
  (existing internals).
- Produces: `PostgresAdapter.abortActiveQuery(): Promise<void>`,
  `MySqlAdapter.abortActiveQuery(): Promise<void>` — consumed by
  `QueryRunner.abortAdapter` (TASK-001) via the `DbAdapter` seam.

---

## Discussion

### 2026-09-21 · planner · devin/swe-2 (unic-smart role)
pg abort ordering: fire `pg_cancel_backend` FIRST (server-side cancel is in flight
while we destroy), then `release(true)` — destroying first would lose the PID's
backend before the cancel lands. Cursor clients live in `openCursors` records, NOT
`activeNonCursorClients` — abort must cover both sets (a hung `fetchBatch` holds a
cursor client). `OpenCursorRecord` needs a `backendPid` field added (set right after
DECLARE where `processID` is already read, ~line 1198).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report
EXECUTOR_TOOL: omp vibe worker
EXECUTOR_MODEL: devin/swe-2
EXECUTOR_SUBAGENT: -
RED_OUTPUT:
```
❯ src/adapters/__tests__/mysqlAbort.test.ts  (3 tests | 3 failed)
  → seam.abortActiveQuery is not a function (cases 5, 7)
  → Test timed out in 5000ms (case 6 — hanging rollback unbounded)
❯ src/adapters/__tests__/postgresAbort.test.ts  (5 tests | 5 failed)
  → adapter.abortActiveQuery is not a function (cases 1-3)
  → Test timed out in 5000ms (cases 4, 8 — hanging ROLLBACK unbounded)
Test Files  2 failed (2)   Tests  8 failed (8)
```
Verification Output:
```
$ npx vitest run src/adapters/__tests__/postgresAbort.test.ts src/adapters/__tests__/mysqlAbort.test.ts
✓ src/adapters/__tests__/mysqlAbort.test.ts  (3 tests) 56ms
✓ src/adapters/__tests__/postgresAbort.test.ts  (5 tests) 110ms
Test Files 2 passed (2)   Tests 8 passed (8)

$ npx vitest run src/adapters/__tests__/postgres.test.ts src/adapters/__tests__/mysqlQueueBound.test.ts
✓ src/adapters/__tests__/mysqlQueueBound.test.ts  (5 tests) 89ms
✓ src/adapters/__tests__/postgres.test.ts  (26 tests) 3050ms
Test Files 2 passed (2)   Tests 31 passed (31)

$ npm run typecheck
> tsc --noEmit   (exit 0, 0 errors)

$ npm run compile
⚡ Done in 37ms — dist/webview.js 2.3mb   (exit 0)

$ npm test
Test Files  6 failed | 310 passed | 2 skipped (318)
Tests  1 failed | 4677 passed | 5 skipped (4683)
— all 6 failures are environmental ENOENT: node_modules/.bin/esbuild and
  node_modules/.bin/vsce are absent in this worktree (5 aiChatPanel webview
  suites spawn esbuild; vsixSecretsExclusion spawns vsce). Unrelated to the
  change; every adapter/core suite passes.
```
Status: PASS
Note: CLEANUP_GRACE_MS (3_000) defined locally in both adapters — TASK-001's
core/queryRunner export not yet landed in this worktree (per §Interfaces
fallback). abortActiveQuery added as concrete class methods; DbAdapter seam
declaration belongs to TASK-001. pg abort ordering: pg_cancel_backend via
dedicated client FIRST, then release(true) on runQuery + cursor clients;
sets snapshotted+cleared up front → idempotent. Bounded: runQuery ROLLBACK,
cursor finalize CLOSE/COMMIT(+ROLLBACK), cursor cancel ROLLBACK, mysql
rollback — timeout → destroy path, original error always propagates.
releaseSwallow preserves the historical no-arg release() contract pinned by
postgres.test.ts.

## Reviewer Verdict
VERDICT: approved_minor
REVIEWER_MODEL: devin/swe-2
EXECUTOR_MODEL: devin/swe-2
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: src/adapters/postgres.ts:547 / src/adapters/mysql.ts:367 — `client.query("ROLLBACK")` / `connection.rollback()` are invoked eagerly before `boundedCleanup`; a synchronous throw (not a rejection) would bypass the bound and mask the original error. Drivers return promises here, so risk is theoretical. Executor model unverified — same model family as reviewer (devin/swe-2); findings made on diff evidence, not independent-model distance. Duplicated `boundedCleanup`/`CLEANUP_GRACE_MS` in both adapters is per-spec (TASK-001 export not yet landed) but should be deduplicated to core/queryRunner when it lands.
NEXT_STATUS_FOR_INDEX: approved
