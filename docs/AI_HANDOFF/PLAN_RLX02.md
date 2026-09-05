# PLAN_RLX02 — Cross-dialect Query Lifecycle Completion

Cycle: RLX-02 (Wave 7) · Base: main @ 887efe0dd0c978ec8d7065f8540448727dbd5cce · Release baseline: v1.30.0  
Reviewer: `unic-smart` — MUST differ from executor `unic-code`

## §1 Intent

Ship **PORT-RLX-02** by extending the RLX-01 non-cursor cancellation seam from PostgreSQL to MySQL and SQL Server, then carrying the resulting cancellation state through the existing `QueryRunner`, command, and results-panel paths. A user who cancels a running MySQL or SQL Server statement must get the same terminal `StatementResult.status === "cancelled"` and cleared busy UI as PostgreSQL, without closing the shared adapter and without a late `UnicDB:`/`Load more failed:`/`UnicDB requery failed:` error.

Success is source-proven, best-effort server/client cancellation of only currently live adapter work: MySQL uses its existing connection-destruction cancellation mechanism; SQL Server invokes `tedious.Request.cancel()` on the existing live request set. Both adapters clear their live-operation records on success, failure, and cancellation, so a cancel after settlement is a no-op. Existing `BatchedQuery.cancel()` remains the exclusive path once a cursor handle is available.

### User Q&A / standing direction

- The user selected PORT-RLX-02 through AskUserQuestion as **Wave 7** and directed continuous autonomous execution until all queued work completes.
- The requested scope is MySQL streaming and non-streaming lifecycle ownership, SQL Server request lifecycle ownership, and runner/panel observability—not a new SQL dialect feature, protocol, or UI redesign.

## §2 Scope

### In scope

- `MySqlAdapter.cancelActiveQuery(): Promise<void>` implemented through the existing physical connection/stream lifecycle. It records only live non-cursor checked-out connections and pre-handle streams, destroys those connections/streams best-effort, and clears each record in its own terminal path. It does **not** issue a guessed `KILL QUERY <id>` statement because the checked-in mysql2 paths expose no verified server thread-ID/cross-connection kill mechanism.
- `MsSqlAdapter.cancelActiveQuery(): Promise<void>` implemented against the existing `private readonly activeRequests = new Set<Request>()`. It snapshots and invokes `request.cancel()` best-effort on requests that are live at call time, without closing `this.connection` or calling adapter `close()`.
- Existing runner and panel integration: `QueryRunner.cancel(): Promise<void>` continues to set cancellation before awaiting the optional adapter seam; `runStatements(...)`, the `UnicDB.cancelQuery` command, and `ResultsPanel` clear busy state only through their existing cancellation-safe paths and re-render/re-post the terminal cancellation state without an error notification.
- Focused fake/deferred lifecycle tests using the established adapter test layouts plus runner, results-panel, and extension command regression tests.

### Out of scope for this cycle

- A new required `DbAdapter` method, a changed `DbAdapter.runQuery(sql: string): Promise<RunResult>` signature, `AbortSignal`, `operationId`, query text logging, or public cancellation telemetry API. The released RLX-01 optional seam remains `cancelActiveQuery?(): Promise<void>`.
- PostgreSQL cancellation behavior, `pg_cancel_backend`, the existing `activeNonCursorPids` set, or `BatchedQuery` semantics.
- MySQL `KILL QUERY`, a second administrative MySQL connection, SQL Server `KILL <spid>`, `sp_cancel`, `ALTER ... CANCEL`, session-ID discovery, connection-pool resizing, transaction behavior, or force-closing a shared adapter as a fallback.
- Cancellation of completed work, queued-but-not-started SQL Server work, unrelated metadata work, manual transactions, save/requery protocol changes, webview bundle changes, package metadata, dependencies, or release-version changes.

### Same-wave file exclusion

Wave 1 has TASK-RLX02-001 (MySQL files only) and TASK-RLX02-002 (SQL Server files only); they share no target or test file. TASK-RLX02-003 is Wave 2 and exclusively owns runner/panel/command integration files after both dialect contracts are available. No same-wave tasks modify the same file.

## §3 Approach

