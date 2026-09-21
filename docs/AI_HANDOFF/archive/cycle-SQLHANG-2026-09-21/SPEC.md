# SPEC — SQLHANG: auto-stop multi-query runs on error/hang — never leave a hung connection

<!--
Written by the planner at handoff-create (Step 2, before PLAN.md tasks).
Rule: executor implement không cần đoán — exact paths, signatures, reason codes,
frozen strings, thresholds, test expectations. Open questions chốt trong §14.
-->

## 1. Problem and context

User report (verbatim): "khi chạy nhiều query SQL nó hay bị treo kiểu gì đó. Nếu error
thì dừng ngay, thoát ra và báo lỗi nghe, đừng treo connect chỗ đó phải đi stop manual,
phải auto stop luôn" — running multiple SQL queries sometimes hangs; on error the app
must stop immediately, exit execution, report the error, and never leave a hung
connection that needs a manual stop.

Prior cycle STOPERR (commit e8f78ee) already made `QueryRunner.executeAll` stop the
statement chain at the first error and `runStatements` report it (toast + error badge +
editor mark). What is still missing — and what produces the reported hang — is that
**no await in the statement-execution path is bounded**:

- `src/core/queryRunner.ts:443` — `await adapter.runQuery(...)` has no timeout. If the
  driver promise never settles (dead socket, server-side lock wait, lost response), the
  run stays `running` forever: `panel.setBusy(true)` never clears, `runner.isRunning()`
  stays true so every later Run is refused, and the checked-out connection is never
  released — pg pool slot held (postgres.ts:449), mysql `connectionLimit: 1` pool
  exhausted (mysql.ts:191), mssql `operationQueue` wedged (mssql.ts:574-587). This is
  the "treo connect" the user describes.
- `src/core/queryRunner.ts:809-852` — `cancel()` is best-effort only: it fires
  `adapter.cancelActiveQuery()` but nothing forces the parked `runQuery` promise to
  settle if the cancel does not reach the server. Worse, `cancel()` itself awaits
  unbounded driver calls (`batched.cancel()`/`close()` → postgres.ts:1254
  `client.query("ROLLBACK")`), so the manual Stop button can ALSO hang.
- Cleanup awaits on the error path are unbounded: postgres.ts:501 `ROLLBACK`,
  postgres.ts:1181/1186 `CLOSE`/`COMMIT` in cursor `finalize`, mysql.ts:335
  `connection.rollback()`. A dead connection turns error propagation itself into a hang.
- `src/core/queryRunner.ts:380-390` — the stale-cursor sweep at the start of every run
  awaits `batched.close()` unbounded; a dead cursor wedges the NEXT run before it starts.
- `src/adapters/mssql.ts:582` — `enqueue` awaits `previous` with no bound; one
  never-settling request wedges every later operation on the adapter.

## 2. Goals

- Every statement-execution await settles within a bounded time. On expiry the runner
  auto-stops the batch, aborts server-side work, releases/destroys the connection
  handle, and reports the error through the existing STOPERR surfaces (error row in
  Results panel + "stopped at statement N of M" toast + status-bar badge + editor mark).
- `UnicDB.cancelQuery` (manual Stop) always resolves within a bounded grace and leaves
  no held connection — the guaranteed escape hatch.
- After any abort, the adapter self-heals: the next `runQuery` gets a usable
  connection without the user reconnecting manually.
- No regression: existing cancel/cursor/batch semantics unchanged when nothing hangs.

## 3. Non-goals

- KHÔNG đổi stop-at-first-error semantics của `executeAll` (STOPERR đã ship — chỉ thêm
  bound + abort, không viết lại loop contract).
- KHÔNG đụng `beginTransaction`/`DbTransaction` manual-commit flow (separate surface).
- KHÔNG thêm npm dependency, KHÔNG bump version / package / publish.
- KHÔNG đổi `BatchedQuery` interface shape (chỉ bound các await quanh nó ở caller).
- BigQuery adapter: `abortActiveQuery` optional — BQ đã có job-cancel qua
  `BatchedQuery.cancel()`; thêm seam cho BQ là out-of-scope (fallback path covers it).

