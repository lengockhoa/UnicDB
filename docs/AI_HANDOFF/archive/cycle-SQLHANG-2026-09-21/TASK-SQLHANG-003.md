# TASK-SQLHANG-003 — MSSQL hard abort, queue generation, lazy reconnect

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 | Spec: `docs/AI_HANDOFF/SPEC.md` FR-012

## Goal

Implement `abortActiveQuery()` on `MsSqlAdapter`: cancel in-flight requests, tear down
the single tedious connection, invalidate queued operations so stale work never
replays on the fresh connection, and make `runQuery` lazily reconnect — so a wedged
request can never hold the queue (or the connection) hostage again.

## Target Files

- `src/adapters/mssql.ts` —
  - New field `private queueGeneration = 0`.
  - `async abortActiveQuery(): Promise<void>` (SPEC §8.1 contract): bump
    `queueGeneration`; `request.cancel()` every request in `activeRequests`
    (swallow each); `connection.close()` (swallow); `this.connection = null`;
    `this.connected = false`. `connection === null` → still bump generation +
    cancel requests, then resolve. Idempotent; never throws.
  - `enqueue` (~line 574): stamp `const gen = this.queueGeneration` at enqueue time;
    after `await previous`, if `gen !== this.queueGeneration` throw
    `Error("MsSqlAdapter: operation aborted — connection was reset")` (frozen, SPEC §8.3)
    — the `finally` still runs `resolveNext()` so the queue keeps advancing.
  - New private `ensureConnection(): Promise<void>` = `if (!this.connected || !this.connection) await this.connect()`.
  - `runQuery` (~line 265) and `runRequest` (~line 593): replace the
    `connect() chưa được gọi` throw with `await this.ensureConnection()` — lazy
    reconnect after abort (connect() already dedups via `this.connecting`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `abortActiveQuery` with live connection + active request | `request.cancel()` called; `connection.close()` called; `connected === false`; `connection === null` | fake tedious Connection per mssql.parameterized.test.ts (instance-level `newRequest` shadow) |
| 2 | unit | `runQuery` after abort | `connect()` re-invoked (lazy reconnect); query executes on the new connection | adapter aborted, then runQuery |
| 3 | edge (queue) | op enqueued behind a hung op; abort fires | queued op rejects `"MsSqlAdapter: operation aborted — connection was reset"`; its `execSql` NEVER called | two enqueued ops; first hangs |
| 4 | edge (no-op) | `abortActiveQuery` with `connection === null`, no requests | resolves; `queueGeneration` still bumped; no throw | fresh adapter |
| 5 | edge (hang) | `runRequest` promise never settles; abort fires | `runQuery` rejects (connection teardown settles the request callback with error); `enqueue`'s `finally` ran → queue advanced | fake connection whose execSql never calls back; abort mid-flight |
| 6 | edge (idempotent) | `abortActiveQuery` called twice | second call resolves; `connection.close()` called at most once per connection | same fixture as #1 |
| 7 | regression (bugfix) | statement request never completes → subsequent `runQuery` calls | pre-fix: second runQuery parks forever behind the queue (test times out = RED); post-fix: abort → second call rejects §8.3 or reconnects | the reported "treo" on mssql |
| 8 | edge (boundary) | abort between `await previous` resolving and `operation()` starting | op sees stale generation → rejects §8.3, never executes | enqueue during abort window |

## Test Files

- `src/adapters/__tests__/mssqlAbort.test.ts` (NEW) — all 8 cases; fake tedious
  `Connection` (EventEmitter) + instance-level `newRequest` shadow per
  `mssql.parameterized.test.ts` convention; `vi.useFakeTimers()` where needed.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/mssqlAbort.test.ts
npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts src/adapters/__tests__/mssql.sortQuery.test.ts
npm run typecheck
npm run compile
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; #7 fails on pre-fix code (queue parks forever).
- [ ] `abortActiveQuery` present; never throws; idempotent; bumps `queueGeneration`.
- [ ] `enqueue` rejects stale-generation ops with the exact §8.3 message.
- [ ] `runQuery`/`runRequest` lazily reconnect via `ensureConnection` (no
      `connect() chưa được gọi` throw on the abort path).
- [ ] `npm run typecheck` 0 errors; existing mssql suites still PASS.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — implements the `abortActiveQuery` seam declared by TASK-001; valid TS
  without it, and independently valuable (the queue can no longer wedge permanently).

## Interfaces

- Consumes: tedious `Connection.close()`, `Request.cancel()`, `Connection.state`
  (existing); `activeRequests`/`operationQueue`/`connecting` (existing internals).
- Produces: `MsSqlAdapter.abortActiveQuery(): Promise<void>` — consumed by
  `QueryRunner.abortAdapter` (TASK-001) via the `DbAdapter` seam.

---

## Discussion

### 2026-09-21 · planner · devin/swe-2 (unic-smart role)
VERIFY during implementation: tedious 18.x settles an in-flight Request when
`connection.close()` is called (expected: request callback fires with a
connection-closed error — tedious completes/aborts requests on teardown). If the
installed version does NOT settle the callback, the parked `runRequest` promise stays
pending and case #5 needs the abort to also reject the pending promise directly
(e.g. store a reject hook per active request). Check `node_modules/tedious/lib/`
behavior before writing the test — do not assume.
`queueGeneration` is intentionally NOT reset on reconnect: ops enqueued before the
abort must stay rejected even after the new connection is up.

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
FAIL  src/adapters/__tests__/mssqlAbort.test.ts > MsSqlAdapter.abortActiveQuery (TASK-SQLHANG-003) > #7 regression: hung statement no longer parks every later runQuery
FAIL  src/adapters/__tests__/mssqlAbort.test.ts > MsSqlAdapter.abortActiveQuery (TASK-SQLHANG-003) > #8 abort in the enqueue await-window rejects the op before it executes
TypeError: adapter.abortActiveQuery is not a function
TypeError: adapter.abortActiveQuery is not a function
TypeError: adapter.abortActiveQuery is not a function
Test Files 1 failed (1)
Tests 8 failed (8)
```
Verification Output:
```
$ npx vitest run src/adapters/__tests__/mssqlAbort.test.ts
✓ src/adapters/__tests__/mssqlAbort.test.ts  (8 tests) 374ms
Test Files 1 passed (1)
Tests 8 passed (8)

$ npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts src/adapters/__tests__/mssql.sortQuery.test.ts
✓ src/adapters/__tests__/mssql.sortQuery.test.ts  (7 tests) 1ms
✓ src/adapters/__tests__/mssql.parameterized.test.ts  (17 tests) 485ms
Test Files 2 passed (2)
Tests 24 passed (24)

$ npm run typecheck
> UnicDB@1.54.1 typecheck
> tsc --noEmit
(0 errors)

$ npm run compile
⚡ Done in 43ms
dist/webview.js 2.3mb ⚠️
dist/webview.css 41.6kb

$ npm test
Test Files 315 passed | 2 skipped (317)
Tests 4726 passed | 5 skipped (4731)
```
Status: PASS
Note: Worktree had no node_modules — vitest resolved upward but 6 webview/vsix tests spawn `.bin/esbuild`/`vsce` by relative path; fixed with `node_modules/.bin -> ../../../node_modules/.bin` symlink (untracked). Test #7 asserts the spec's "rejects §8.3 OR reconnects" contract via the reconnect path (the second runQuery's enqueue stamps generation after the abort due to ensureConnection microtask ordering). tedious 18.6.2 verified: Connection.close() → cleanupConnection fires request.callback with RequestError ECLOSE, so teardown settles parked runRequest promises — no reject-hook needed.

## Reviewer Verdict
VERDICT: approved_minor
REVIEWER_MODEL: devin/swe-2
EXECUTOR_MODEL: devin/swe-2
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: src/adapters/mssql.ts:278-297 — abort during an in-flight connect() does not clear `this.connecting`; a concurrent ensureConnection may await the doomed connect and see its rejection instead of retrying (narrow window, next call self-heals). Also executor model unverified — same model family as reviewer.
NEXT_STATUS_FOR_INDEX: done

Verification rerun (reviewer):
  npm run typecheck → 0 errors
  npx vitest run mssqlAbort.test.ts → 8/8 PASS
  npx vitest run mssql.parameterized.test.ts → 17/17 PASS

Diff review: queueGeneration stamped at enqueue (mssql.ts:631) and checked after
`await previous` with the exact frozen §8.3 message; `finally` still runs
resolveNext() so the queue advances. abortActiveQuery bumps generation
unconditionally (correct — pre-abort ops stay rejected post-reconnect), cancels
each active request best-effort, nulls connection + connected=false before
close() (correct ordering — a sync close throwing can't leave half-state), and
is a no-op-safe resolve when connection===null. ensureConnection dedups via
this.connecting; runQuery/runRequest both route through it. Idempotent: second
abort finds connection===null, only bumps generation. Matches spec §8.1/§8.3.