1. **Retain the released optional seam and make MySQL’s actual cancellation primitive explicit.** `DbAdapter.cancelActiveQuery?(): Promise<void>` is already optional, idempotent, and best-effort. `MySqlAdapter.runQuery(sql: string): Promise<RunResult>` has two non-cursor ownership windows: its held transaction connection from `getConnectionWithUtcSession()` through the existing `finally { connection.release(); }`, and the single-SELECT streaming window in `openStreamingQuery(sql: string): Promise<BatchedQuery>` before the handle reaches `QueryRunner.currentBatched`. The implementation records a per-window cancel closure immediately after resource ownership begins, removes exactly that record in its corresponding success/error/close terminal path, and `cancelActiveQuery()` snapshots live closures, awaits each, and swallows individual failures. The closure reuses existing `stream.destroy()` plus `promiseConnection.destroy()` for streams and `PoolConnection.destroy()` for non-stream work. It never calls `pool.end()`, never calls adapter `close()`, and never releases a connection a second time after destruction.

2. **Use SQL Server’s real request identity, not invented server control SQL.** `MsSqlAdapter` already inserts every executing `Request` into `activeRequests` in `runRequest(sql, params?)` and `runStreamingQuery(sql)`, deleting it in their terminal paths; `close()` already shows the safe primitive: `request.cancel()` in a best-effort loop. Add the optional adapter seam as a snapshot loop over the same live `Request` objects. A missing/empty set resolves without constructing a request, calling `execSql`, changing `operationQueue`, or closing the connection. A `request.cancel()` throw—including the existing race where completion happens between the state check and cancellation—is swallowed; an eventual request completion still removes its own exact request from `activeRequests`.

3. **Preserve the runner’s exact terminal-state gate and make host cancellation wait for cleanup.** `QueryRunner.cancel(): Promise<void>` first sets `cancelRequested = true`; it uses `BatchedQuery.cancel(): Promise<void>` exclusively when `currentBatched` exists, otherwise calls `activeAdapter.cancelActiveQuery?.()` only while the `await adapter.runQuery(...)` window is open. Its existing success and error gates map a settled in-flight statement to `"cancelled"` whenever `cancelRequested` is true. The integration slice makes `UnicDB.cancelQuery` await `runner.cancel()` before `panel.setBusy(false)`, and keeps the results-panel webview `"cancel"` message on the same await/finally-safe path. `runStatements(...)` already receives runner updates through `panel.render(runner.getResults(), header, { appendBase })`; therefore the terminal state is posted after the adapter resource settles. Cancellation must not produce `UnicDB: ${message}`, `Load more failed: ${message}`, or `UnicDB requery failed: ${message}`.

4. **Define the unavoidable adapter-level boundary honestly.** This released interface has no operation token: `cancelActiveQuery?(): Promise<void>` can target only the adapter’s live set, not a caller-provided individual ID. MySQL has no verified thread-ID kill path in this source; SQL Server preserves its one-live-request `operationQueue` behavior. Thus completion/absent record is a no-op, and the implementation must never target future work because every resource/request record is removed in its own terminal path. A future tokenized per-runner cancellation contract would require a separate backward-compatible interface design and a PostgreSQL migration; it is deliberately excluded here rather than guessed.

### Trade-offs and rejected alternatives

