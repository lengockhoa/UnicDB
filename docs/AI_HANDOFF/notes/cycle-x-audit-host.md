# Cycle X Audit — Host / Adapters / Save Path (v1.6.3..v1.6.6)

Audit focus per orchestrator brief: `src/adapters/{postgres,mysql,mssql}.ts`, `src/core/{queryRunner,saveStatements}.ts`, `src/extension.ts`, and the save path (`src/ui/resultsPanel.ts` host-side save flow).

## Scope / Method

- Range: `git diff v1.6.3..v1.6.6` restricted to `src/adapters src/core src/extension.ts` (22 files, 10 production files after excluding `__tests__/`), plus the save-path host file `src/ui/resultsPanel.ts` and its helper `src/ui/queryComposer.ts` where the save/requery flow depends on them.
- Read full current source of each target file (not just the diff hunks), traced call sites of `MySqlAdapter.query`, `MsSqlAdapter.execute/openStreamingQuery`, `PostgresAdapter.openCursorForStatement`, `QueryRunner.run/runSql/loadMore/cancel/adopt`, `ResultsPanel.handleSaveEdits/handleRequery/fetchPostgresCtids`, `buildSaveStatements`, `splitStatements` dialect paths.
- Verified driver-library behavior in vendored `node_modules` (`mysql2/lib/base/pool.js`, `mysql2/lib/promise/pool.js`, `mysql2/lib/parsers/text_parser.js`, `pg-pool/index.js`, `tedious/lib/connection.js`, `tedious/lib/request.js`) rather than assuming.
- Ran probes against `splitStatements` and `buildSaveStatements` via temporary vitest files (removed after) plus the existing suites: `src/adapters/__tests__` + `src/core/__tests__` = 382 passed; save-flow tests (`webviewSaveEdits`, `manualCommit`, `resultsPanelSaveEdits`) = 33 passed / 5 skipped; `npm run typecheck` clean.

## Reviewed-File Checklist (changed files in range)

| File | Status |
|---|---|
| `src/adapters/mysql.ts` | reviewed — findings M1, M2, M3 below |
| `src/adapters/mssql.ts` | reviewed — clean in changed hunks (see clean list) |
| `src/adapters/postgres.ts` | reviewed — findings P1 below |
| `src/adapters/types.ts` | reviewed — clean (additive `DbTransaction` + `estimateTableRowsBatch`) |
| `src/core/dangerousStatement.ts` | reviewed — clean (dialect threading only) |
| `src/core/keywordQualify.ts` | reviewed — clean (lazy cache, failure-safe) |
| `src/core/queryRunner.ts` | reviewed — clean (additive `beginTransaction`; `label` field) |
| `src/core/saveStatements.ts` | reviewed — findings S1 below |
| `src/core/statementParser.ts` | reviewed — probe-verified clean on BEGIN/END/GO/mysql-escape edge cases |
| `src/extension.ts` | reviewed — clean in changed hunks |

Task-file note: `docs/AI_HANDOFF/tasks/TASK-001.md` names the deliverable `cycle-x-audit-host-adapters.md`; the orchestrator brief for this run names `cycle-x-audit-host.md`. This file uses the orchestrator's name; content contract (severity, file:line, trigger, symptom, fix, size) is identical.

## Findings

