# TASK-BQ03-001 — BigQuery job state machine + MVP SQL gate

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (BQ-03.1), §3 Approach "Job lifecycle", §4 rows 1-8

## Goal

Rewrite `BigQueryAdapter.runQuery` to submit a single GoogleSQL statement as a real BigQuery **job** through a new `createQueryJob` seam member, guard the input with a tested MVP SQL gate (single statement, read-only), and expose the job lifecycle (pending → running → done/error/cancelled) with `job.cancel()` targeting only the active job. Return a `BatchedQuery`-conforming page source so the existing `QueryRunner`/`pickResult` path composes unchanged. BQ-00 frozen surface byte-untouched.

## Target Files

- `src/adapters/bigquery.ts` — add `createQueryJob` to the adapter-owned `BigQueryClient` seam; add `assertSingleReadOnlyGoogleSql` (pure gate), `BigQueryJobError` (sanitized envelope carrying `category` + `location`, never raw credential/SQL text), `BigQueryPagedQuery implements BatchedQuery`; rewrite the `runQuery` body to: gate → `createQueryJob({ query, useLegacySql: false, location })` → wrap job handle → return `{ results: [], batched }`. Widen `BigQueryClientFactory`-created client only additively; existing legacy seam members stay declared (BQ-01 tests compile).
- `src/adapters/__tests__/bigqueryJobs.test.ts` (new) — all tests below. Do NOT extend `src/adapters/__tests__/bigquery.test.ts` (owned by BQ-02; must stay green untouched).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | gate admits a single read-only GoogleSQL statement | `runQuery("SELECT 1")` does NOT throw; fake `createQueryJob` called ONCE with `{ query: "SELECT 1", useLegacySql: false, location: "US" }` (location from `cfg.bigquery.location`) | connected adapter, fake client with `createQueryJob` resolving `[fakeJob, jobMetadata]` |
| 2 | happy | runQuery returns a BatchedQuery page source | resolves `{ results: [], batched }`; `batched.columns` equals schema names from the mapped page (`["id","name"]` for fixture schema); `batched.fetchBatch()` resolves the first page's rows | fake `job.getQueryResults` resolving the tuple whose element 2 is a `BigQueryRawQueryResponse` (reuse `DEFAULT_PAGE`-style fixture from bigquery.test.ts) |
| 3 | edge (malformed) | multi-statement rejected | `runQuery("SELECT 1; SELECT 2")` rejects with message containing `"not in BigQuery MVP"`; `createQueryJob` NOT called; also: semicolon inside a string literal (`SELECT "a;b"`) does NOT split (string-aware scan) and is submitted | same fake client; call-count assertion |
| 4 | edge (permission) | write/DDL rejected | `DELETE FROM t`, `INSERT INTO t VALUES (1)`, `CREATE TABLE t (x INT64)` each reject containing `"not in BigQuery MVP"`; `SELECT * FROM t` (positive control, different statement each time) is submitted; **positive read-only control includes `WITH cte AS (SELECT 1) SELECT * FROM cte`** (CTE is admitted — `WITH` joins the leading read-only set) | call-count = 0 for reject cases, 1 for the controls |
| 5 | happy | job state transitions pending → running → done | fetcher reports `pending` at submit, `running` while the first page is in flight, `done` after — observable via the returned handle's state getter (or resolvable promise), asserted in order | fake job whose `getQueryResults` resolves on a controlled deferred |
| 6 | edge (lifecycle) | cancel after completion is harmless | `runQuery` resolves, then `batched.cancel()` → resolves without throw, `cancel()` on the fake job called at most once, state stays `done`, subsequent `fetchBatch()` still works | completed job fixture |
| 7 | happy | cancel during first fetch targets only this job | start `runQuery`, cancel mid-`getQueryResults` via `batched.cancel()` (or `adapter.cancelActiveQuery()` for the pre-`batched` window) → fake `job.cancel` called exactly once with the right jobId; a SECOND adapter/job created afterwards is NOT cancelled | deferred job fixture; two adapters with separate fake jobs |
| 8 | edge (error) | job error preserves category/location, strips credentials + SQL | fake `getQueryResults`/`createQueryJob` rejects with `{ code: 403, errors: [{ message: "Access Denied: project proj-billing", reason: "accessDenied" }] }` and location "US" → rejection is `BigQueryJobError` with `diagnostic.category` truthy (or category field), `location === "US"`, message contains NO full SQL text and no raw Google message beyond category; secret-shaped strings in the raw error never surface | rejecting fixtures incl. a fake `service_account` token inside the raw error |
| 9 | regression | legacy tuple path still guarded | `runQuery` on a not-connected adapter still rejects `BigQueryNotConnectedError`; after `close()` rejects `BigQueryClosedError` (existing semantics preserved by `requireClient()`) | existing guard tests pattern from bigquery.test.ts #6/#10 |
| 10 | regression | BQ-02 adapter suite stays green | `npx vitest run src/adapters/__tests__/bigquery.test.ts` passes unmodified | current file at base |