- Rejected `KILL QUERY <id>` / `KILL <spid>` / `sp_cancel`: no source-proven identity lookup or dedicated administration connection exists for the current MySQL/tedious adapter paths.
- Rejected `adapter.close()`/`pool.end()` as cancellation: those destroy shared connection state and violate the released RLX-01 seam contract.
- Rejected changing `runQuery` to take `AbortSignal` or an invented operation ID: it would be a broad signature migration and would not match the shipped RLX-01 interface.
- Rejected treating an adapter cancel error as a UI error: cancellation is best-effort; `cancelRequested` is the runner’s authoritative terminal-state gate.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | `MySqlAdapter cancels a live non-streaming held connection` | A deferred `connection.query()` has one live record; `cancelActiveQuery()` calls that connection’s `destroy()` exactly once, does not call `pool.end()` or adapter `close()`, and later settlement clears the record. |
| edge — streaming timing | `MySqlAdapter cancels between stream creation and BatchedQuery handoff` | With `fields` deferred, cancellation calls `stream.destroy()` and `promiseConnection.destroy()` once, leaves no waiter hanging, and the eventual stream terminal event does not release/destroy twice. |
| edge — ordering | `MySqlAdapter late cancellation is a no-op` | After a non-stream or stream terminal path removes its record, `cancelActiveQuery()` calls neither `destroy()`, `release()`, `pool.end()`, nor `close()`. |
| happy | `MsSqlAdapter cancels the current non-streaming tedious Request` | A fake deferred `runRequest` adds one request; `cancelActiveQuery()` calls exactly that request’s `cancel()` once, leaves `connection.close()` and `execSql` call count unchanged, and request completion removes it. |
| edge — race | `MsSqlAdapter cancellation tolerates a request that completed at the boundary` | A `cancel()` throw is swallowed; completion leaves `activeRequests` empty, and a second cancel is a no-op with no late error. |
| edge — queued/finished boundary | `MsSqlAdapter does not manufacture or cancel future work` | An empty `activeRequests` set invokes no `Request.cancel()`, no `execSql`, and does not alter `operationQueue`; a finished request is not re-cancelled. |
| happy | `runner-command-panel path renders a cancelled terminal statement` | A deferred cancel-capable adapter settles after `UnicDB.cancelQuery`; `QueryRunner.run(...)` reports `status: "cancelled"`, the panel posts a state containing that status, and busy becomes false after `runner.cancel()` resolves. |
| edge — deferred webview cancellation | `webview cancel keeps busy until runner cancellation settles` | Dispatching `{ type: "cancel" }` calls `runner.cancel()` exactly once; while its controllable promise is pending, the panel remains busy and posts no `busy: false` state; only after it resolves does the panel clear/post `busy: false`, with no error notification. |
| edge — no-op after completion | `late cancel preserves a completed result and no UI error` | A completed statement remains `status: "done"`; no adapter cancellation seam is called and no `vscode.window.showErrorMessage` receives `UnicDB:`, `Load more failed:`, or `UnicDB requery failed:` for the late cancel. |
| edge — cursor exclusivity | `streamed BatchedQuery cancellation never invokes the adapter seam` | With `currentBatched` set, `BatchedQuery.cancel()` and `close()` are called by the runner while MySQL/MSSQL `cancelActiveQuery()` spies remain at zero. |
| regression | `existing PostgreSQL RLX-01 and ResultsPanel cancellation tests remain green` | The existing PostgreSQL seam, provider-race, post-settlement no-op, batched cursor, load-more silent cancellation, and real command registration expectations keep their present results. |

TDD rule for every task: add the focused test first, record the observed RED failure against the pre-task code in the Executor Report, then make the smallest implementation change that turns it GREEN.

## §5 Verification

No `lint` script exists in `package.json`; it must not be invented. The defined scripts are `test`, `typecheck`, and `compile`.

```bash
# TASK-RLX02-001 focused MySQL lifecycle tests
npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts src/adapters/__tests__/mysql.integration.test.ts src/adapters/__tests__/mysql.sortQuery.test.ts
npm run typecheck
npm run compile

# TASK-RLX02-002 focused SQL Server lifecycle tests
npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts src/adapters/__tests__/mssql.integration.test.ts src/adapters/__tests__/mssql.sortQuery.test.ts
npm run typecheck
npm run compile

# TASK-RLX02-003 focused runner/panel/command integration tests
npx vitest run src/core/__tests__/queryRunner.test.ts src/ui/__tests__/resultsPanel.test.ts src/extension.test.ts
npm run typecheck
npm run compile

# Mandatory regression net after Wave 2 and at release review
npm test
npm run typecheck
npm run compile
```

`.cache/index/tests-map.json` maps `src/adapters/mysql.ts` to `mysql.integration.test.ts`/`mysql.sortQuery.test.ts`, `src/adapters/mssql.ts` to `mssql.integration.test.ts`/`mssql.parameterized.test.ts`, `src/core/queryRunner.ts` to its unit/integration tests, `src/ui/resultsPanel.ts` to its panel suites, and `src/extension.ts` to `src/extension.test.ts`. `adapterQueryShape.test.ts` is the verified neighboring mock-lifecycle layout for MySQL’s private connection/stream ownership and is intentionally included with the mapped MySQL regression suite.

## §6 Acceptance

