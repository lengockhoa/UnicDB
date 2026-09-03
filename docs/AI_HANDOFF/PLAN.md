# PLAN — Cycle BQ-03: GoogleSQL query jobs + paged Results grid

Source spec: `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §5 "BQ-03 — GoogleSQL jobs, cancellation and paged Results grid" (P0, depends on BQ-01 + BQ-02; coordinated after RLX-02). User P0 answer: **all 5 tasks, ship as v1.50.0** (3 waves).
Base: `main @ 5de036d` (post v1.49.0).

## §1 Intent

BQ-02 shipped BigQuery resource *enumeration* and a preview SQL builder, but running a query still routes through the legacy `runQuery` tuple-unwrap: `client.query(sql, { skipParsing: true })` (`src/adapters/bigquery.ts:319-320`), which does **not** preserve job identity, cannot cancel the active job, and cannot continue past the first page of results. There is no GoogleSQL/legacy-SQL distinction, no read-only gate, and no paged Load More for BigQuery.

**Success definition:** run one GoogleSQL statement as a real BigQuery *job*, render its first page in VSDB Results, and page through the rest via Load More — without losing job identity, query location, cancellation status, or page continuation. Concretely:

1. A large result can be loaded page by page with **no all-result accumulation** (token-driven continuation, never row-count-driven).
2. **Cancellation targets only the active BigQuery job** and cannot cancel a later query.
3. **Job errors preserve Google `category`/`location` context** while removing raw credentials and the full SQL from logs/UI.
4. Non-read-only or multi-statement input is rejected with a precise **"not in BigQuery MVP"** message, not a generic parser error.
5. GoogleSQL is selected (never silently legacy SQL) and surfaced in the result header alongside data project, billing project, location and job link/ID in copy-safe form.

## §2 Scope

### In scope
- **BQ-03.1** job state machine + MVP SQL gate: submit a single GoogleSQL statement as a job via a new `createQueryJob` seam member, expose pending→running→done/error/cancelled, cancel via `job.cancel()`, retain `{projectId, location, jobId}`. `runQuery` returns a `BatchedQuery`-conforming page source so the existing runner/`pickResult` machinery composes unchanged. Owns `src/adapters/bigquery.ts` + NEW test file `bigqueryJobs.test.ts`.
- **BQ-03.2** result page bridge: pure continuation helper (token-verbatim, 20 MB-aware bounded page) + pure cell-display formatter preserving INT64/NUMERIC/BIGNUMERIC/BYTES/JSON/temporal/RECORD/REPEATED display semantics. Owns NEW `src/adapters/bigqueryPages.ts` + NEW `bigqueryPages.test.ts` (no file overlap with 03.1).
- **BQ-03.3** runner continuation contract: Load More consumes only the current statement's page source; concurrent duplicate fetch prevented; late page after cancel/new run discarded; retained job context released once exhausted. Owns `src/core/queryRunner.ts` + runner tests.
- **BQ-03.4** panel state: pending/running/cancelled/limited/error distinct; Load More only when a continuation token exists; a new connection/run cannot display a prior BigQuery page. Owns `src/ui/resultsPanel.ts` + panel tests.
- **BQ-03.5** command integration: GoogleSQL selected for BigQuery (never silent legacy SQL), result header shows data project + billing project + location + job link/ID copy-safe. Owns `src/extension.ts` + extension tests.

### Out of scope (this cycle)
- Routine/parameter introspection depth (roadmap BQ-07b).
- A generic multi-statement SQL parser — rejected via cheap heuristic (§3).
- Any relational transaction abstraction — cancellation is a job op (`job.cancel()`), not rollback.
- `table().getRows` row enumeration (Number-coerces INT64; deferred with BQ-02's seam note).
- Legacy SQL *support* — GoogleSQL is the only submitted dialect; an explicit `useLegacySql: true` hint is honored at the seam but no UI sets it.
- **`formatBigQueryCell` rendering wiring** — the pure helper from BQ-03.2 ships tested + exported but is **not** wired into the results grid in this cycle. RECORD/REPEATED cells keep the existing `ResultsPanel` rendering. A follow-up cycle (BQ-04 or later) swaps it in without re-deriving the display rules.

### Wave plan & file ownership (no same-wave collision)
- **Wave 1** (2 parallel): BQ-03.1 → `src/adapters/bigquery.ts`; BQ-03.2 → `src/adapters/bigqueryPages.ts` (new). Disjoint files, disjoint new test files.
- **Wave 2** (2 parallel): BQ-03.3 → `src/core/queryRunner.ts` (deps: 03.1 — fakes its `BatchedQuery` shape); BQ-03.4 → `src/ui/resultsPanel.ts` (deps: none — consumes only base-present `StatementResult` fields, fakes the runner). Disjoint files.
- **Wave 3** (1): BQ-03.5 → `src/extension.ts` (deps: 03.1 + 03.4 — consumes jobRef/header contracts).
- No demotions: the roadmap's "03.1∥03.2 share bigquery.ts" concern is resolved by moving the page bridge into a NEW pure module `bigqueryPages.ts`; 03.1 owns the adapter file outright and consumes 03.2's helper only from wave 2 onward (03.1's job-state tests inject the page-fetcher dependency directly — see Interfaces).

### Frozen surface (do NOT modify)
- `src/adapters/bigqueryTypes.ts` and `src/adapters/bigqueryAdc.ts` (BQ-00). Import-only. Every task carries a frozen-surface `git diff --stat` gate.

## §3 Approach

**Core idea — make BigQuery a `BatchedQuery` producer.** The existing `QueryRunner`/`pickResult`/`ResultsPanel` already handle a server-side paged source through the `BatchedQuery` interface (`src/adapters/types.ts:62-67`: `columns`, `fetchBatch()`, `cancel()`, `close()`); Postgres single-SELECT already returns `{ results: [], batched }` and `pickResult` performs the initial fetch (with `rowCount: null` keeping Load More honest). BQ-03.1 makes `BigQueryAdapter.runQuery` return the same shape, so paging, cancel, and `resultLimited` all work through code that is already tested and reviewed — no new generic framework, no forked paging path.

The continuation token (`pageToken`) lives *inside* the page source; the runner never sees it (it only calls `fetchBatch()`). That encapsulation is exactly what prevents a prior job's token leaking into a new run.

**Job lifecycle (03.1).** `runQuery`:
1. `requireClient()` (existing not-connected/closed guards).
2. `assertSingleReadOnlyGoogleSql(sql)` — reject multi-statement (semicolon-count heuristic, string-literal/comment-aware) and write/DDL (leading read-only keyword set + write-token blocklist) with a precise `"not in BigQuery MVP: <reason>"` message. Tested, not aspirational.
3. `client.createQueryJob({ query, useLegacySql: false, location })` — new seam member mirroring the real client's verified shapes (`createQueryJob(options: Query | string): Promise<JobResponse>` where `JobResponse = [Job, bigquery.IJob]`; `Job.getQueryResults(options?): Promise<QueryRowsResponse>`; `Job.cancel(): Promise<CancelResponse>` — all in `@google-cloud/bigquery@9.0.3` `.d.ts`). `useLegacySql` from an explicit opts override is honored; default is GoogleSQL (`useLegacySql: false`), never silent legacy.
4. Wrap the returned job handle in a `BigQueryPagedQuery implements BatchedQuery`: `fetchBatch()` calls `getQueryResults({ maxResults, pageToken })`, maps the raw response through frozen `toBigQueryPage`, advances the token, returns `rows` (`null`/empty when the token is exhausted); `cancel()` calls `job.cancel()` exactly once (job op, no rollback); `close()` releases the retained handle.
5. Return `{ results: [], batched }` so `pickResult` performs the initial fetch.

Job state machine: `pending` (job created, first page not yet fetched) → `running` (fetch in flight) → `done` | `error` | `cancelled`. Cancel after completion is a harmless no-op. Job errors map to a sanitized envelope keeping Google `category` + `location` and dropping raw credentials/SQL text. `cancelActiveQuery()` (existing optional `DbAdapter` seam) gains a BigQuery implementation targeting the currently-tracked active job, covering the createJob/first-fetch window before `currentBatched` is assigned.

**Page bridge (03.2).** New pure module `bigqueryPages.ts` (no `@google-cloud/bigquery`, no `vscode` imports):
- `createBigQueryPageFetcher(deps)` — consumes the raw `getQueryResults` tuple, maps through frozen `toBigQueryPage`, preserves the token verbatim (null = final page), and applies a 20 MB-aware bound: a `byteBudget` marks the page `limited` when `totalBytesProcessed`/projected page bytes exceed the budget; the budget is advisory at the seam (real GCP byte behavior varies by region — verified via fixture tests, not live GCP).
- `formatBigQueryCell(value, field?)` — renders a `BigQueryValue` for display without `Number()` coercion: INT64/NUMERIC/BIGNUMERIC stay canonical strings, FLOAT64 stays numeric, BYTES stays base64, JSON/temporal stay strings, RECORD/REPEATED serialize structurally.

**Runner continuation (03.3).** Small, driver-agnostic: when `fetchBatch()` returns `null`/empty (final page), close the handle and mark the statement exhausted (reuse `cursorClosed` semantics) so a later `loadMore` is a graceful no-op and the retained job context is released. Reuse the existing `loadMoreInFlight` serialization and the `cancelSeq` post-await late-page discard; pin both with regression tests plus per-index isolation (loadMore on statement #2 never touches #1's handle/token).

**Panel state (03.4).** `StatementResult.status` already carries `running/done/error/cancelled`; 03.4 distinguishes a BigQuery `pending` (job submitted, first page not yet fetched) from `running`, and gates Load More on the presence of a continuation capability rather than row count. Reuse the existing `sessionEpoch`/`requerySeq` staleness guards so a new connection/run cannot render a prior page.

**Command integration (03.5).** `runStatements` (shared editor/Console path) builds a copy-safe BigQuery result header — data project, billing project, location, job link/ID (`https://console.cloud.google.com/bigquery?project=<billing>&j=bq:<location>:<jobId>` form, HTML-escaped) — and never chooses legacy SQL silently.

