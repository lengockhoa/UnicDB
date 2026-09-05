# ADR 0004 — BigQuery feasibility + adapter contract

- Status: **Accepted** (gating BQ-01 — this ADR lands before any BQ-01 source change; TASK-BQ00-001/002/003 produced the evidence it cites; BQ-01 implements against this contract and any deviation must open a new ADR)
- Date: 2026-09-02
- Deciders: UnicDB maintainers (recorded in `docs/AI_HANDOFF/PLAN.md` §3, cycle BQ-00 commissioning brief; source roadmap `docs/plans/2026-09-01-UnicDB-additive-roadmap.md` §BQ-00)
- Scope: `src/adapters/bigqueryTypes.ts` (boundary types + `toBigQueryPage` mapper + `hasNextPage` helper, written by TASK-BQ00-002), `src/adapters/bigqueryAdc.ts` (ADC diagnostic classifier + client seam + smoke, written by TASK-BQ00-003). The ADR itself changes no source; BQ-01 implements against it.

## 1. Context and problem

BQ-00 is a feasibility spike. The roadmap opens several questions that must be
closed before BQ-01 can implement a BigQuery adapter safely: which package
version is bundle-safe under the extension's esbuild options, what the client's
real pagination/cancellation return shapes are (versus the planner's
expectations), what scalar-coercion rules must be pinned so the result grid
does not silently lose precision, what IAM is the minimum to ask of a user,
whether Storage Read API is in scope now or deferred, and — most concretely —
how the BigQuery continuation model maps onto the existing `RunResult.batched`
contract that the Postgres adapter and the results panel already share. This
ADR closes each question with a single decision and cites the recorded evidence
for it.

## 2. Decision — client method/version

**Decision.** Adopt `@google-cloud/bigquery@9.0.3` (declared `^9.0.3` in
`package.json`; resolved exact `9.0.3` in `package-lock.json`). Fallback pin
`^8.3.1` was **not** triggered: 9.0.3 installed cleanly, loads without
credentials, and bundles under the extension's exact esbuild options with a
probe bundle size of **1,193,010 bytes** and **zero** esbuild errors.

**Engine floor:** the package's `engines.node` field is `>=22`; the dev runtime
in use is `v22.22.1`. The pin is satisfied. The probe used the same esbuild
options as the extension (`bundle: true`, `platform: "node"`, `format: "cjs"`,
`target: "node18"`, `external: ["vscode"]`, `write: false`) and ran no I/O.

**Evidence:** `docs/decisions/_bq00-evidence.md` §"Pinned package" and
§"Build options proven (probe options)" — captured by
`src/adapters/__tests__/bigqueryPackage.test.ts` test #7 (regex `\bNAME\s*\(`)
and the probe-args assertions.

## 3. Decision — continuation ownership

**Decision.** UnicDB owns the **opaque page token + `BigQueryJobRef` triple**
(`{ projectId, location, jobId }`) across pages. The client is **stateless per
page**: each `GetQueryResults` call carries the job reference plus the next
token verbatim; the library does not hold any per-UnicDB session state.

**Token decides continuation — NEVER row count.** An empty page with a
non-null token still has more pages; a non-empty page with a `null` token is
the final page. The `hasNextPage` predicate in `src/adapters/bigqueryTypes.ts`
encodes exactly this rule. Row count is incidental; using it as a continuation
signal is a correctness bug.

**Opacification rule.** The token is forwarded **verbatim** between the
mapper (`toBigQueryPage`) and the next request — no parse, no trim, no
truncate, no decode. The mapper comment at `src/adapters/bigqueryTypes.ts:78`
and test #4 of the TASK-BQ00-002 suite pin this. The token's character set,
length, and content are owned by the BigQuery server.

**Evidence:** `docs/decisions/_bq00-evidence.md` §"`BigQuery.getQueryResults` — on `Job`" (the
`QueryRowsResponse` shape is `PagedResponse<RowMetadata, Query, QueryResultsResponse>`
with a `nextQuery` cursor — auto-paginated when the caller uses the Promise
overload); `src/adapters/bigqueryTypes.ts` `BigQueryPage.pageToken`/`hasNextPage`.

## 4. Decision — cancellation mapping