- [ ] TASK-RLX02-001: MySQL implements the existing optional `cancelActiveQuery?(): Promise<void>` seam for live non-stream and pre-handle streaming work through its current connection/stream destruction mechanism; it never uses guessed `KILL QUERY`, closes the adapter/pool, double-releases, or targets work after its record is removed.
- [ ] TASK-RLX02-002: SQL Server implements the same seam by best-effort `Request.cancel()` only for objects live in `activeRequests`; empty/finished/racing requests are no-ops or swallowed best-effort failures and never close the shared connection.
- [ ] TASK-RLX02-003: `QueryRunner.cancel()` retains `BatchedQuery.cancel()` exclusivity, maps an in-flight dialect cancellation to `StatementResult.status === "cancelled"`, and preserves post-settlement `"done"` results.
- [ ] TASK-RLX02-003: The editor command and results-panel cancel route clear busy state after awaiting cancellation, re-render/re-post the eventual terminal state, and do not show a late cancellation error using the existing `UnicDB:`, `Load more failed:`, or `UnicDB requery failed:` error surfaces.
- [ ] TASK-RLX02-001, TASK-RLX02-002, TASK-RLX02-003: Their focused tests and `npm run typecheck`/`npm run compile` pass; after Wave 2, `npm test`, `npm run typecheck`, and `npm run compile` pass under `unic-smart` review.

## §7 Global Constraints

- Preserve package version `1.30.0`, `engines.vscode: ^1.75.0`, TypeScript 5.4 compatibility, and all current dependencies; add no dependency.
- Retain `DbAdapter.runQuery(sql: string): Promise<RunResult>`, optional `DbAdapter.cancelActiveQuery?(): Promise<void>`, `BatchedQuery.cancel(): Promise<void>`, and `QueryRunner.cancel(): Promise<void>` signatures; do not add an operation ID or `AbortSignal` in this cycle.
- Cancellation is best-effort and idempotent: empty/settled state resolves silently; adapter cancellation exceptions never become a late UI error; never close an adapter/pool/shared connection to cancel a statement.
- Reuse MySQL’s existing `stream.destroy()`/connection `destroy()` and SQL Server’s existing `Request.cancel()` semantics only; do not issue unverified administrative cancellation SQL.
- Preserve PostgreSQL RLX-01 behavior and batched-cursor exclusivity; no changes to connection persistence, transaction semantics, save/requery behavior, package contributions, generated `dist/`, or webview bundle files.
- Do not modify `docs/AI_HANDOFF/RUN.md`, older cycle plans/tasks/indexes, `docs/STATUS.md`, or `docs/WORKLOG.md`; do not run git add, commit, tag, package, or push.
- All TASK-RLX02 files inherit this section by reference.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: split MySQL and SQL Server by disjoint adapter/test files for a parallel first wave; pinned that MySQL uses existing connection destruction rather than unproven `KILL QUERY`, SQL Server uses the existing `Request.cancel()` primitive, and host busy clearing waits for the cancellation promise; added the pre-stream-handoff and post-settlement no-op boundaries.
Known gaps: the released seam has no per-runner operation token, so an adapter-level cancel cannot distinguish a caller-provided individual identity. The plan confines cancellation to current tracked records and records this limitation rather than inventing a cross-connection server-ID protocol; a tokenized contract requires a future PostgreSQL-compatible interface cycle.

## Plan Review Log

### Round 1 — 2026-09-01 · unic-smart
Status: Issues Found

COMPLETENESS:
  1. `PLAN_RLX02.md:64-67` and `tasks/TASK-RLX02-003.md:25-28` do not define a mandatory deferred webview-`"cancel"` test for the ResultsPanel path. The task requires `resultsPanel.test.ts` to prove this path at `TASK-RLX02-003.md:16-17`, but its listed cases exercise command ordering, late cancellation, runner cursor ownership, and load-more only. Add a case that dispatches `{ type: "cancel" }`, holds `runner.cancel()`, proves no `busy:false` post before resolution, then resolves and proves `busy:false` with no error notification.

CONSISTENCY:
  - none
CLARITY:
  - none
SCOPE:
  - none
YAGNI:
  - none

NOTES: The adapter ownership constraints, optional seam signatures, task file boundaries, source contracts, and npm verification commands are otherwise internally consistent and source-grounded.

Revision applied: Added `webview cancel keeps busy until runner cancellation settles` to TASK-RLX02-003 and §4. The deferred `{ type: "cancel" }` test requires exactly one `runner.cancel()` call, no busy-clear while its promise is pending, and a no-error `busy: false` post only after settlement.


### Round 2 — 2026-09-01 · unic-smart
Status: Approved

COMPLETENESS:
  - none
CONSISTENCY:
  - none
CLARITY:
  - none
SCOPE:
  - none
YAGNI:
  - none

NOTES: Round 1's deferred webview-cancel busy-state case is present in both the plan and TASK-RLX02-003. All three ready tasks have complete gates, disjoint Wave 1 targets, pinned interfaces/literals, valid verification commands, and happy-path plus distinct edge-case coverage.