**Alternatives rejected:**
- A generic multi-statement SQL parser / transaction abstraction — YAGNI; contradicts the "reject with a precise MVP message" policy.
- Forking a separate BigQuery paging path in runner/panel — the `BatchedQuery` seam already encodes fetch/cancel/close semantics; a fork would double the cancel-state surface.
- Exposing the raw page token to runner/panel — the token must stay encapsulated in the page source (leaked tokens are the bug class the roadmap calls out).

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | `SELECT 1` submits a GoogleSQL job and returns a `BatchedQuery` page source | `{ results: [], batched }`; `batched.columns` from schema; job created with `useLegacySql: false` and location from config |
| happy | pending→running→done job state | state transitions emitted in order; `done` carries the mapped `QueryResult` with branded-string cells |
| happy | first page + Load More across 3 pages | pages appended with no all-result accumulation; token advances verbatim; null final token stops continuation and closes the handle |
| happy | cell display preserves INT64/NUMERIC/BIGNUMERIC/BYTES/JSON/temporal/RECORD/REPEATED | no `Number()` coercion; branded strings, base64, JSON strings, nested structures preserved |
| happy | result header shows data project, billing project, location, job link/ID | header contains all four facts in copy-safe (escaped) form |
| edge (malformed) | multi-statement `SELECT 1; SELECT 2` (incl. semicolon inside string literal) | rejected with `"not in BigQuery MVP"`; no job created |
| edge (permission) | write/DDL `DELETE FROM t` / `CREATE TABLE t (...)` / `INSERT ...` | rejected with `"not in BigQuery MVP"`; no job created |
| happy | explicit read-only statement passes the gate | `SELECT`-leading statement accepted; positive control for the gate |
| edge (lifecycle) | cancel after completion | harmless no-op; no state corruption; later query unaffected |
| edge (concurrency) | two concurrent `loadMore` on the same index | serialized via existing in-flight chain; no lost/duplicated batch |
| edge (stale) | late page settles after `cancel()` or a new `run()` | discarded; never appended onto cancelled/new state |
| edge (boundary) | 20 MB-aware bounded page | page over budget marked `limited`; budget enforced in the fetcher |
| edge (identity) | `loadMore` on statement #2 after #1 completed | consumes only #2's page source/token; #1's handle untouched |
| edge (error) | job error preserves `category`+`location`, strips credentials + full SQL | sanitized envelope surfaces category/location; no credential/SQL text in message/log |
| regression | existing postgres/mysql/mssql cursor + runner tests stay green | no behavior change for non-BigQuery batched paths |