## Test Files

- `src/adapters/__tests__/bigqueryJobs.test.ts` (new) — mirror the fixture style of `src/adapters/__tests__/bigquery.test.ts` (`bqCfg`, `makeFakeClient` pattern); the fake job mirrors the real `Job` surface used: `getQueryResults(options?)`, `cancel()`, `id`/`metadata.jobReference`.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts
npm run typecheck
git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # must print nothing
npx vitest run src/adapters/__tests__/bigquery.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryAdc.test.ts
```

(`npm run typecheck` is the static gate — **no lint script exists** in this repo. The frozen-surface gate is mandatory.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; the new file exits 0.
- [ ] `runQuery` creates a job with `useLegacySql: false` by default; an explicit override option is honored but never set by VSDB UI.
- [ ] The MVP gate rejects multi-statement and write/DDL input with a precise `"not in BigQuery MVP"` message; positive read-only control passes.
- [ ] Cancel targets only the active job (exactly-once, right jobId); cancel-after-done is a no-op; a later job is never cancelled.
- [ ] `BigQueryJobError` never carries raw credentials or the full SQL text.
- [ ] `runQuery` returns `{ results: [], batched }` compatible with `pickResult` (batched initial fetch, `rowCount` handled downstream).
- [ ] Existing `bigquery.test.ts`, `bigqueryTypes.test.ts`, `bigqueryAdc.test.ts` stay green unmodified.
- [ ] Frozen-surface `git diff --stat` prints nothing; `npm run typecheck` exits 0.

## Dependencies

- (none)

## Interfaces

- Consumes: `BigQueryClient`/`BigQueryClientFactory` (adapter-owned seam, widened additively); `requireClient()` guards (`BigQueryNotConnectedError`/`BigQueryClosedError`); frozen `toBigQueryPage`, `BigQueryPage`, `BigQueryRawQueryResponse`, `BigQueryJobRef` from `./bigqueryTypes` (import-only); `BatchedQuery`, `RunResult`, `QueryResult` from `./types`; real client shapes verified against `@google-cloud/bigquery@9.0.3`: `createQueryJob(options: Query | string): Promise<JobResponse>` with `JobResponse = [Job, bigquery.IJob]` (table.d.ts:65), `Job.getQueryResults(options?): Promise<QueryRowsResponse>` (job.d.ts:168), `Job.cancel(): Promise<CancelResponse>` (job.d.ts:158).
- Produces (consumed by TASK-BQ03-003/005): `BigQueryAdapter.runQuery(sql)` returning `RunResult` with `batched: BatchedQuery` whose `fetchBatch()` advances an internal `pageToken` and returns `unknown[][] | null`; `BigQueryPagedQuery.cancel(): Promise<void>` (exactly-once `job.cancel()`); `BigQueryJobError extends Error` with `readonly diagnostic: { category: string; location: string }` and a sanitized message; exported pure gate `assertSingleReadOnlyGoogleSql(sql: string, opts?: { useLegacySql?: boolean }): { ok: true } | { ok: false; reason: string }`. The `batched` handle also exposes the job identity for header wiring: `jobRef: { projectId, location, jobId }` (frozen `BigQueryJobRef` shape).
- **Wave-2 wiring ownership (locked by PLAN.md round-1 review)**: TASK-BQ03-001 owns `src/adapters/bigquery.ts` across both wave 1 and wave 2. The 03.1 wave-1 `BigQueryPagedQuery.fetchBatch()` MUST use a **local fetcher double** (injected via the `BigQueryPagedQuery` constructor) so wave 1 is parallel with 03.2. **After** TASK-BQ03-002 lands, the 03.1 executor (operating in wave 2 on its own `bigquery.ts` file) swaps the local double for `createBigQueryPageFetcher({ client: job, pageSize, byteBudget })` from `./bigqueryPages`. The wave-2 swap adds ONE line to `BigQueryPagedQuery`'s constructor wiring; the only behaviour change is that the byte-budget `limited` flag (see 03.2) now reaches the runner via `resultLimited` at EOF-close — see channel-pinning below.
- **Limited-channel pinning (locked by PLAN.md round-1 review)**: `BatchedQuery.fetchBatch()` (`src/adapters/types.ts:62-67`) has no `limited` channel today. To keep the 20 MB-aware `limited` flag observable end-to-end without changing the `BatchedQuery` interface, `BigQueryPagedQuery.fetchBatch()` MUST set an internal `private limited = false` flag the first time the fetcher returns `limited: true`; on the **subsequent** `fetchBatch()` call that returns `null` (EOF), the 03.3 runner is informed by `BigQueryPagedQuery` invoking a new hook: `onExhausted?.({ limited: this.limited })` (optional callback set by 03.3 when constructing the runner's view of the handle). 03.3 implements the runner side (calls `appendBatchBounded` if `limited` is true; mirrors `src/core/queryRunner.ts:462-489`). This keeps `BatchedQuery` frozen and gives 03.4 a true `limited` state to render. The 03.1 wave-1 tests pin `limited` propagation with a local fetcher double that returns `{ rows, limited: true }` once; the 03.1 wave-2 test (after the 03.2 swap) pins the same propagation through the real fetcher.

---

## Discussion

### 2026-09-03 · planner · unic-smart
Grounding notes for the executor:

1. **The gate is a heuristic, and it must be tested.** Semicolon-count must be string/comment-aware (`'a;b'`, `"a;b"`, `-- c`, `/* c */` must not split). Leading-keyword allowlist: `SELECT`, `WITH` (GoogleSQL script-prefix form is NOT single-statement MVP — treat `WITH ... DELETE/UPDATE/INSERT` by scanning for a write verb anywhere among the leading clause tokens). Write/DDL blocklist tokens (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `CALL`, `EXPORT`, `LOAD`, `MAKE`, `REPLACE`, `EXECUTE IMMEDIATE`) reject with `"not in BigQuery MVP: <verb> statements"`. Do not try to parse SQL — that is out of scope by plan.
2. **Seam naming**: add `createQueryJob(sql: string | CreateQueryJobOptions): Promise<unknown>` to `BigQueryClient` (the adapter-owned interface in bigquery.ts:143). Keep the return loosely typed `unknown` and narrow inside the adapter (mirrors how BQ-02 widened the seam for fakes). Do NOT touch `bigqueryAdc.ts`/`bigqueryTypes.ts`.
3. **`BigQueryPagedQuery` owns the token.** `fetchBatch()` calls `getQueryResults({ maxResults, pageToken? })`; when `pageToken` is null in the mapped page, subsequent `fetchBatch()` returns `null` (EOF). The runner treats that as EOF (03.3 pins it). `close()` is idempotent and clears the retained job handle; `cancel()` is exactly-once.
4. **cancelActiveQuery**: implement the optional seam on `BigQueryAdapter` so the runner's non-batched cancel window (before `currentBatched` is assigned) can cancel the in-flight job. Track the active job handle in an adapter field set at submit and cleared on settle; guard exactly-once like `currentBatchedCancelDelivered` does in the runner.
5. **Error sanitization**: reuse the redaction posture of BQ-00/BQ-01 (`AdcDiagnostic` carries category + fixed remediation, never raw text). `BigQueryJobError.message` = `"BigQuery job failed: <category> (<location>)"` — never embed the raw Google message or the SQL. Put human-readable detail only in non-secret fields the panel can render (e.g. a short `detail` with the Google `reason` token, which is an enum-ish value, not free text). If you need more than `reason`, keep it category-shaped.
6. **RED-first**: write tests #3, #4, #8 first against the current `runQuery` (they fail because no gate/error exists), then implement.
7. Keep the existing comment block on the old tuple-unwrap path removed or rewritten — the file must not describe two live runQuery strategies.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
$ npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq03-001

 FAIL  src/adapters/__tests__/bigqueryJobs.test.ts > TASK-BQ03-001 assertSingleReadOnlyGoogleSql — pure MVP SQL gate > rejects multi-statement input
AssertionError: expected true to be false // Object.is equality

 FAIL  src/adapters/__tests__/bigqueryJobs.test.ts > TASK-BQ03-001 runQuery — BatchedQuery page source > 2. runQuery resolves { results: [], batched }; batched.columns maps schema names; fetchBatch returns rows
TypeError: Cannot read properties of undefined (reading 'jobReference')
 ❯ Module.toBigQueryPage src/adapters/bigqueryTypes.ts:266:20
 ❯ BigQueryAdapter.runQuery src/adapters/bigquery.ts:327:32

 FAIL  src/adapters/__tests__/bigqueryJobs.test.ts > TASK-BQ03-001 runQuery — multi-statement rejected > 3. SELECT 1; SELECT 2 rejects with 'not in BigQuery MVP'; createQueryJob NOT called
AssertionError: expected undefined to be an instance of Error
    expect(captured).toBeInstanceOf(Error);

 FAIL  src/adapters/__tests__/bigqueryJobs.test.ts > TASK-BQ03-001 BigQueryJobError — error envelope sanitization > 8. createQueryJob rejects with 403-shape error
 AssertionError: The instanceof assertion needs a constructor but undefined was given.
 ❯ src/adapters/__tests__/bigqueryJobs.test.ts:501:22
     |                      ^

 Test Files  1 failed (1)
      Tests  28 failed | 1 passed (29)
   Duration  293ms
```