**Decision.** Cancellation in UnicDB operates on the **active job ID only**,
which is `projectId + location + jobId` (the `BigQueryJobRef`). There are no
guessed job IDs: UnicDB only ever calls `cancel` on a `Job` handle it received
from `createQueryJob` (or one re-derived from a `jobReference` carried in a
paged response, where the triple is exactly what `GetQueryResults` echoed
back).

**Cancel-after-terminal is harmless.** A `Job` already in `DONE` (success or
error state) accepts the cancel call and returns the acknowledgement tuple; it
does not surface a failure to the caller. We do not need a state pre-check
before cancelling.

**No row cancellation, no statement cancellation.** BigQuery's cancel is
**job-scoped**; the API has no per-page or per-statement cancel. The existing
`RunResult.batched.cancel()` path remains a UnicDB-level concern (it must close
the cursor + release the in-flight guard at `src/core/queryRunner.ts`), and
the BigQuery driver side calls `job.cancel()` when it sees that signal.

**Evidence:** `docs/decisions/_bq00-evidence.md` §"`Job.cancel` — on `Job`"
and the UnicDB-side `BatchedQuery.cancel` contract at `src/adapters/types.ts:65`.

## 5. Decision — safe scalar conversion

**Decision.** The contract scalar set is the **wire types BigQuery actually
emits**, not JS coercion targets. Each type has a fixed UnicDB representation;
no JS-level coercion is allowed across the boundary that would silently lose
precision.

| BigQuery type | UnicDB representation | Notes |
|---|---|---|
| `STRING` | `string` | verbatim |
| `INT64` | `string` | canonical string; never `Number` (silently loses precision past `Number.MAX_SAFE_INTEGER`) |
| `NUMERIC` | `string` | canonical string; never `Number` (precision is the whole point) |
| `BIGNUMERIC` | `string` | canonical string; never `Number` |
| `FLOAT64` | `number` | **non-finite values (`NaN`, `Infinity`, `-Infinity`) are kept verbatim** — the result grid renders them rather than coercing to `null` or `0` |
| `BOOL` / `BOOLEAN` | `boolean` | verbatim |
| `BYTES` | `string` | base64-encoded; the client returns b64 already |
| `DATE` / `TIME` / `DATETIME` / `TIMESTAMP` | `string` | canonical wire format; rendering layer parses |
| `JSON` | `string` | canonical wire format |
| `GEOGRAPHY` | `string` | canonical wire format (WKT) |
| `RECORD` | `{ [field: string]: BigQueryValue }` | nested; recursively mapped by `mapSchemaField` |
| `REPEATED` (any) | `BigQueryValue[]` | outer array; element type matches `mode = REPEATED` |
| `NULL` | `null` | **distinct from empty string** — never collapsed |

`src/adapters/bigqueryTypes.ts` `BigQueryValue` (the union type defined at
`bigqueryTypes.ts:90` — TASTE NOTE: the union was at :63 in earlier drafts and
moved to :90 when the file grew; the cite uses the current line) implements
exactly this set; the comments on `BigQueryValue` reproduce the rule. `Number`
coercion is **prohibited** for `INT64`, `NUMERIC`, `BIGNUMERIC`. `null` is
**distinct** from `""`.

**Evidence:** `src/adapters/bigqueryTypes.ts` lines defining `BigQueryValue`
(type alias and the docstring above it). Cross-referenced against
`docs/decisions/_bq00-evidence.md` for the wire-format confirmation.

## 6. Decision — selected config fields

**Decision.** The BigQuery adapter config exposes **only** the three metadata
fields listed below. No secret fields, no key files, no service-account JSON,
no inline credentials, no environment-variable probing.

| Field | Purpose | Validation |
|---|---|---|
| `projectId` (billing project) | project billed for query bytes; passed to `BigQuery` client constructor and to `listDatasets` for connectivity | non-empty string; user-visible label |
| `location` | BigQuery location for the job (`"US"` / `"EU"` / region like `"us-central1"`); passed to `BigQuery` client constructor | one of a whitelist or free-form string with a warning |
| `maximumBytesBilled` | hard cap on bytes billed per query; passed to `QueryOptions.maximumBytesBilled` to fail fast before running expensive queries | positive integer as string (preserves precision) |