Each task file expands these into concrete Type/Name/Expected rows with fixtures (≥1 happy + ≥2 edge cases of different kinds; the SQL gate gets positive read-only + multi-statement reject + write/DDL reject).

## §5 Verification

Run from repo root. **No `lint` script exists** in `package.json` (`scripts`: `compile`, `watch`, `test`, `test:integration`, `typecheck`, `package`, `verify:fast`, `verify:release`, `profile:*`, `vscode:prepublish`). The static gate is `npm run typecheck` (`tsc --noEmit`).

```bash
npm run typecheck
# targeted per task:
npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts     # BQ-03.1
npx vitest run src/adapters/__tests__/bigqueryPages.test.ts    # BQ-03.2
npx vitest run src/core/__tests__/queryRunner.test.ts          # BQ-03.3
npx vitest run src/ui/__tests__/resultsPanel.test.ts           # BQ-03.4
npx vitest run src/extension.test.ts                           # BQ-03.5
# frozen-surface gate (every task):
git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # must print nothing
# sanity net (adapter tasks):
npx vitest run src/adapters/__tests__/bigquery.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryAdc.test.ts
```

## §6 Acceptance

- [ ] A large result loads page by page with no all-result accumulation (BQ-03.1, BQ-03.3).
- [ ] Cancellation targets only the active BigQuery job; a later query is never cancelled (BQ-03.1).
- [ ] Job errors preserve `category`/`location`, stripping raw credentials + full SQL from logs/UI (BQ-03.1, BQ-03.4).
- [ ] Multi-statement and write/DDL input rejected with `"not in BigQuery MVP"`; tested positive read-only control (BQ-03.1).
- [ ] GoogleSQL selected, never silent legacy SQL; header shows data project, billing project, location, job link/ID copy-safe (BQ-03.5).
- [ ] Panel pending/running/cancelled/limited/error distinct; Load More only when a continuation token exists; new run/connection cannot show a prior page (BQ-03.4).
- [ ] `npm run typecheck` exits 0; every targeted test file exits 0; frozen-surface `git diff --stat` prints nothing.
- [ ] Manual (release note, not automated): small query, large paged query, cancelled long query, location mismatch, denied query, non-read-only statement.