## 4. User journeys

- **Happy**: user runs N statements → all succeed → results render như cũ (watchdog
  armed nhưng không bao giờ fire; zero behavior change).
- **Statement error**: statement K fails → executeAll catch marks K `error`, K+1..N
  `cancelled`, run settles, toast "stopped at statement K of N" (đã có — giữ nguyên).
- **Hang (bug hôm nay)**: statement K's `runQuery` never settles → sau
  `statementTimeoutMs` watchdog fires → `adapter.abortActiveQuery()` (cancel backend +
  destroy/release client) → statement K = `error` ("statement timed out after Ns —
  aborted"), K+1..N `cancelled`, run settles, busy clears, connection freed → next Run
  works ngay, không cần manual stop/reconnect.
- **Manual stop**: user bấm Stop → `runner.cancel()` fires seam; nếu sau
  `CANCEL_GRACE_MS` work vẫn parked → escalate `abortActiveQuery()` → parked promise
  settles (cancelled), `cancel()` resolve ≤ grace, `panel.setBusy(false)` chạy được.
- **Dead cleanup**: statement error + `ROLLBACK`/`CLOSE`/`COMMIT` cleanup hangs →
  bounded cleanup race expires → client `release(true)`/destroy → original error
  propagates, pool slot freed.
- **Stale cursor wedge**: cursor từ run trước chết → sweep `close()` bounded → run mới
  không bị chặn bởi cursor cũ.

## 5. Functional requirements

- FR-001: `DbAdapter` (src/adapters/types.ts) gains OPTIONAL seam
  `abortActiveQuery?(): Promise<void>` — hard abort of in-flight non-cursor work AND
  any adapter-held cursor client: cancel server-side work best-effort, then
  force-release/destroy the connection handle so the parked driver promise settles and
  the pool slot is freed. Contract: MUST resolve within ~5s, MUST NOT throw, MUST be
  idempotent (no in-flight work → no-op), MUST leave the adapter usable for the next
  `runQuery` (lazy reconnect where needed).
- FR-002: `QueryRunnerOptions` gains `statementTimeoutMs?: number`
  (default `DEFAULT_STATEMENT_TIMEOUT_MS = 300_000`; `0` disables). `QueryRunner` arms
  a per-statement watchdog around `adapter.runQuery` in `executeAll`
  (queryRunner.ts:443) and `runSql` (queryRunner.ts:914-917). On expiry:
  `adapter.abortActiveQuery?.() ?? adapter.cancelActiveQuery?.()` (bounded by
  `ABORT_GRACE_MS = 5_000`, errors swallowed) then reject the statement with
  `QueryTimeoutError` → existing catch marks `error` + cancels the rest + reports.
- FR-003: Same watchdog bounds `batched.fetchBatch()` inside `pickResult`
  (queryRunner.ts:993) and `loadMoreImpl` (queryRunner.ts:686). On expiry →
  `abortAdapter(adapter)` — `adapter.abortActiveQuery?.() ?? adapter.cancelActiveQuery?.()`
  bounded by `ABORT_GRACE_MS` — NOT `batched.cancel()`: a hung fetchBatch implies a
  hung cursor client that only a connection-level abort releases (a cursor-scoped
  cancel would itself await the same dead client). Then `QueryTimeoutError`.
  `loadMore` timeout surfaces as a thrown error to the panel (existing loadMore
  error path), not a silent hang.
- FR-004: `cancel()` hardened (queryRunner.ts:809-852): every internal await wrapped
  in `Promise.race` vs `CANCEL_GRACE_MS = 5_000`; after the seam fires, if
  `activeAdapter`/`currentBatched` is still set past the grace → escalate to
  `abortActiveQuery()`. `cancel()` MUST always resolve — never reject, never hang.
- FR-005: `runLocked` stale-cursor sweep (queryRunner.ts:383-390): each
  `entry.batched.close()` bounded by `CLEANUP_GRACE_MS = 3_000`; on expiry mark
  `cursorClosed = true` and continue (adapter-side abort reclaims the client).
- FR-010: `PostgresAdapter` (src/adapters/postgres.ts):
  - Track the checked-out multi-statement client: `activeNonCursorClients: Set<PoolClient>`
    alongside existing `activeNonCursorPids`; add/remove in runQuery's
    try/finally (postgres.ts:449-509). Cursor clients already tracked via `openCursors`;
    add `backendPid` to `OpenCursorRecord` (set after DECLARE, ~postgres.ts:1198) so
    abort can cancel cursor backends too.
  - `abortActiveQuery()`: for each tracked PID (run PIDs + cursor `backendPid`s) →
    `cancelBackendViaDedicatedClient` FIRST (already bounded: dedicated `Client`
    with `connectionTimeoutMillis: 5_000`, postgres.ts:1297+); then `release(true)`
    every client in `activeNonCursorClients` and every `openCursors` record client,
    all through a swallow-guard (`try { c.release(true) } catch {}`) so a
    double-release can never throw. Idempotent; never throws; no tracked work →
    return without constructing a dedicated client.
  - Bound cleanup awaits: `client.query("ROLLBACK")` at postgres.ts:501, cursor
    `finalize`'s `CLOSE`/`COMMIT` at postgres.ts:1181-1191, and `cancel()`'s
    `ROLLBACK` at postgres.ts:1254 — each `Promise.race` vs `CLEANUP_GRACE_MS = 3_000`;
    on expiry → `release(true)` path (already the fallback). The ORIGINAL error
    must propagate, never the cleanup error; `runQuery`'s `finally`
    `client.release()` (~:507) routes through the swallow-guard.
- FR-011: `MySqlAdapter` (src/adapters/mysql.ts):
  - `abortActiveQuery()`: fire every closure in `activeCancelClosures`
    (mysql.ts:153) — they already `connection.destroy()` the held batch connection and
    pre-handoff streams (may delegate to `cancelActiveQuery`). Idempotent by the
    closures' self-removal.
  - Bound `connection.rollback()` in runQuery's catch (mysql.ts:335) vs
    `CLEANUP_GRACE_MS = 3_000`; on expiry → `connection.destroy()` (sets
    `connectionDestroyed`, `finally` skips `release()`); rethrow the ORIGINAL error.
- FR-012: `MsSqlAdapter` (src/adapters/mssql.ts):
  - `abortActiveQuery()`: bump `queueGeneration` FIRST (unconditional — even when
    `connection === null` and no requests, so ops enqueued before the abort stay
    rejected after reconnect); `request.cancel()` every `activeRequests` entry
    (best-effort, swallow each); `connection.close()` (swallow) +
    `this.connected = false` + `this.connection = null`. Closing the connection
    settles every parked request callback with an error → `enqueue`'s finally
    advances the queue. Idempotent; never throws.
  - `enqueue` (mssql.ts:574-587): stamp `const gen = this.queueGeneration` at
    enqueue time; after `await previous`, if `gen !== this.queueGeneration` → throw
    `Error("MsSqlAdapter: operation aborted — connection was reset")` (frozen §8.3)
    instead of running stale work on the new connection; `finally` still runs
    `resolveNext()` so the queue keeps advancing.
  - New private `ensureConnection(): Promise<void>` =
    `if (!this.connected || !this.connection) await this.connect()`. `runQuery`
    (mssql.ts:264-266) and `runRequest` (~:593): replace the `connect() chưa được
    gọi` throw with `await this.ensureConnection()` — lazy reconnect after abort
    (connect() dedups via `this.connecting`).
- FR-013: `src/extension.ts:663-667` — pass `statementTimeoutMs` into `QueryRunner`
  from new setting `UnicDB.queryTimeoutSeconds` (seconds → ms; `0` disables).
  `package.json` `contributes.configuration.properties` gains
  `"UnicDB.queryTimeoutSeconds"` (frozen shape §8.4).
- FR-014: New exported error type `QueryTimeoutError extends Error` in
  queryRunner.ts (`name = "QueryTimeoutError"`, message
  `Statement timed out after ${ms}ms — aborted`). StatementResult.error carries the
  message verbatim → existing STOPERR reporting shows it.

## 6. Fullstack scope

### Backend
No server. "Backend" = extension core + adapters:
- `src/adapters/types.ts` — `abortActiveQuery?` seam (FR-001).
- `src/core/queryRunner.ts` — watchdog + `QueryTimeoutError` + hardened `cancel()` +
  bounded sweep (FR-002..005, FR-014).
- `src/adapters/postgres.ts` — client tracking + abort + bounded cleanup (FR-010).
- `src/adapters/mysql.ts` — abort + bounded rollback (FR-011).
- `src/adapters/mssql.ts` — abort + queue generation + lazy reconnect (FR-012).
- `src/extension.ts` + `package.json` — setting plumbing (FR-013).

### Database / schema / migrations
N/A — VS Code extension.

### API contract
Module-level contract = §8.

### Frontend UI and state
No new UI. Timeout/abort surfaces reuse the existing error row + toast + badge + mark
pipeline (STOPERR). Setting appears in VS Code Settings UI automatically via
package.json.

### Integration
`QueryRunner` is the single integration point; all run paths (editor Run, CodeLens,
Console, runScript, save flow via `runSql`) inherit the watchdog.

### Security and permissions
`pg_cancel_backend`/`connection.destroy`/`request.cancel` act only on the adapter's
own backend PIDs/connections — no new credentials, no SQL text changes.

### Performance
One `setTimeout` per statement/fetch (cleared on settle). No extra round-trips.

### Observability / logging
`QueryTimeoutError.message` is the observable marker (error row + toast). No new
logging surface.

### Deployment and rollback
No feature flag needed beyond `UnicDB.queryTimeoutSeconds: 0` (disable). Rollback =
revert commit.

## 7. Watchdog state machine (frozen)

```
statement await starts ──▶ timer armed (statementTimeoutMs; 0 = never)
   ├─ promise settles first ──▶ clearTimeout ──▶ normal path (unchanged)
   └─ timer fires ──▶ abortActiveQuery?.() ?? cancelActiveQuery?.()
                      (raced vs ABORT_GRACE_MS, errors swallowed)
                    ──▶ reject with QueryTimeoutError
                    ──▶ executeAll catch: status=error, rest=cancelled, report
```

`cancel()` escalation: seam fired → wait `CANCEL_GRACE_MS` → if `activeAdapter` or
`currentBatched` still set → `abortActiveQuery()` → resolve regardless.

## 8. API contract (module-level, frozen)

### 8.1 `src/adapters/types.ts` — addition to `DbAdapter`

```ts
/**
 * SQLHANG — hard abort of in-flight work. Unlike cancelActiveQuery (best-effort
 * server-side cancel), abort MUST also force-release/destroy the connection
 * handle so a parked runQuery/fetchBatch promise settles and the pool slot is
 * freed. Always resolves (≤ ~5s), never throws, idempotent. After abort the
 * adapter MUST be usable for the next runQuery (lazy reconnect where needed).
 */
abortActiveQuery?(): Promise<void>;
```

### 8.2 `src/core/queryRunner.ts` — additions

```ts
export const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;
export const ABORT_GRACE_MS = 5_000;
export const CANCEL_GRACE_MS = 5_000;
export const CLEANUP_GRACE_MS = 3_000;

export class QueryTimeoutError extends Error {
  readonly name = "QueryTimeoutError";
  constructor(ms: number) {
    super(`Statement timed out after ${ms}ms — aborted`);
  }
}

export interface QueryRunnerOptions {
  batchSize?: number;
  maxRetainedRows?: number;
  /** SQLHANG — per-statement watchdog. 0 disables. Default
   *  DEFAULT_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
}
```

Internal helper (module-private): `bounded<T>(p: Promise<T>, ms: number, onTimeout:
() => Promise<void> | void, makeError: () => Error): Promise<T>` — races `p` vs a
timer; on expiry awaits `onTimeout()` bounded by `ABORT_GRACE_MS` (errors swallowed)
then throws `makeError()`; clears the timer on BOTH branches (settle and timeout).
`ms <= 0` → pass-through, no timer armed.

### 8.3 Adapter method signatures (all `async abortActiveQuery(): Promise<void>`)

- `PostgresAdapter.abortActiveQuery` — dedicated-client `pg_cancel_backend` per
  tracked PID + `release(true)` tracked run clients + cursor record clients.
- `MySqlAdapter.abortActiveQuery` — fire `activeCancelClosures` (destroy).
- `MsSqlAdapter.abortActiveQuery` — `queueGeneration++` (unconditional) +
  `request.cancel()` all + `connection.close()` + `connected=false` +
  `connection = null`. Frozen stale-op error string:
  `"MsSqlAdapter: operation aborted — connection was reset"`.

### 8.4 package.json setting (frozen shape)

```json
"UnicDB.queryTimeoutSeconds": {
  "type": "number",
  "default": 300,
  "minimum": 0,
  "description": "Auto-stop a SQL statement that runs longer than this many seconds — cancels the batch, aborts the connection work, and reports the error. 0 disables the watchdog."
}
```

## 9. UI behavior

- Results panel: timed-out statement renders the existing error card with the
  `QueryTimeoutError` message; following statements show `cancelled` (existing).
- Toast: existing `UnicDB: stopped at statement N of M — <reason>. Remaining
  statements were not run.` carries the timeout reason verbatim.
- Stop button (`UnicDB.cancelQuery`): always returns within ~`CANCEL_GRACE_MS` +
  abort; busy state clears.
- Settings: `UnicDB.queryTimeoutSeconds` visible in Settings UI.

## 10. Edge cases

- `statementTimeoutMs = 0` → watchdog never armed; behavior byte-identical to today.
- Timeout fires while `cancel()` is in flight → abort is idempotent
  (`abortActiveQuery` no-ops on already-destroyed clients; runner guards via
  delivered-once flags).
- Abort lands but driver promise settles normally a tick later → race already
  rejected with `QueryTimeoutError`; late result discarded (Promise.race semantics).
- `abortActiveQuery` absent (BigQuery / mock adapters) → fallback
  `cancelActiveQuery?.()`; statement still rejects with `QueryTimeoutError`.
- pg `release(true)` on an already-released client → guarded by per-client flag;
  pg's own throw on double-release is swallowed inside the flag guard.
- mssql abort while `enqueue` has queued-but-not-started ops → stale-generation ops
  throw the dropped-operation error instead of running on the fresh connection.
- mysql `rollback()` hang → grace expiry → `connection.destroy()` → original error
  propagates (rollback failure never masks it — existing comment preserved).
- Cursor `fetchBatch` timeout inside `pickResult`/`loadMoreImpl` → `abortAdapter`
  (connection-level abort — a hung fetch means a hung cursor client; `batched.cancel()`
  would await the same dead client) → `QueryTimeoutError`; cursor `finalize` bounded
  cleanup still runs.

## 11. Test matrix

| Area | Cases | Test file |
|------|-------|-----------|
| Runner watchdog | happy: run settles before timeout (timer cleared, no abort call); timeout → abort called + stmt `error` + rest `cancelled` + `QueryTimeoutError` message; `statementTimeoutMs: 0` → no timer, hang passes through (assert with manual settle); abort absent → `cancelActiveQuery` fallback; fetchBatch timeout in pickResult/loadMore → `abortAdapter` + `QueryTimeoutError` | `src/core/__tests__/queryRunnerWatchdog.test.ts` (NEW) |
| Runner cancel | cancel() resolves ≤ grace when seam hangs (never-settling `cancelActiveQuery`); cancel during parked runQuery escalates to abort after grace; cancel() never rejects | same file |
| Sweep | stale `batched.close()` never settles → run proceeds after `CLEANUP_GRACE_MS`, `cursorClosed = true` | same file |
| pg abort | `abortActiveQuery` cancels tracked PID via dedicated client + `release(true)` run client; idempotent second call; owner `finally` does not double-release; bounded ROLLBACK → `release(true)` on hang | `src/adapters/__tests__/postgresAbort.test.ts` (NEW) |
| mysql abort | `abortActiveQuery` destroys held batch connection (pending query rejects); bounded `rollback()` → destroy on hang | `src/adapters/__tests__/mysqlAbort.test.ts` (NEW) |
| mssql abort | `abortActiveQuery` cancels requests + closes connection + `connected=false`; queued op dropped via generation; next `runQuery` lazy-reconnects | `src/adapters/__tests__/mssqlAbort.test.ts` (NEW) |
| Wiring | `extension.ts` passes `statementTimeoutMs` from `UnicDB.queryTimeoutSeconds` (mock getConfiguration); package.json parses + key exists | `src/core/__tests__/queryRunnerWatchdog.test.ts` (setting read) + existing manifest tests |

## 12. Acceptance criteria

- [ ] `npx vitest run src/core/__tests__/queryRunnerWatchdog.test.ts` — all new tests PASS.
- [ ] `npx vitest run src/adapters/__tests__/postgresAbort.test.ts src/adapters/__tests__/mysqlAbort.test.ts src/adapters/__tests__/mssqlAbort.test.ts` — PASS.
- [ ] `npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/postgres.test.ts src/adapters/__tests__/mysqlQueueBound.test.ts src/adapters/__tests__/mssql.parameterized.test.ts` — existing suites still PASS (no regression).
- [ ] `npm run typecheck` — 0 error. `npm run compile` — build OK.
- [ ] `npm test` (full suite) — PASS at wave boundary.
- [ ] Simulated hang (never-settling mock `runQuery`) settles the run with an error
      row + releases the connection — proven by the watchdog tests.
- [ ] `UnicDB.cancelQuery` command resolves within grace even when the seam hangs.

## 13. Migration / upgrade steps

N/A persisted state. Behavior change có chủ đích: statements now auto-abort after
`UnicDB.queryTimeoutSeconds` (default 300s); users with legitimately longer queries
set it to `0` or a larger value.

## 14. Open questions and chosen defaults

| Question | Chosen default | Rationale |
|----------|----------------|-----------|
| Q1: Default timeout value? | 300s, configurable via `UnicDB.queryTimeoutSeconds`, `0` = off. | "Hay bị treo" needs a bound, but a short default would kill legit long queries; 300s bounds the hang while staying invisible for normal use. |
| Q2: Watchdog in runner or per-adapter? | Runner (`bounded` around adapter calls) + adapter `abortActiveQuery` seam. | One watchdog covers all drivers + all run paths (run/runSql/pickResult/loadMore); only the adapter can release its own connection handle. |
| Q3: Abort = destroy connection or graceful cancel? | Cancel-then-destroy: `pg_cancel_backend`/`request.cancel` first, then `release(true)`/`destroy()`/`close()`. | Graceful cancel lets the server stop work cleanly; destroy guarantees the parked promise settles even when the server is unreachable. |
| Q4: Does abort drop the pooled connection? | Yes — `release(true)`/destroy/close. A poisoned or dead session must not return to the pool. | Matches existing `failed → release(true)` precedent (postgres.ts:504). |
| Q5: Bound `loadMore`'s fetchBatch too? | Yes — same watchdog; a hung fetch holds the cursor client the same way. | "Đừng treo connect" applies to every driver await, not just runQuery. |
| Q6: New error type or plain Error? | `QueryTimeoutError` class (exported) — lets tests/panel distinguish timeout from server error without string matching. | Cheap, additive, mirrors `RunnerBusy` precedent. |

## 15. Review checklist

- [x] Mọi FR testable (Given/When/Then + command ở §12).
- [x] Mọi layer được cover hoặc N/A có lý do (không server/DB/webview mới).
- [x] Thresholds frozen: `DEFAULT_STATEMENT_TIMEOUT_MS=300_000`, `ABORT_GRACE_MS=5_000`,
      `CANCEL_GRACE_MS=5_000`, `CLEANUP_GRACE_MS=3_000`.
- [x] Dependencies: 3 tasks, disjoint files, all wave-1 (interface optional → adapters
      implementable in parallel; runner falls back to `cancelActiveQuery`).
- [x] Phase 0 sweep: INDEX empty (COMMITGUARD archived); `docs/TASKS.md` absent;
      `git status` chỉ có `RUN.md` + `docs/UKIT_INTERNALS.md` (runner-owned, không phải
      product WIP) → không có việc cũ cần fold.