**What is deliberately NOT exposed:** `keyFilename`, `credentials`,
`credentials.client_email`, `projectId` for dataset routing (the dataset is
in the SQL), any OAuth/token/refresh field, any ADC path override.

**ADC source itself is owned by the runtime** — `gcloud auth application-default login`
or the standard Google Auth library environment. UnicDB never logs, persists, or
echoes the resolved credential path.

**Evidence:** TASK-BQ00-003 `src/adapters/bigqueryAdc.ts` — the `createBigQueryClient(projectId?, impl?)`
seam only accepts a `projectId`; remediation copy never interpolates from
`err.message`; `AdcDiagnostic` type has no field for the raw error message,
enforcing redaction by construction.

## 7. Decision — required IAM

**Decision.** The minimum IAM set UnicDB documents for users is the
**least-privilege set below**. Nothing broader.

| Permission | Why |
|---|---|
| `bigquery.jobs.create` | required for `createQueryJob` (running a SELECT) |
| `bigquery.jobs.get` | required to fetch `jobReference` for paging + to inspect status on cancel acknowledgement |
| `bigquery.jobs.update` or `bigquery.jobs.cancel` | required for `Job.cancel`; the BigQuery cancel endpoint uses `jobs.update` semantics |
| `bigquery.jobs.list` (optional) | used only by the smoke recipe's `listDatasets` step and the diagnostic listing; can be omitted if the user does not run the smoke |
| `bigquery.tables.get` | required for table metadata in error messages and for the schema preview; not strictly required for `getQueryResults` once a job exists |
| `bigquery.tables.getData` | required for `getQueryResults` over a query that touches the table |

**Prohibited:** `bigquery.jobs.delete`, `bigquery.tables.delete`,
`bigquery.tables.update`, `bigquery.datasets.delete`, `bigquery.datasets.update`,
any `roles/bigquery.admin`, `roles/owner`, `roles/editor`, or wildcard `*`.
UnicDB's adapter is read-only by design; no write/owner grants should be needed.

**Evidence:** the four methods enumerated in §10 (whose citations point back
to `docs/decisions/_bq00-evidence.md`); IAM set derived from those surfaces.

## 8. Decision — Storage Read API deferral

**Decision.** **Storage Read API is out of scope for BQ-00 and BQ-01.** The
adapter uses the standard `jobs.query` / `jobs.getQueryResults` REST path
only. Storage Read API (`bigquery.readsessions.*`) is a faster streaming
variant that bypasses the jobs API entirely and has different pagination,
cancellation, and error-shape semantics.

**Reason.** Storage Read API is a separate measured decision that BQ-07e
will own. Adopting it now would mean duplicating the entire pipeline decision
(page token vs `StreamRow.offset`, job cancellation vs stream cancellation,
new IAM set including `bigquery.readsessions.*` and `bigquery.tables.export`).
Deferral lets BQ-01 ship against the simpler, well-documented REST contract
that the four enumerated methods already cover.

**Trigger to revisit.** The deferral stays in force unless BQ-07e (or a
follow-up) shows a measured benefit (latency, throughput, bytes-scanned
profile) that the REST path cannot meet, **and** records an updated
IAM + cancellation contract in a new ADR.

**Evidence:** deferral is a paper decision recorded here; no source code is
involved.

## 9. Manual ADC smoke recipe

This is an **operator recipe** for a maintainer validating the adapter against
a live (disposable) Google Cloud project. It must be performed out-of-band;
**no values from this recipe are recorded in this document** — no project IDs,
no credential paths, no token-shaped strings, no raw error output.

1. **Create a disposable test project** in Google Cloud Console (do NOT use a
   production project; do NOT reuse an existing billing project).
2. **Enable the BigQuery API** on the disposable project
   (`APIs & Services → Library → BigQuery API → Enable`).
3. **Create a service account** with the **least-privilege IAM set** in §7
   only. Save the JSON key locally; do NOT commit it.
4. **Authenticate locally** with ADC using the standard Google tooling:
   `gcloud auth application-default login` (interactive — required for
   user-flow credentials; uses the disposable test identity).
5. **Point UnicDB at the disposable project** via the config fields in §6
   (`projectId`, `location`, `maximumBytesBilled`).