## §7 Global Constraints

- Node ≥ 20 (repo runs v22); package manager `npm`; TypeScript strict — `npm run typecheck` must exit 0.
- No new runtime dependency; no new `@google-cloud/bigquery` import at module top level (lazy `require` in the default factory preserved).
- Frozen surfaces `src/adapters/bigqueryTypes.ts` and `src/adapters/bigqueryAdc.ts` are import-only.
- No generic multi-statement parser, no transaction abstraction, no `Number()` coercion of INT64/NUMERIC/BIGNUMERIC/numRows/byte strings past `Number.MAX_SAFE_INTEGER`.
- Error/log/UI surfaces never carry raw credentials or the full SQL text (category + location + sanitized message only).

---

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (round 2, 2026-09-03; all 5 round-1 fixes verified landed; 3 non-blocking prose nits recorded for the record)

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: Split BQ-03.1/BQ-03.2 across `bigquery.ts` vs NEW `bigqueryPages.ts` (removing the roadmap's same-file collision) so wave 1 is genuinely 2-wide; moved the MVP SQL gate into 03.1 (the submit entry must reject before job creation); made BQ-03.4 dependency-free (it consumes only base-present `StatementResult` fields and fakes the runner) so wave 2 is 2-wide per the directed 3-wave plan; added the positive read-only control test the SQL gate needs; verified real client signatures (`createQueryJob`, `Job.getQueryResults`, `Job.cancel`) against the installed 9.0.3 `.d.ts` before quoting them.
Known gaps: The 20 MB bound is a budget/marking helper verified via fixtures, not a byte-precise policy against live GCP (real byte behavior varies by region; not reproducible in CI). `useLegacySql: true` is honored at the job-creation seam (tested) but no UI sets it — GoogleSQL is the only submitted dialect per policy. The manual six-query checklist (small/large/cancelled/location-mismatch/denied/non-read-only) cannot be automated without a real GCP project; it is recorded as a manual release note. BQ-03.1's `runQuery` consumes BQ-03.2's page-fetcher helper only via a wave-2 follow-up seam — 03.1's own tests inject a local fetcher double, so wave-1 parallelism never blocks on 03.2; wiring the pure helper into `BigQueryPagedQuery` lands with 03.3's wave (noted in both Interfaces blocks).

## Plan Review Log

### Round 1 — 2026-09-03 · unic-smart
Status: Issues Found

- Approved: roadmap BQ-03 coverage is complete (every bullet → §4 row or explicit deferral, incl. the manual six-query checklist); all 5 task files carry every Task Gate field (Goal/Targets/Test Cases/Interfaces with real signatures/Verification incl. typecheck/Acceptance); verification commands verified runnable against base (`typecheck` exists, no lint script exists and §5 says so, all referenced test paths exist); scope/YAGNI clean (token encapsulated in the page source, no parser/transaction abstraction, frozen surface gated per task, `types.ts` untouched per roadmap "only if"); PLANNER_MODEL footer present.
- Consistency (must fix): wave-2 wiring of `createBigQueryPageFetcher` into `BigQueryPagedQuery` requires editing `src/adapters/bigquery.ts`, but no wave-2 task owns that file (03.1 owns it in wave 1 only; the Self-Audit's "noted in both Interfaces blocks" is inaccurate — TASK-BQ03-001's Interfaces block carries no wave-2 note) — as written the swap is either skipped (03.2's fetcher + byteBudget/limited tests become dead code, two page-fetch implementations drift) or done by an executor editing a file they don't own; related: `BatchedQuery.fetchBatch()` (`src/adapters/types.ts:62-67`) has no `limited` channel, so the byte-budget flag's observable behavior after wiring is unspecified.
- Clarity (must fix): `formatBigQueryCell` has no production call-site in any of the 5 tasks (03.4 owns states only; "any later display wiring" in TASK-BQ03-002 Interfaces is hand-waving) — RECORD/REPEATED cells keep today's rendering while the formatter ships tested-but-unwired.
- Clarity (should fix): 03.4's pending-vs-running mechanism is unpinned — `StatementResult` lives in `src/core/queryRunner.ts` (03.3's file, same wave) and `sanitizeStatementResult` (resultsPanel.ts:2191) reduces `batched` to boolean, so the panel cannot read the handle's state getter; risk of a mid-task same-wave file collision.
- Minor: the MVP SQL gate positive-control set lacks `WITH cte AS (SELECT 1) SELECT * FROM cte` — pin it (admit = WITH joins the leading read-only set; or explicitly reject) in TASK-BQ03-001 test #4.

NOTES: Planner (unic-smart) and reviewer (unic-smart) share a model id; per RULES §P2.5 plan-review independence is fresh-context based, and this review ran in a fresh context — flagged here for transparency. Two must-fix ownership/consistency items + two clarity pins before tasks execute.

### Round 1 — 2026-09-03 · orchestrator · unic-smart (findings applied)
Applied directly to `PLAN.md` + task files (TASK-BQ03-001, -002, -003, -004) before round 2 re-review:

1. **Wave-2 ownership gap (was: blocking)** — pinned in TASK-BQ03-001 Interfaces: the wave-1 `BigQueryPagedQuery` uses a local fetcher double; the 03.1 executor (operating on its own `bigquery.ts` file in wave 2) swaps the double for `createBigQueryPageFetcher` from `./bigqueryPages` once 03.2 lands. TASK-BQ03-001 explicitly owns `src/adapters/bigquery.ts` across both waves.
2. **`limited` channel (was: blocking)** — pinned in both 001 and 002 Interfaces + 003's `onExhausted?.({ limited })` hook: `BatchedQuery` stays frozen; `BigQueryPagedQuery` carries the flag internally and informs the runner via `onExhausted` at EOF; 03.3 calls `appendBatchBounded` (mirroring `src/core/queryRunner.ts:462-489`) so the flag surfaces as `resultLimited`.
3. **`formatBigQueryCell` no call-site (was: clarity)** — recorded in `PLAN.md` §2 Out of scope + TASK-BQ03-002 Interfaces as **deliverable-but-unwired this cycle**, named as a follow-up (BQ-04 or later), not a hidden TODO.
4. **03.4 pending-vs-running (was: clarity)** — pinned in TASK-BQ03-003 + 004 Interfaces: 03.3 adds an OPTIONAL `pending?: boolean` field to `StatementResult`; 03.4 reads it directly; field flows through `sanitizeStatementResult` (it spreads `...r`) — backward-compatible additive change; non-BigQuery paths leave it `undefined` and behavior is byte-identical to base.
5. **Minor (CTE positive control)** — TASK-BQ03-001 test #4 now pins `WITH cte AS (SELECT 1) SELECT * FROM cte` as part of the positive read-only controls (`WITH` joins the leading read-only set per the gate definition in TASK-BQ03-001 Discussion #1).

### Round 2 — 2026-09-03 · unic-smart
Status: Approved

1. Wave-2 ownership — LANDED: TASK-BQ03-001 Interfaces (line 66) explicitly owns `src/adapters/bigquery.ts` across wave 1 + wave 2, pins the wave-1 local fetcher double (constructor-injected) and the post-03.2 swap to `createBigQueryPageFetcher` from `./bigqueryPages` performed by the 03.1 executor in wave 2; PLAN.md line 39 agrees.
2. `limited` channel — LANDED: 001 (line 67), 002 (line 66), 003 (lines 60/62) pin one identical contract: `BatchedQuery` stays frozen, `BigQueryPagedQuery` keeps an internal `limited` flag, `onExhausted?.({ limited })` fires on next-null-after-limited EOF, 03.3 calls `appendBatchBounded` mirroring `src/core/queryRunner.ts:462-489` so the flag surfaces as `resultLimited`.
3. `formatBigQueryCell` deliverable-but-unwired — LANDED: PLAN.md §2 Out of scope (line 33) names the follow-up (BQ-04 or later); TASK-BQ03-002 Interfaces (line 67) says ships tested + exported, not wired into the results grid this cycle. Non-blocking nit: 002 claims the record also lives in PLAN.md §6 Acceptance — it does not (§2 only).
4. `pending` mechanism — LANDED: 003 Interfaces (line 63) + 004 Interfaces (line 60) pin OPTIONAL `pending?: boolean` on `StatementResult`, set on the BigQuery `{ results: [], batched }` return, cleared on first page, read directly by 03.4, flowing through `sanitizeStatementResult` (`...r` spread); `undefined` + byte-identical on all non-BigQuery paths.
5. CTE positive control — LANDED: TASK-BQ03-001 test #4 (line 24) includes `WITH cte AS (SELECT 1) SELECT * FROM cte` in the positive read-only controls; Discussion #1 (line 76) pins `WITH` in the leading allowlist with the write-verb scan for `WITH ... DELETE/UPDATE/INSERT`.

NOTES: All 5 round-1 fixes landed where claimed; round 2 closed. Non-blocking prose nits only, none blocks P3: (a) 002's §6 cross-reference is inaccurate (record exists in §2 only); (b) 001 line 66 sketches the swap as `createBigQueryPageFetcher({ client: job, pageSize, byteBudget })` vs 002's authoritative deps `{ fetch, byteBudget? }` — the wave-2 swap compiles against the real module, so drift cannot ship silently, 002's signature governs; (c) 004 Target Files 14(c) retains pre-fix hedging superseded by the pinned Interfaces contract.