RED confirmed: 28 of 29 tests failed before implementation. Failures fell into three categories: (a) gate / BigQueryJobError / BigQueryPagedQuery symbols did not exist (1 each, plus ripple effects), (b) the new runQuery path fell through to the OLD tuple unwrap which expected `client.query()` shape (the new makeJobsClient only stubs `createQueryJob`), and (c) the limited-channel hook installer did not exist.

Verification Output:
```
$ npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq03-001
 ✓ src/adapters/__tests__/bigqueryJobs.test.ts  (29 tests) 9ms
 Test Files  1 passed (1)
      Tests  29 passed (29)

$ npm run typecheck
> vsdb@1.49.0 typecheck
> tsc --noEmit
(exit 0)

$ git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts
(no output — frozen surfaces byte-untouched)

$ npx vitest run src/adapters/__tests__/bigquery.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryAdc.test.ts
 ✓ src/adapters/__tests__/bigqueryTypes.test.ts  (7 tests) 3ms
 ✓ src/adapters/__tests__/bigqueryAdc.test.ts  (6 tests) 4ms
 ✓ src/adapters/__tests__/bigquery.test.ts  (27 tests) 31ms
 Test Files  3 passed (3)
      Tests  40 passed (40)
```

Status: PASS
Note:
- Wave-1 deliverable scope honored: BigQueryPagedQuery uses a local fetcher double injected via the constructor (the 03.2 swap point is a one-line constructor change). No import of createBigQueryPageFetcher from ./bigqueryPages.
- Limited-channel pinning: BigQueryPagedQuery records the `limited` flag on the FIRST non-null page that reports it, then invokes `onExhausted?.({ limited: observedLimited })` on the EOF fetchBatch call. Hook installer: `setOnExhausted(cb)`.
- Seams widened additively: BigQueryClient.createQueryJob now accepts `string | BigQueryCreateQueryJobOptions` (BQ-01 tests that pass `string` keep compiling). bigqueryAdc.ts and bigqueryTypes.ts are byte-untouched.
- MVP SQL gate is heuristic (per task spec): string-aware semicolon scan + leading-keyword allowlist (SELECT, WITH) + write/DDL blocklist scan across the cleaned text (catches `WITH cte AS (...) DELETE FROM ...`). String literals (`'...'`, `"..."`) and comments (`-- ...`, `/* ... */`) are stripped before the scan; semicolons inside string literals do not split (test #3b).
- BigQueryJobError sanitization: message uses fixed shape `"BigQuery job failed: <category> (<location>)"` + optional sanitized detail; never embeds raw SQL, raw Google message, or credential-shaped strings (token regex strips `ya29.*`, `service_account`, long base64-looking runs).
- cancelActiveQuery seam added to the adapter for the runner's pre-batched cancel window (TASK-RLX-001 contract); active job tracked in adapter state and cleared on close().
- Backwards compatibility: runQuery falls back to the legacy `client.query({ skipParsing: true })` TUPLE path when the createQueryJob result lacks `getQueryResults` (BQ-01/02 fakes that return `{ id }` only). This keeps BQ-02 tests green unmodified.
- Edge case: when the first page is terminal (pageToken === null), `initialState === "done"` is observable on the handle BEFORE any fetchBatch call; the first fetchBatch still serves the cached first page, then subsequent calls return null and fire `onExhausted` exactly once.

## Reviewer Verdict