6. **Run the smoke** — the adapter's `runAdcSmoke` calls
   `client.listDatasets()`; success resolves to `"ok"`, failure resolves to an
   `AdcDiagnostic` envelope (no raw error text).
7. **Run a real SELECT** through the results panel: open a `.sql` file, write
   a small `SELECT 1 AS x` statement, execute. The first page returns;
   "Load more" appears if and only if the page token is non-null.
8. **Run a real cancel**: open a larger query (e.g. against
   `bigquery-public-data.samples.natality` with a `LIMIT` large enough to take
   a few seconds) and press Cancel during the run; the job transitions to
   `DONE` with a cancel acknowledgement tuple, and the panel stops fetching.
9. **Discard** the disposable project, the service account, and any local
   JSON key once validation completes.

**Never-record rule.** This ADR, the task Discussion thread, the plan, and
the README index never receive: env values (`GOOGLE_APPLICATION_CREDENTIALS`,
`GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`), credential file paths, token-shaped
strings, raw error messages, ADC failure output, or any value the
`AdcDiagnostic` redaction-by-construction type would have stripped. The
diagnostic categories are the only acceptable reference to failure modes.

## 10. Pagination + cancellation method names

This section enumerates the four roadmap-mandated method names and their
**return shapes** as recorded in
[`docs/decisions/_bq00-evidence.md`](_bq00-evidence.md). Source-of-truth: the
installed `@google-cloud/bigquery@9.0.3` `.d.ts` files; the file:line references
are reproduced verbatim from the evidence file.

### `BigQuery.getQueryResults` — on `Job`

- **File:** `node_modules/@google-cloud/bigquery/build/src/job.d.ts`
- **Line:** 234 (first overload); overloads at 235, 236
- **Signatures:**

```ts
getQueryResults(options?: QueryResultsOptions): Promise<QueryRowsResponse>;
getQueryResults(options: QueryResultsOptions, callback: QueryRowsCallback): void;
getQueryResults(callback: QueryRowsCallback): void;
```

- **Return shape:** the Promise overload resolves to `QueryRowsResponse`,
  exported from `bigquery.d.ts:49` as
  `PagedResponse<RowMetadata, Query, QueryResultsResponse>` — a paginated
  response object (not a bare array) carrying row metadata plus a `nextQuery`
  cursor. Auto-paginated form: callers should not need to call `getQueryResults`
  again themselves.

### `BigQuery.query` — on `BigQuery`

- **File:** `node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts`
- **Lines:** 1119–1124 (overloads)
- **Signatures:**

```ts
query(query: string, options?: QueryOptions): Promise<QueryRowsResponse>;
query(query: Query, options?: QueryOptions): Promise<SimpleQueryRowsResponse>;
query(query: string, options: QueryOptions, callback?: QueryRowsCallback): void;
query(query: Query, options: QueryOptions, callback?: SimpleQueryRowsCallback): void;
query(query: string, callback?: QueryRowsCallback): void;
query(query: Query, callback?: SimpleQueryRowsCallback): void;
```

- **Return shape:** the string-SQL form resolves to `QueryRowsResponse` (the
  paged form — same type as `getQueryResults`). The object-`Query` form
  resolves to `SimpleQueryRowsResponse`, which `bigquery.d.ts:51` defines as
  `[RowMetadata[], bigquery.IJob]` — a tuple of `[rows, job]` rather than a
  paginated response object. **Difference UnicDB must respect:** the string
  form auto-paginates, the object form returns the raw `[rows, job]` tuple.

### `BigQuery.createQueryJob` — on `BigQuery`

- **File:** `node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts`
- **Lines:** 782–783 (overloads)
- **Signatures:**

```ts
createQueryJob(options: Query | string): Promise<JobResponse>;
createQueryJob(options: Query | string, callback: JobCallback): void;
```

- **Return shape:** Promise overload resolves to `JobResponse` — defined as
  `[Job, bigquery.IJob]` in the `table.d.ts` import line
  (`bigquery.d.ts:22` imports `JobResponse, JobCallback` from `./table`). The
  `Job` instance returned in the tuple is the handle UnicDB needs to call
  `cancel()` and `getQueryResults()` on. **A BigQuery driver must destructure
  the tuple (`const [job] = await bq.createQueryJob(...);`) and operate on
  the `Job`, not the raw API response.**