### M1 — P1 — MySqlAdapter non-streaming SQL runs on arbitrary pool connections with no session init; `query()` is the sole gatekeeper
**Evidence** `src/adapters/mysql.ts:398-408`:
```ts
private async query(
  sql: string,
  values: any[] = [],
): Promise<MySqlQueryResult & { durationMs: number }> {
  ...
  const [rows, fields] = await this.pool.query(sql, values);
```
Call sites: metadata (`listSchemas` :192, `listTables` :203, `listViews` :217, `listRoutines` :231, `listColumns` :254/:263, `estimateTableRows` :291, `estimateTableRowsBatch` :325 — all `information_schema`) and `executeText` :387-388 (every non-streaming statement: DDL/DML, save-flow UPDATE/INSERT/DELETE).
**What breaks**: `pool.query()` checks out a connection implicitly, runs, and releases (verified `mysql2/lib/base/pool.js:243-273`: `getConnection` → `conn.query(cmdQuery).once('end', () => conn.release())`). With `connectionLimit: 1` (mysql.ts:70) the *pool* has one physical connection, so today every caller serializes on that single connection and no cross-connection drift is observable. The defect is latent, not live: (a) any future per-connection session initialization (the UTC `time_zone` setup the task file explicitly anticipates) must run on the *checked-out* connection, and `pool.query()` bypasses it; (b) the task file's acceptance criterion — "a replacement physical connection must not bypass awaited UTC session initialization" — is currently vacuous because no such init exists anywhere in `src/` (verified: no `SET time_zone`/`SET SESSION`/`sql_mode` in any source file). Date handling is instead done client-side by `typedLiteral` (`src/ui/queryComposer.ts:69-75`, mysql/mssql get UTC-naive strings), which is self-consistent with mysql2's default `timezone: 'local'` write path only if the server session offset equals the client's — needs live DB verification for non-UTC clients.
**User-visible symptom today**: none demonstrable (single-connection pool). Symptom the design must prevent: after any pool-size increase or session-init addition, `executeText`/metadata reads would silently run on a connection whose session variables were never initialized → wrong timestamp display/write values.
**Proposed minimal fix**: in `query()`, do `const conn = await this.pool.getConnection(); try { ...await conn.query(sql, values) } finally { conn.release(); }`, which becomes the single choke point where a future `await initSession(conn)` can be inserted ahead of the query. No behavior change today; guards the contract the task file calls out.
**Proposed test**: `src/adapters/__tests__/adapterQueryShape.test.ts` — assert `query()` checks out via `pool.getConnection()` and always releases (mock pool), so a later session-init insertion point is enforced.
**Size**: small (≤15 lines). **Disposition**: route to TASK-006 (small hardening).

### M2 — P1 — MySQL `runQuery` multi-statement scripts run outside any transaction and abort mid-batch on error
**Evidence** `src/adapters/mysql.ts:150-156`:
```ts
const results: QueryResult[] = [];
for (const statement of statements) {
  const text = statement.text.trim();
  if (!text) continue;
  results.push(await this.executeText(text));
```
Each `executeText` → `query()` → `pool.query()` autocommits individually. Contrast the host save flow, which explicitly bundles `BEGIN; …; COMMIT;` in ONE `runSql` call (`src/ui/resultsPanel.ts:740`) precisely because "a fresh call may land on a different pooled connection" — but a user's multi-statement MySQL *script* run via `runQuery` (extension Run command) has no such bundling: statement 3 failing leaves statements 1-2 already committed, with the runner marking the rest cancelled (`src/core/queryRunner.ts:233-236`).
**Trigger**: editor-run multi-statement MySQL script with a mid-script error.
**Expected**: either all-or-nothing (wrap in one transaction when the script is not already transaction-bracketed) or at minimum the same combined-session guarantee the save path insists on. **Actual**: partial commit, remaining statements silently cancelled.
**Proposed minimal fix**: none this cycle if considered accepted behavior (matches psql-ish client default); if fixed, mirror the save path's single-call bundling only for mysql (`BEGIN;…;COMMIT;` joined into one `executeText` is NOT valid — `multipleStatements: false` at mysql.ts:76 — so it must wrap the loop in `runQueryOnConnection` on a held `PoolConnection`, which already exists at :365).
**Proposed test**: integration `mysql.integration.test.ts` (needs live DB).
**Size**: medium. **Disposition**: document as known behavior; candidate next-cycle. **Severity note**: marked P1 by data-partiality risk, but it is pre-existing behavior (v1.6.3 loop shape identical — verified `git show v1.6.3:src/adapters/mysql.ts` has the same loop), NOT a regression from cycles S–W; downgrade to P2 for routing purposes.