### `Job.cancel` — on `Job` (roadmap line-67 cancellation-return-shape mandate)

- **File:** `node_modules/@google-cloud/bigquery/build/src/job.d.ts`
- **Lines:** 158–159 (overloads)
- **Signatures:**

```ts
cancel(): Promise<CancelResponse>;
cancel(callback: CancelCallback): void;
```

- **Return shape:** Promise overload resolves to `CancelResponse`,
  defined in `job.d.ts:27` as
  `export type CancelResponse = [bigquery.IJobCancelResponse];` — a **tuple of
  one element**: the raw `IJobCancelResponse` (a status object with the
  BigQuery job-cancel API response; carries no job metadata, only the cancel
  acknowledgement). `CancelCallback` (`job.d.ts:26`) is
  `RequestCallback<bigquery.IJobCancelResponse>` — the standard
  `(err, response) => void` node-style callback.
- **Implication for UnicDB:** `job.cancel()` is **not** `void`. It returns a
  promise that resolves to a tuple; the cancel acknowledgement is wrapped in
  `[apiResponse]`. To know whether cancellation succeeded the caller must
  inspect the tuple element (no `job.status` is bundled in the response —
  cancel just acknowledges the request; a separate `getMetadata()` is
  required to confirm the job actually stopped). BQ-01's cancel wiring must
  handle the tuple destructuring.

**Source of truth.** All four entries above are recorded verbatim in
[`docs/decisions/_bq00-evidence.md`](_bq00-evidence.md). Any change to a
signature or return shape invalidates this ADR and triggers a new one.

## 11. Grid continuation mapping

The existing UnicDB grid continuation contract is independent of the underlying
adapter: `RunResult` at `src/adapters/types.ts:76` carries a `results` array
plus an optional `batched?: BatchedQuery` handle (the `batched` field is
declared at line 78), and the results panel's webview "Load more" button
posts a `loadMore` message that the host resolves to
`runner.loadMore(index)` (the panel's switch case at `src/ui/resultsPanel.ts:748`
calls `this.runner.loadMore(msg.index)` and then re-posts the updated state).
BigQuery's continuation handle — the `pageToken` on `BigQueryPage` plus the
`BigQueryJobRef` triple — must plug into this contract without perturbing the
panel or `queryRunner.ts`. The mapping is: the BigQuery driver, on its first
`runQuery` call, creates the job (via `createQueryJob`), receives a `Job`
handle, awaits the first page of results, and stores **both** the `Job` and
the current `pageToken` in a UnicDB-owned `BatchedQuery` implementation;
subsequent `loadMore(index)` calls (which reach the driver via
`runner.loadMore` → `batched.fetchBatch`) call `getQueryResults` on the same
`Job` with the current token, then update the stored token — `null` token
means EOF, regardless of how many rows the last page held. The panel sees an
ordinary `BatchedQuery` and a final-page `fetchBatch` returning `null`,
exactly like the Postgres adapter today; `resultBatcher.ts` and
`resultsPanel.ts` are not touched in BQ-01. This is a paper mapping only —
no `src/` file is modified in BQ-00, and `git diff --stat` on the BQ-00
frozen-surface list (`src/adapters/bigqueryTypes.ts`,
`src/adapters/bigqueryAdc.ts`; enumerated in TASK-BQ00-004 §Target Files /
PLAN §2) stays empty.

## 12. Consequences

- BQ-01 implements against this ADR; any deviation (different version pin,
  different pagination shape, additional scalar types, additional IAM, Storage
  Read API adoption) opens a new ADR and a new round of evidence recording.
- TASK-BQ00-001/002/003 evidence (`docs/decisions/_bq00-evidence.md`,
  `src/adapters/bigqueryTypes.ts`, `src/adapters/bigqueryAdc.ts`) is the
  paper trail — any reviewer challenge must trace back to one of these.
- The "Manual ADC smoke recipe" (§9) is the only out-of-band step required
  before declaring BQ-01 ready for use against a real project; everything in §2
  through §8 is verifiable from source + this document.
- The README index gains a `0004` row pointing at this file; the existing
  "0001 genesis" roadmap note is corrected in `docs/AI_HANDOFF/PLAN.md` §3
  (handled by the planner, not by this ADR).