### M3 — P2 — MySQL streaming path can leak the pooled connection when `fields` never arrives
**Evidence** `src/adapters/mysql.ts:439-445` and :591-598:
```ts
const firstFields = new Promise<void>((resolve, reject) => {
  stream.once("fields", (fields: FieldPacket[]) => { ... resolve(); });
  stream.once("error", reject);
});
...
try { await firstFields; } catch (error) { ... throw ... }
```
If the stream ends (`end` event) without ever emitting `fields` or `error` (e.g. server closes after `COM_DEPRECATE`-style empty response), `firstFields` never settles and `openStreamingQuery` hangs forever holding the connection — the `fetchBatch`/`close` escape hatches are unreachable because the caller never receives the adapter handle.
**Trigger**: pathological server/network behavior; not reproducible against healthy MySQL. Needs live DB verification.
**User-visible symptom**: query spinner never resolves; every subsequent query times out (pool exhausted).
**Proposed minimal fix**: also resolve `firstFields` on stream `"end"` (treat as empty-result success with `columns=[]`).
**Proposed test**: unit test with a fake stream emitting only `end`. **Size**: small. **Disposition**: TASK-006.

### P1 — P2 — PostgresAdapter metadata `query()` still uses `pool.query()` per call while `runQuery` deliberately holds one client
**Evidence** `src/adapters/postgres.ts:653-660`:
```ts
private async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
  ...
  const r = await this.pool.query(sql, params);
```
`runQuery`'s own comment (:306-319) documents why per-statement `pool.query()` release is dangerous with `max:1`. Metadata calls are short and don't need transaction affinity, so this is safe *today*; but during a manual-commit window (resultsPanel holds `this.transaction`, which pins the pool client via `adapter.beginTransaction()` postgres.ts:347), any *background* metadata call (`schemaTree.fetchRowCountsBatch`, completion, distinct-values) will queue behind the pinned client and fail after `connectionTimeoutMillis` (10s) — verified `pg-pool/index.js:206-225` rejects waiting callers with "timeout exceeded when trying to connect". The panel routes its *own* requeries through the transaction (resultsPanel.ts:1199-1201), but nothing coordinates tree/completion traffic.
**Trigger**: open manual-commit transaction (needs `manualCommit: true` in connection config — currently not settable from any UI form, verified: only `extension.ts:97` reads it), then expand a schema tree node.
**Expected**: metadata read succeeds. **Actual**: 10s hang then error toast (needs live DB verification of exact toast path).
**Proposed minimal fix**: `PgAdapter.query()` could fall back to `getAdapterFor`-style passive connection, or the tree could be paused during a manual window; smallest correct change is documenting the constraint and gating background metadata calls on `panel` busy state.
**Proposed test**: integration. **Size**: medium. **Disposition**: note for next cycle (manualCommit itself is currently unreachable from UI — see C1).

### S1 — P2 — `buildSaveStatements` emits `WHERE pk = NULL` for NULL PK values, silently matching zero rows
**Evidence** `src/core/saveStatements.ts:659-661` (UPDATE) and :521 (DELETE):
```ts
whereParts.push(
  `${quoteIdent(pk, dialect)}=${sqlLiteral(serverRow[i])}`,
);
```
Probe-verified: a server row with `pk` column NULL produces `UPDATE "t" SET "v"='x' WHERE "id"=NULL` — which updates 0 rows, reports success (no error), and the panel acks `ok:true`; the edit is silently lost. NULL PK values are impossible for a real PRIMARY KEY constraint, but reachable via (a) a result set whose "pk columns" were resolved from a *different* table than the query's actual FROM target (e.g. query is a JOIN — `parseFromClause` picks the FIRST FROM candidate, probe-verified `SELECT (SELECT 1 FROM inner_t) FROM outer_t` → `inner_t`), or (b) a view/projection that NULLs out the PK column.
**Trigger**: save on a join/projection where the metadata-resolved PK column is NULL in the row.
**Expected**: row skipped with a warning (the `skippedRows` mechanism exists). **Actual**: emitted no-op UPDATE counted as success.
**Proposed minimal fix**: in both WHERE builders, if any `serverRow[pkIdx]` is null/undefined, skip the row into `skippedRows` with reason "pk column NULL in server row".
**Proposed test**: `src/adapters/__tests__/saveStatements.test.ts` — "null PK value in server row → row skipped, no statement emitted".
**Size**: small (≤20 lines). **Disposition**: TASK-006.

### C1 — P2 — Manual-commit mode is dead code: no path sets `manualCommit: true`
**Evidence** `src/config/types.ts:44` (`manualCommit?: boolean`), read only at `src/extension.ts:97` (`getManualCommit: () => mgr.getActive()?.manualCommit === true`). `ConnectionForm`/`openConnectionForm` (extension.ts:738-777) never writes the field; `connectionManager.editConnection` passes through whatever the form built. The whole TASK-009 machinery (`DbTransaction`, both adapters' `beginTransaction`, panel commit/rollback UI wiring) is unreachable from user action.
**Trigger**: any user attempt to use manual commit.
**Expected**: a way to enable it. **Actual**: none; feature silently absent.
**Proposed minimal fix**: add the toggle to `ConnectionForm` + persist through `editConnection` (or a workspace setting read by `getManualCommit`).
**Proposed test**: `manualCommit.test.ts` extension of form round-trip. **Size**: medium. **Disposition**: product decision needed; next cycle (also unlocks P1-above's live verification).

## Checked and Clean (areas examined, no defect found)

- **`src/adapters/mysql.ts` streaming lifecycle** (:410-600): pause/resume at BATCH_SIZE, partial-final-batch delivery before EOF (:497-504), exactly-once `releaseConnection`/`destroyConnection` via `released` flag, waiter drain on close/fail, `timeout: 0` rationale — all correct; cancel path destroys the connection (only way to stop a mysql2 stream), consistent with the class docstring.
- **`src/adapters/mysql.ts:397-406` explicit check (task-file requirement)**: `query(sql, values)` is the ONLY `pool.query()` site in the file (grep: 1 occurrence); all nine metadata call sites and `executeText` route through it; the streaming path uses `pool.getConnection()` + held connection instead. See M1 for the latent-init concern — no *current* defect.
- **`src/adapters/mysql.ts` rowsAsArrays duplicate/derived columns** (:615-622): positional mapping via `names.map(name => row[name])` — for duplicate column names mysql2's object mode would already have clobbered values, and the `Array.isArray(rows[0])` early return handles the streaming `rowsAsArray: true` shape (verified `mysql2/lib/parsers/text_parser.js:180-181` emits positional arrays). Correct.
- **`src/adapters/mssql.ts` streaming** (:619-832): `finish()` drains buffered partial batch into `readyBatch` before EOF, waiter drain, `queue = queue.then(takeBatch, takeBatch)` serializes fetchBatch against completion, cancel/close reset `settled` before request.cancel() (idempotent per tedious `makeRequest` `request.canceled` check — verified `tedious/lib/connection.js`). `openStreamingQuery` first awaits `enqueue` of a no-op (:620) so a streaming request can't interleave with an in-flight metadata request — correct serialization. Clean.
- **`src/adapters/mssql.ts` parameter binding** (:607-617): `addParameter` typed binding, no interpolation; `listColumns` D6 rewrite single LEFT JOIN verified by test. Clean.
- **`src/adapters/postgres.ts cursor path`** (:671-808): BEGIN→DECLARE→FETCH 0 wrapped with ROLLBACK+release(true) on failure (pool stays usable); short-batch early finalize (:749-752) releases the client without waiting for an empty FETCH; cancel via dedicated one-off `Client` (avoids pool deadlock); `adapter.close()` races cleanup with a 2s/3s timeout. The `shouldUseCursor` guards (WITH-DML, SELECT INTO via masked scan) correctly reject cursor-hostile statements (verified logic + `postgres.test.ts` coverage). Clean.
- **`src/adapters/postgres.ts:runQuery` client pinning** (:320-342): single `pool.connect()` for the whole multi-statement script, released in `finally` — the exact fix its comment describes; save flow's `BEGIN;…;COMMIT;` bundle lands on one session. Clean.
- **`src/adapters/types.ts`**: additive `DbTransaction` + optional `beginTransaction` + `estimateTableRowsBatch`; no contract break for existing implementers. Clean.
- **`src/core/queryRunner.ts`**: `run()` closes stale batched cursors from the previous run before starting (:120-129) — exactly-once; cancel reaches `currentBatched` set before initial fetchBatch; `loadMore` per-index serialization via chained promise + guarded map cleanup; `adopt()` best-effort closes the displaced cursor (un-awaited but `.catch`-guarded). Clean.
- **`src/core/statementParser.ts` dialect work** (probe-verified): mysql `BEGIN…END` procedure body stays one statement; `END IF` inside trigger + trailing `INSERT` splits correctly; `WHILE…BEGIN…END` in mssql stays one statement and does NOT swallow the following `SELECT` (round-E stack fix works); `GO` alone-on-line (incl. tab-indented) splits, mid-line `go` does not; mysql `\'` escape keeps `';'` inside the literal; backtick identifiers containing `from` are skipped by the FROM scanner. 73 existing tests green. Clean.
- **`src/core/dangerousStatement.ts`**: dialect-aware masking mirrors the parser's string rules (same `useBackslashEscape` condition) — guard tier can't disagree with the splitter. Clean.
- **`src/core/keywordQualify.ts`**: lazy catalog fetch, caller-owned TTL cache, failure → empty set → SQL passes through unchanged. Clean.
- **`src/extension.ts` changed hunks**: dialect threading to `sqlToRun`/`analyzeStatement` (correct driver source: `mgr.getActive()?.driver`); live-driver CodeLens resolver; SchemaCache invalidation on connection change + refreshSchema; omp engine detection with `onDispose` null-out. Clean.
- **Save-flow host (`resultsPanel.ts` handleSaveEdits/retry)**: host-derived table/PK (webview values ignored); ctid resolver keyed by rowId with per-row try/catch; insert-marked rows excluded from ctid need; combined `BEGIN/COMMIT` single call; saveResult-before-state ordering; skippedRows surfaced as rowErrors. The `WHERE "id"=NULL` gap (S1) is in the pure builder, not the host wiring. Clean apart from S1.

## Rejected Observations (no demonstrable defect)

- "`executeText` runs user DML without awaiting UTC session init" — rejected as a *current* defect: no session initialization exists anywhere in the codebase to bypass (verified by grep over all of `src/`). Recorded instead as the forward-looking half of M1.
- "mssql `runQuery` streams only when `statements.length === 1`" (mssql.ts:234-237) — a final-SELECT-after-DDL in a multi-statement batch is collected non-streaming; behavior matches the comment and results are still returned in order. Not a defect.
- "`literal()` is dead code in mssql.ts" (:869-871) — true but harmless; pre-existing, out of audit scope.
- "panel dispose races manager dispose" — `mgr` is pushed to `context.subscriptions` BEFORE `panel` (extension.ts:70 vs :126), so VS Code disposes panel first, letting `rollbackOpenTransaction()` run before adapter close. Ordering is correct.
- "`saveStatements` no-PK mysql insert-only guard" — probe-verified correct: insert-only emits INSERT; empty-row insert on no-PK non-postgres is refused with warning (P13 probe); the update-only no-PK hard refusal (P12 guard at :567) correctly excludes insert-marked rows.

## Follow-up Disposition

| Finding | Severity | Size | Route |
|---|---|---|---|
| M1 mysql `query()` getConnection choke point | P1 (latent) | small | TASK-006 |
| S1 `WHERE pk = NULL` silent no-op | P2 | small | TASK-006 |
| M3 stream `end` without `fields` hangs | P2 | small | TASK-006 |
| M2 mysql multi-statement partial commit | P2 (pre-existing) | medium | next-cycle queue |
| P1 pg metadata vs manual window | P2 | medium | next-cycle queue (blocked on C1) |
| C1 manualCommit unreachable | P2 | medium | next-cycle queue (product decision) |

No P0 found. No fix implemented in this task per the audit-only contract.
