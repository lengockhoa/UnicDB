# Google BigQuery Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Additive roadmap only — do not modify or replace `docs/AI_HANDOFF` artifacts, including the active RLX-02 cycle.  
**Goal:** Add a safe, Application Default Credentials (ADC)-based Google BigQuery provider so a VSDB user can connect, browse BigQuery resources, run GoogleSQL, and work with result data in the existing grid as naturally as a spreadsheet.  
**Architecture:** BigQuery is a new provider boundary rather than a partial PostgreSQL imitation. It must bridge BigQuery's asynchronous, location-bound query jobs and paged result API into VSDB's existing `DbAdapter`/`QueryRunner`/`ResultsPanel` contracts without loading an entire result set into extension-host memory. The MVP is read/query/view/export only; write workflows are a later, separately approved product decision.  
**Tech Stack:** TypeScript 5.4, VS Code extension API, existing VSDB adapter/UI architecture, `@google-cloud/bigquery`, Google Application Default Credentials, Vitest, npm.

---

## 1. Human intent and non-negotiable scope

Recorded planning decisions:

- Authentication: **Application Default Credentials (ADC)** initially.
- Initial user experience: **query and view tables**, not spreadsheet-style editing: connect, select project/dataset/table, run Standard SQL, browse/paginate/copy/export results in the existing grid.
- Product goal: work with BigQuery as directly as an Excel-like data workspace while retaining BigQuery-specific cost, location, job and metadata protections.
- This is a new standalone plan. Existing cycles, especially `RLX-02`, are immutable; future BigQuery work is commissioned only after its own source-grounded handoff plan is created.

### MVP success path

1. The user authenticates outside VSDB through ADC, normally with `gcloud auth application-default login` for local development.
2. VSDB offers a BigQuery connection that stores only non-secret connection metadata: display name, billing/target project, optional location preference, and query safety settings. It never imports or stores service-account JSON, OAuth refresh tokens, or private keys in phase one.
3. Connection test clearly distinguishes missing ADC, inaccessible project, missing BigQuery API/quota/billing permissions, and a location mismatch without exposing credentials.
4. The explorer lazily lists accessible BigQuery resources: project → dataset → table/view; routines and models may be visible as non-actionable metadata nodes.
5. The user opens a table preview or runs GoogleSQL; VSDB creates/tracks a BigQuery job, renders completed data in the current Results grid, supports incremental Load More, copy, and bounded CSV/JSONL export.
6. A query has an explicit billing project and location, a configurable `maximumBytesBilled` policy, clear pending/running/cancelled/error state, and a confirmation boundary for non-read-only SQL.

## 2. Evidence and external constraints

### Current VSDB integration seams

| Seam | Relevance to BigQuery | Planning implication |
|---|---|---|
| `src/adapters/types.ts` | Defines `DbAdapter`, optional query/cursor/transaction and capability seams. | Do not force BigQuery into mutable transaction or cursor contracts before proving the job/page mapping. Add an explicit provider capability only when the existing matrix cannot express it. |
| `src/adapters/factory.ts` | Selects driver adapters. | Add BigQuery through the same factory boundary, with an exhaustive driver switch and no conditionals scattered in UI commands. |
| `src/config/types.ts`, `src/ui/connectionForm.ts`, `webview/connectionFormMain.ts` | Persist non-secret connection config and render the connection form. | Add a BigQuery-specific form section for project/location/ADC diagnostics; do not reuse host/port/user/password fields as fake BigQuery fields. |
| `src/core/connectionManager.ts` | Owns connection selection, SecretStorage behavior and adapter lifecycle. | ADC must remain external; connection lifecycle may cache a client but must not persist credentials or fabricate a password. |
| `src/ui/schemaTree.ts` | Existing database explorer model. | First prove whether it can represent Project → Dataset → Table/View without dialect leakage. Create a provider-specific tree if generic schema/table assumptions are too strong. |
| `src/core/queryRunner.ts`, `src/ui/resultsPanel.ts`, `src/core/resultBatcher.ts` | Executes statements, retains/load-more results and renders the grid. | The BigQuery bridge must retain job/result continuation context, page incrementally, and respect the future memory-budget work; it must not call an API that materializes all rows. |

### Verified BigQuery platform facts

- The official Node client is `@google-cloud/bigquery`; its normal ADC-compatible startup is `new BigQuery()` without embedding application credentials.
- Local ADC setup is distinct from normal CLI login; the user can prepare local client-library credentials with `gcloud auth application-default login`.
- BigQuery query results are paged; continuation is represented by a `pageToken`, and `jobs.getQueryResults` normally has a 20 MB response limit. VSDB must treat each result fetch as a bounded page, not a complete result set.
- BigQuery work is job based and location sensitive. The connection/profile must keep the billing project and query location explicit rather than silently retrying in another location.
- `maximumBytesBilled` can reject a query whose pre-execution estimate exceeds the configured cap. It is a guardrail, not an exact cost guarantee; estimates for clustered tables can be conservative.
- BigQuery supports resource types beyond relational tables: datasets, views, routines, models, partitioned/clustering metadata, jobs, query plans, Information Schema, and time travel. These should be delivered after the connection/query/grid foundation.

### Primary research sources

- [Google Cloud: BigQuery Node.js client](https://docs.cloud.google.com/nodejs/docs/reference/bigquery/latest)
- [Google Cloud: BigQuery authentication](https://docs.cloud.google.com/bigquery/docs/authentication)
- [Google Cloud: ADC overview](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc)
- [Google Cloud: set up ADC locally](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)
- [Google Cloud: `gcloud auth application-default login`](https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login)
- [Google Cloud: run queries](https://docs.cloud.google.com/bigquery/docs/running-queries)
- [Google Cloud: page through results](https://docs.cloud.google.com/bigquery/docs/paging-results)
- [Google Cloud: cost controls](https://docs.cloud.google.com/bigquery/docs/best-practices-costs)
- [Google Cloud: locations](https://docs.cloud.google.com/bigquery/docs/locations)
- [Google Cloud: partitioned tables](https://docs.cloud.google.com/bigquery/docs/managing-partitioned-tables)
- [Google Cloud: time travel](https://docs.cloud.google.com/bigquery/docs/time-travel)
- [Google Cloud: query execution plan](https://docs.cloud.google.com/bigquery/docs/query-plan-explanation)

Claims about the Node-client pagination method names, package version compatibility, job cancellation return shape, and exact VSDB grid continuation mapping must be validated against the package version selected in BQ-00 before production code is written.

## 3. Product boundaries and decisions

### In scope for the first released BigQuery capability

- ADC readiness diagnostics and `new BigQuery()` client construction.
- Explicit billing/target project and location selection; persisted as metadata only.
- Lazy project/dataset/table/view discovery.
- GoogleSQL query jobs, job status/cancellation, page-by-page result loading, grid view, copying and bounded local CSV/JSONL export.
- Table schema, description, row/byte metadata, partitioning and clustering metadata needed for a useful table preview.
- Cost safety: `maximumBytesBilled`, dry-run estimate before a billed query where enabled, and user-visible preflight/cancellation errors.
- Read-only default: allow ordinary `SELECT`/metadata browsing directly; use the existing danger/read-only policy only after BigQuery-specific classification is tested. Do not silently run DDL/DML/scripts in the MVP.

### Explicitly out of scope for the first release

- BigQuery data editing, cell commits, `INSERT`/`UPDATE`/`DELETE`/`MERGE`, load jobs, streaming inserts, table creation, schema migrations, scheduled queries, reservations administration, and service-account JSON import.
- Direct OAuth browser flow, stored access tokens, credential export, private-key handling, or a user-visible password field.
- BigQuery Storage Read API. Its installation, permission and result-shape consequences need a separate measured performance decision; REST/job-result paging is the baseline.
- Multi-statement scripts, child-job selection, stored-procedure calls, and query parameters beyond whatever a validated initial job API requires.
- Automatically inferring/overriding location, automatically raising a cost cap, retrying write jobs, or downloading an unbounded result set into memory.

### Required product decisions before the first implementation handoff

| Decision | Recommended initial answer | Why |
|---|---|---|
| Billing project | Required explicit connection field; default it from the first selected project only after confirmation. | A job must charge a project. Hiding this invites surprise billing. |
| Location | Connection-level preference, with an explicit per-query override only when it matches referenced data. | BigQuery jobs are location-bound; silent retries can fail or query unintended resources. |
| Cost policy | Connection has an editable `maximumBytesBilled` ceiling; blank/zero is not accepted until the user deliberately opts out. | Preserves “just run it” flow while preventing accidental unbounded scans. Exact default requires product approval. |
| Non-read-only SQL | MVP blocks it with a clear explanation; later phase can add dry-run + reviewed confirmation. | DDL/DML/scripts have job, billing, side-effect and review implications. |
| Accessible projects | Start with one configured billing project plus optional refresh/discover command; do not attempt organization-wide inventory. | Bounded permissions and predictable explorer performance. |
| Local export | CSV and JSONL only, explicit destination, incremental/cancellable, bounded by an export row/byte policy. | Preserves Excel-like workflow without copying entire warehouse results to memory. |

## 4. Phased roadmap

```text
BQ-00 feasibility contract
  └─> BQ-01 ADC connection foundation
       ├─> BQ-02 resource explorer and table preview
       └─> BQ-03 query jobs and paged grid
              └─> BQ-04 safe copy/export
                   └─> BQ-05 BigQuery-native cost/job intelligence
                        ├─> BQ-06 partition/cluster/time-travel workspace
                        └─> BQ-07 scripts, routines, models and query plan
```

### BQ-00 — Provider feasibility and contract spike

**Priority:** P0. This is a mandatory planning/measurement cycle, not an end-user feature release.

**Objective:** Prove the selected `@google-cloud/bigquery` version works in the VS Code extension bundle and map its job/page APIs into a minimal VSDB adapter without modifying existing drivers.

**Candidate files:**
- `package.json`, `package-lock.json`
- `src/adapters/types.ts` only if the spike proves an adapter interface gap
- `src/adapters/bigqueryTypes.ts` (new, pure boundary types)
- `src/adapters/__tests__/bigqueryTypes.test.ts` (new)
- `docs/decisions/` (new ADR only if that folder convention is approved)

**Task breakdown:**

| Wave | Task | Target files | RED-first / measurement proof |
|---|---|---|---|
| 1 | BQ-00.1 package and bundle proof | `package.json`, lockfile, package/bundle test | Package installation neither leaks credentials nor leaves unsupported Node/bundle dependencies. Build the extension and load the BigQuery client from a test seam. |
| 1 | BQ-00.2 pure job-page contract | new `bigqueryTypes.ts`, focused test | Model `BigQueryJobRef`, `BigQueryPage`, schema fields, location, total bytes and next-page token. Test empty page, token continuation, nested/repeated values, `NUMERIC`/`BIGNUMERIC` precision preservation. |
| 2 | BQ-00.3 controlled ADC smoke | isolated non-secret test/manual recipe | With no ADC, return actionable diagnostic only; with a test project and ADC, `new BigQuery()` can list/inspect one allowed resource. Never record environment values or tokens. |
| 2 | BQ-00.4 ADR/contract | decision document | Decide client method/version, continuation ownership, cancellation mapping, safe scalar conversion, selected config fields, required IAM, and Storage Read API deferral. |

**Acceptance:**
- [ ] Package/version/bundle behavior is proved in CI-compatible build conditions.
- [ ] The adapter contract explicitly says who owns job IDs/page tokens and how nested and precision-sensitive values display.
- [ ] Missing ADC, bad billing project, denied API, and wrong location are distinguishable without secrets.
- [ ] No existing driver type or UI is changed unless a test demonstrates the need.

**Verification:** focused Vitest, `npm run typecheck`, `npm run compile`, package smoke; controlled integration only against a disposable/test project.

### BQ-01 — ADC connection and BigQuery adapter foundation

**Priority:** P0. Depends on BQ-00.

**Objective:** Let a user add, select, test and safely remove a BigQuery connection using ADC, an explicit billing project and location preference.

**Candidate files:**
- `src/config/types.ts`
- `src/adapters/factory.ts`
- `src/adapters/types.ts`
- `src/adapters/bigquery.ts` (new)
- `src/core/connectionManager.ts`
- `src/ui/connectionForm.ts`, `src/ui/connectionFormMessages.ts`
- `webview/connectionFormMain.ts`
- `package.json` if a driver-specific setting or command is required
- new focused adapter/form/manager tests, selected only after index refresh

**Task breakdown:**

| Wave | Task | Target files | Required tests |
|---|---|---|---|
| 1 | BQ-01.1 safe connection config | `config/types.ts`; pure config test | Valid `driver: "bigquery"` requires non-empty billing project and validates optional location/cost fields; rejects host/port/password fields for BigQuery; serialization contains no credential path/token. |
| 1 | BQ-01.2 adapter/client lifecycle | `bigquery.ts`; adapter test | No-ADC diagnostic, successful injected-client test, explicit project/location propagation, idempotent close, safe scalar/schema normalization. |
| 2 | BQ-01.3 factory/manager admission | `factory.ts`, `connectionManager.ts`; focused tests | Factory exhaustiveness; active BigQuery connection never asks SecretStorage for a fake password; dispose prevents later adapter use. |
| 2 | BQ-01.4 form and diagnostics | connection form files; webview/form tests | Project/location/cost fields render only for BigQuery; ADC instructions are copy-safe; invalid project/empty location state cannot silently submit. |

**Important edge cases:** no ADC; ADC belongs to a user without job permission; billing project differs from data project; API disabled/quota project required; configured region conflicts with dataset region; user changes active connection during test.

**Acceptance:**
- [ ] A connection created through the UI uses ADC externally and persists only safe metadata.
- [ ] Connection test names the failing class and remediation, including `gcloud auth application-default login` only where appropriate.
- [ ] Existing PostgreSQL/MySQL/MSSQL form behavior and SecretStorage tests remain unchanged.
- [ ] Manual smoke covers Windows/macOS/Linux environments supported by VSDB with a restricted test project.

### BQ-02 — BigQuery explorer and table preview

**Priority:** P0. Depends on BQ-01.

**Objective:** Make BigQuery discoverable without pretending it is a traditional schema: lazy project → dataset → table/view navigation plus a safe preview of schema and BigQuery metadata.

**Candidate files:**
- `src/adapters/bigquery.ts`
- `src/ui/schemaTree.ts` **or** `src/ui/bigQueryTree.ts` (new, choose after BQ-00 contract)
- `src/ui/ddlView.ts` only if it can safely host read-only metadata
- `src/extension.ts` only for provider registration
- focused explorer/adapter tests

**Task breakdown:**

| Wave | Task | Target files | Required tests |
|---|---|---|---|
| 1 | BQ-02.1 resource metadata adapter | `bigquery.ts`; adapter test | Lazy datasets/tables/views; pagination or limit; inaccessible dataset is represented as an actionable error, not empty data; resource location is preserved. |
| 1 | BQ-02.2 pure metadata formatter | new pure module/test if needed | Nested RECORD fields, repeated mode, descriptions, partition field/type, clustering fields, created/modified time and logical/physical byte metadata are represented without BigInt precision loss. |
| 2 | BQ-02.3 explorer provider | new tree or isolated schema-tree slice; tree tests | Expand project/dataset lazily; refresh invalidates only target node; table and view commands are distinct; routine/model nodes remain visible but non-editable or are deliberately deferred. |
| 3 | BQ-02.4 table preview command | isolated panel/extension files; tests | Preview produces bounded `SELECT` using a safely quoted table reference and location; denied/partition-required tables do not issue an unconstrained full scan. |

**BigQuery-specific acceptance:**
- [ ] The tree does not label BigQuery datasets as PostgreSQL schemas where that would imply unsupported behavior.
- [ ] Partition and clustering information appears before users run a broad preview.
- [ ] Views are not assumed to have table storage metadata; models/routines are never passed to table browsing commands.
- [ ] Table preview has an explicit low row cap and respects the billing/cost policy.

### BQ-03 — GoogleSQL jobs, cancellation and paged Results grid

**Priority:** P0. Depends on BQ-01 and BQ-02; coordinate only after RLX-02 has shipped because it touches shared query lifecycle concepts.

**Objective:** Run one GoogleSQL statement as a BigQuery job and render it in VSDB Results without losing job identity, query location, cancellation status or page continuation.

**Candidate files:**
- `src/adapters/bigquery.ts`
- `src/adapters/types.ts` only if BQ-00 proves a continuation capability is required
- `src/core/queryRunner.ts`
- `src/core/resultBatcher.ts`
- `src/ui/resultsPanel.ts`
- `src/extension.ts`
- focused adapter/runner/panel tests

**Task breakdown:**

| Wave | Task | Target files | Required tests |
|---|---|---|---|
| 1 | BQ-03.1 job state machine | `bigquery.ts`; adapter test | Pending→running→done; job error; cancellation request; cancel after completion is harmless; project/location/job ID retained. |
| 1 | BQ-03.2 result page bridge | pure adapter helper/test | Empty result; first page; page token; final page; 20 MB-aware bounded page; values with nested/repeated/JSON/bytes/temporal/large decimal types preserve display semantics. |
| 2 | BQ-03.3 runner continuation contract | `queryRunner.ts`; runner test | Load More consumes only current job's token, prevents concurrent duplicate fetch, ignores late page after cancel/new run, releases retained job context once exhausted/disposed. |
| 2 | BQ-03.4 panel state | `resultsPanel.ts`; panel test | Pending/running/cancelled/limited/error states are distinct; Load More only when token exists; new connection/run cannot display a prior BigQuery page. |
| 3 | BQ-03.5 command integration | `extension.ts`; extension test | GoogleSQL is selected for BigQuery; legacy SQL is never silently chosen; result header shows data project, billing project, location and job link/ID in a copy-safe form. |

**MVP SQL policy:**

- Submit a single GoogleSQL statement only.
- Allow a tested read-only subset directly.
- Reject multi-statement scripts and uncertain/non-read-only statements with a precise “not in BigQuery MVP” message, not a generic parser error.
- Do not reuse a relational transaction abstraction. BigQuery job cancellation is a job operation, not rollback.

**Acceptance:**
- [ ] A large result can be loaded page by page with no all-result accumulation.
- [ ] Cancellation targets only the active BigQuery job and cannot cancel a later query.
- [ ] Job errors preserve Google category/location context while removing raw credentials and sensitive SQL from logs/UI.
- [ ] Manual: run a small query, a large paged query, a cancelled long query, a location mismatch, a denied query, and a non-read-only statement.

### BQ-04 — Spreadsheet-like copy and bounded local export

**Priority:** P1. Depends on BQ-03 and the retained-result memory budget direction.

**Objective:** Turn the grid into a useful analyst workspace without turning VSDB into an unbounded warehouse downloader.

**Candidate files:**
- `src/ui/resultsPanel.ts`
- `src/core/bigqueryExport.ts` (new)
- `src/core/resultBatcher.ts` only if shared retention cap requires it
- `webview/main.ts`
- `src/extension.ts` only for file destination/command wiring
- new export/panel/webview tests

**Task breakdown:**

| Wave | Task | Target files | Required tests |
|---|---|---|---|
| 1 | BQ-04.1 pure serializer | new export module/test | CSV quoting/newlines/nulls; JSONL nested/repeated values; decimal/string preservation; header order; no formula-like spreadsheet coercion. |
| 1 | BQ-04.2 incremental export controller | export module/test | Starts from job/page reference, writes batches progressively, stops at cap/cancel/error, closes file handle exactly once, never buffers all pages. |
| 2 | BQ-04.3 grid copy/export UX | panel/webview tests | Copy selected/visible rows remains bounded; export clearly indicates row/byte cap, progress and cancellation; no “all rows exported” claim when limited. |
| 3 | BQ-04.4 host file handoff | extension test | Native save dialog/path validation; cancel leaves no completed-looking file; output path and data are never sent to AI trace/diagnostics. |

**Acceptance:**
- [ ] CSV and JSONL exports are incremental, cancellable and bounded.
- [ ] Copy/export supports BigQuery nested data predictably; raw values remain available as valid JSON in JSONL.
- [ ] No cloud-storage export job, DML, or unbounded local materialization is introduced.
- [ ] Manual: export data with commas/newlines, nested RECORD, repeated fields, bytes, nulls and a cancellation mid-export.

### BQ-05 — BigQuery query preflight, cost and job intelligence

**Priority:** P1. Depends on BQ-03.

**Objective:** Make BigQuery's cost/job model visible before it becomes an expensive surprise.

**Candidate files:**
- `src/adapters/bigquery.ts`
- `src/core/bigqueryCostPolicy.ts` (new)
- `src/ui/bigqueryQueryPreflight.ts` (new) or an isolated existing confirmation seam
- `src/extension.ts`
- focused policy/adapter/UI tests

**Task breakdown:**

| Wave | Task | Target files | Required tests |
|---|---|---|---|
| 1 | BQ-05.1 pure cost policy | new module/test | Missing cap requires explicit policy outcome; estimate below/equal/above cap; unknown estimate; cached result; conservative clustered-table estimate messaging. |
| 1 | BQ-05.2 dry-run adapter | `bigquery.ts`; adapter test | Dry run has no billed execution; project/location/labels propagate; permission/location failures do not fall back to live run. |
| 2 | BQ-05.3 preflight UI | new isolated UI module/test | Shows estimated bytes and cap without claiming an exact price; cancel/deny creates no job; approved execution uses the exact reviewed policy. |
| 2 | BQ-05.4 job details | adapter/panel test | Job ID, creation time, billed/processed bytes when available, cache hit and cancelled/error state are shown as post-run facts. |

**Acceptance:**
- [ ] A query above configured `maximumBytesBilled` cannot become a billed job.
- [ ] Estimate uncertainty/cached-result qualifications are visible.
- [ ] No price/currency is invented from bytes; cost estimation requires a separately approved pricing source.
- [ ] Required review: BigQuery IAM/cost review plus test project billing verification.

### BQ-06 — Partition, clustering and time-travel workspace

**Priority:** P2. Depends on BQ-02 and BQ-05.

**Objective:** Deliver features that are meaningfully BigQuery-specific for analysts, rather than generic database widgets.

**Candidate files:**
- `src/adapters/bigquery.ts`
- `src/ui/bigqueryTableInsights.ts` (new)
- `src/ui/schemaTree.ts` or BigQuery tree module
- `src/core/bigquerySql.ts` (new, pure safe reference builder)
- focused adapter/formatter/tree tests

**Features/tasks:**

1. **Partition and clustering inspector:** show partition type/field, clustering columns, required partition filter signal when available, storage bytes and row/modified metadata.
2. **Partition-aware preview builder:** construct a bounded, quoted preview that asks users to provide a partition predicate where policy requires it; never invent a filter that changes analysis semantics.
3. **Time-travel query composer:** create a preview/copy-only GoogleSQL `FOR SYSTEM_TIME AS OF` form with an explicit timestamp and retention caveat; no destructive restore/clone operation.
4. **Storage/metadata comparison:** show metadata change and partition summaries only; defer table data diff/restore.

**Acceptance:**
- [ ] Partition/clustering metadata survives nested schema and missing-field cases.
- [ ] Time-travel is copy/preview only and preserves location/project/cost policy.
- [ ] No generic “index” or PostgreSQL DDL UI leaks into BigQuery resource views.

### BQ-07 — Scripts, routines, models, query plan and operational workspace

**Priority:** P2/P3. Depends on BQ-03 and BQ-05. Commission as separate subcycles, not one release.

| Subcycle | BigQuery-specific value | Required safety gate |
|---|---|---|
| BQ-07a scripts/child jobs | Render multi-statement script parent/child jobs and eligible result sets. | Explicit script classification, job lineage tests, DDL/DML confirmation policy and cancellation semantics. |
| BQ-07b routines/models | Explorer/metadata/definition view for routines and BigQuery ML models. | Read-only metadata first; no routine invocation/model training in initial release. |
| BQ-07c query plan/INFORMATION_SCHEMA | Show query stages, slot/bytes metrics and job history for a selected job. | Avoid org-wide discovery; permission errors are actionable; no raw query/credential diagnostics. |
| BQ-07d labels/governance | Attach user-approved job labels, saved read-only query profiles and audit-friendly connection policy. | Privacy review; labels never include raw SQL, data values, credential or workspace paths. |
| BQ-07e Storage Read API evaluation | Measure whether Storage Read API improves large-grid performance enough to justify new API/IAM/dependency surface. | Benchmark with representative data, fallback REST paging, no silent enablement. |

## 5. BigQuery result type and spreadsheet-view contract

The grid must not implicitly coerce BigQuery types into lossy JavaScript values.

| BigQuery class | MVP rendering rule |
|---|---|
| `INT64`, `NUMERIC`, `BIGNUMERIC` | Preserve canonical string form for display/copy/export unless a proven safe integer/decimal formatter is used. Never round through JavaScript `number`. |
| `FLOAT64` | Preserve `NaN`, `Infinity` and precision behavior explicitly; do not serialize non-finite values as normal JSON numbers. |
| `BOOL`, `DATE`, `DATETIME`, `TIME`, `TIMESTAMP` | Display normalized text with type metadata retained; do not silently reinterpret time zone. |
| `BYTES` | Bounded base64/text-safe display; copy/export preserves unambiguous encoded representation. |
| `GEOGRAPHY` | Text representation only in MVP; map rendering is a separate feature. |
| `JSON` | Display bounded JSON; JSONL export preserves structured value. |
| `RECORD`/`STRUCT`, repeated fields | Compact cell preview with an inspect/copy JSON representation; do not flatten ambiguously for CSV. |
| `NULL` | Preserve null separately from empty string and missing field. |

Every type rule requires one happy test and two distinct edge tests: null/empty, nested/repeated, precision/boundary, or serialization failure.

## 6. IAM, security and privacy checklist

Before connection testing, document the customer's required permissions for the selected billing project and datasets. The final matrix must be verified against the organization's IAM design and current Google documentation; do not hard-code an over-broad role as a convenience.

Minimum design principles:

- ADC identity is external to VSDB; VSDB reads no JSON key file and stores no bearer token.
- Separate ability to create/query jobs in the billing project from ability to read dataset metadata/data.
- Use a least-privilege test project/dataset for integration tests.
- Keep project IDs, job IDs, locations and error categories useful but redact Authorization headers, environment paths, ADC source details, raw SQL and result cells from diagnostics by default.
- Treat `maximumBytesBilled` and dry run as cost controls, not authorization controls.
- Use BigQuery's job cancellation API only with an owned active job ID; cancellation after terminal state is harmless; never cancel by guessed job ID.
- Do not introduce write jobs until a separate reviewed policy covers DML/DDL/scripts, confirmation, audit, retries and partial failure.

## 7. Test and review plan

### Required test layers

| Layer | Required evidence |
|---|---|
| Pure unit | Config validation, SQL/reference formatting, page-token state, type normalization, cost policy, export serialization. |
| Adapter contract | Injected fake BigQuery client covering ADC failure classes, resource paging, job lifecycle, result pages, cancellation, nested values, location/cost propagation. |
| Runner/panel contract | Deferred promises prove no stale page after cancel/switch/dispose, one Load More at a time, and bounded retained/export state. |
| Controlled integration | A restricted BigQuery project proves ADC, one dataset/table/view, dry-run, a small query, pagination, cancellation and location behavior. Mark unavailable integration as skipped with an explicit reason; never fake its pass. |
| Manual VS Code smoke | Add/edit/test BigQuery connection; explorer expand/refresh; table preview; small/large/cancelled query; denied/cost-capped/location mismatch; grid copy/export and reopen. |
| Security/cost review | ADC/SecretStorage audit; IAM least privilege; no key/token logging; cost-cap and non-read-only behavior; job cancellation ownership. |

### Per-task commands

```bash
# First resolve exact focused tests through .cache/index/tests-map.json.
npx vitest run <BigQuery-task-focused-test-files>
npm run typecheck
npm run compile

# Cycle/release boundary
npm test
npm run typecheck
npm run compile

# Controlled credentials and billed test project only
npm run test:integration
npm run package -- --no-dependencies
```

No `lint` command currently exists; do not invent one. Integration tests must never default to a developer's production project. Package/release commands run only after focused and full verification is green.

### Independent review gates

1. **BQ-00:** dependency/bundle and ADC design review.
2. **BQ-01/BQ-02:** security review for credentials/config persistence plus architecture review for tree abstraction.
3. **BQ-03/BQ-04:** concurrency and memory review; reviewer traces job/page/cancel/late-settlement timelines.
4. **BQ-05 onward:** BigQuery cost/IAM review, redaction review and controlled-project manual verification.
5. Every executable task follows RED → GREEN and is independently reviewed by a model different from the executor, with fresh verification evidence.

## 8. Production-quality test, security and release gate

The BigQuery provider is not ready to sell, publish, or enable by default merely because unit tests pass. Every release candidate must meet the following evidence gates. A missing credential, unavailable test project, or unavailable paid service is a **blocked release signal**, not a reason to weaken or skip the relevant test.

### 8.1 Test suite layout and fixture rules

| Suite | Candidate path / runner | Uses real Google Cloud? | Required purpose |
|---|---|---:|---|
| Pure value/policy tests | `src/adapters/__tests__/bigqueryTypes.test.ts`, `src/core/__tests__/bigqueryCostPolicy.test.ts`, `src/core/__tests__/bigqueryExport.test.ts` | No | Values, lossless type conversion, location/reference validation, cost-policy and CSV/JSONL serialization. |
| Fake-client contract tests | `src/adapters/__tests__/bigquery.test.ts` plus `src/adapters/__tests__/bigqueryFixtures.ts` | No | The fake mirrors only documented BigQuery job/dataset/table/page/cancel responses. It exercises every provider branch deterministically. |
| Lifecycle/race tests | `src/core/__tests__/queryRunner.test.ts`, `src/ui/__tests__/resultsPanel.test.ts` | No | Deferred job/page promises prove cancel/switch/dispose/error interleavings without timing sleeps. |
| Webview behavior tests | Existing results/webview suite, plus new focused test only after confirming convention | No | Grid loading, limited/export/cancel state, accessible messaging and no raw SQL/credential display. |
| Packaged extension smoke | Existing extension/package harness and installed `.vsix` test profile | No for package structure; controlled project for optional live smoke | Extension activation, package contents, dependency bundling, command registration and no prohibited fixtures/credentials inside the VSIX. |
| Controlled BigQuery integration | `src/adapters/__tests__/bigquery.integration.test.ts` using a distinct Vitest config if required | Yes — dedicated non-production project only | ADC, least-privilege IAM, dataset metadata, Standard SQL job, pagination, dry run, cap rejection, cancellation and location error behavior. |
| Release manual matrix | Recorded release checklist, no ad-hoc personal project runs | Yes — dedicated test project only | Real VS Code interaction across supported OS targets and user-facing failure/recovery flows. |

Fixture requirements:

- Fake jobs must have a unique `projectId`, `location`, `jobId`, state, page token and schema. A mock with only `{ rows: [] }` is prohibited because it cannot prove job ownership or pagination behavior.
- Fixtures must include scalar and structural data: `INT64` above `Number.MAX_SAFE_INTEGER`, positive/negative `NUMERIC` and `BIGNUMERIC`, `FLOAT64` non-finite values, timestamp/date/datetime/time, `BYTES`, `JSON`, null, empty string, nested `RECORD`, repeated fields and a row with CSV-special characters.
- Test-only project/dataset IDs come only from a dedicated test configuration. Reject values matching known production project allow/deny patterns before a test creates a job. Do not accept an arbitrary shell project as a fallback.
- Real integration test fixtures are unique per run with a run nonce, contain synthetic non-sensitive data only, apply a hard bytes cap and are deleted in `afterAll` even when assertions fail. A separate janitor policy covers stranded fixtures.
- No test prints an ADC environment variable, credential file path, Authorization header, raw production SQL, result-cell payload or export file content to snapshots/logs.

### 8.2 Mandatory test matrix

Every listed case starts RED before implementation. Each row needs a named focused test; high-risk rows also require controlled integration evidence.

| Area | Happy path | Safety / adversarial edge cases | Required outcome |
|---|---|---|---|
| ADC and connection | Valid test ADC opens a no-argument client and reads approved metadata. | Missing ADC; malformed credential source; credentials for identity without job permission; API disabled; quota/billing error; no secret leaked in diagnostics. | Typed/actionable error category, no stored credential and no fake password prompt. |
| Config persistence | Add/reopen BigQuery connection keeps billing project/location/cap metadata. | Reject empty/invalid project; unsupported host/port/user/password fields; corrupted stored config; switching from BigQuery to a SQL connection. | Safe metadata only; existing drivers unchanged. |
| Resource explorer | Lazy project → dataset → table/view expansion and refresh. | Permission-denied child; empty dataset; pagination; stale response after connection switch; routine/model sent to table action. | Bounded calls; exact resource-kind behavior; stale work cannot mutate active tree. |
| GoogleSQL admission | One valid read-only Standard SQL statement submits with target/billing project, location and cap. | Legacy SQL option attempt; multiple statements; writable CTE; DDL/DML/script; unknown syntax; query location mismatch. | Only tested MVP subset starts a job; denied work has no job ID or billed execution. |
| Jobs and cancellation | Pending → running → done renders first page; owned active job cancels. | Cancel before job ID; cancel twice; cancel after terminal state; cancel then immediately start another query; backend cancel permission denied. | Exactly-once owned cancel; later job untouched; terminal/late response cannot overwrite UI. |
| Paging and memory | First page then continuation page produces stable visible order. | Empty first page + token; duplicate token; token loop; page fetch concurrent with cancel/switch/dispose; 20 MB-shaped page; maximum retained rows/bytes. | One in-flight page; bounded memory; cursor/job context released; explicit limited state. |
| BigQuery values | Display/copy/export all supported scalars and nested values. | Precision overflow; null versus empty; invalid UTF-8/bytes; non-finite float; deep nesting; huge cell; malformed API field. | No silent numeric rounding, crash, XSS or ambiguous CSV value. |
| Cost preflight | Dry run/estimate below cap can proceed after approval. | Estimate above/equal cap; estimate unavailable; conservative clustered estimate; cached result; policy changed while confirmation is open. | Above-cap does not create live job; no currency claim; approval binds exact reviewed policy. |
| Export | Bounded CSV and JSONL writes progressively and completes. | Destination cancel; write failure; cancel mid-page; quote/newline/formula-like values; nested record; cap reached; repeated export request. | No all-result buffer; atomic/clearly partial output; no execution/result data in diagnostics. |
| Redaction | Useful job category/state/location appears in local diagnostics. | Token-like strings, Authorization/Bearer patterns, ADC path, raw SQL, PII-shaped cells, export path. | Sensitive values never appear in output channel, traces, thrown message, snapshot or release log. |
| Packaging/activation | Packaged VSIX activates with BigQuery capability absent/present according to build. | Package contains `.env`, key JSON, test fixtures, `.gcloud`, source maps or unbundled credential paths; dependency load failure. | Package audit fails closed; missing optional environment yields user guidance, not activation crash. |

### 8.3 Controlled integration environment

The production-quality integration lane requires a separately administered Google Cloud test environment. Before enabling it, record exact identifiers only in protected CI/secret configuration, never in this repository or release artifact.

1. Create a **dedicated test billing project** with a budget alert and a deliberately small per-query bytes policy. It must not contain customer, employee, staging or production data.
2. Create one controlled dataset in an approved location and seed synthetic tables for: flat rows, nested/repeated values, partitioned table, clustered table, view, empty table, denied dataset/resource and a slow/cancellable query fixture.
3. Grant the CI identity and approved release tester only the least privileges verified necessary to enumerate the fixture, create/query/cancel jobs in the test billing project and read selected data. Do not grant owner/editor broadly as a shortcut.
4. Test config fails before any API call unless `VSDB_BIGQUERY_TEST_PROJECT`, fixture dataset, location and an explicit `VSDB_BIGQUERY_INTEGRATION=1` opt-in are all present. It must reject project IDs that are not in a protected approved-test allowlist.
5. Run integration serially or with unique labels/run IDs so cleanup can identify only its own jobs/tables. Apply `maximumBytesBilled` to every billed test and dry-run before expensive query cases.
6. The suite polls only within bounded deadlines and reports timeout as a failure with redacted job metadata. It never retries a DDL/DML or query automatically.
7. `afterAll` deletes only run-owned temporary fixtures. A scheduled/operational janitor separately deletes labelled stale fixtures; release is blocked when cleanup cannot be confirmed.

### 8.4 Security review checklist

A reviewer must independently verify these items against source, package contents and fresh test results before every BigQuery production release:

- [ ] ADC is obtained only by the official client-library chain; VSDB never parses/stores service-account JSON, refresh tokens, access tokens or passwords for BigQuery.
- [ ] Connection state, Memento/global storage, diagnostics, trace, telemetry-like data, exports and test snapshots contain no credential material.
- [ ] Billing project, target project and location have explicit user-visible values and cannot be silently substituted after review/preflight.
- [ ] Project/table identifiers are sent through documented client parameters or a proven quote/validation builder; no string interpolation can inject arbitrary job configuration.
- [ ] Job cancel maps to an actively owned job ID in its original project/location only. Unknown/terminal IDs do not trigger broad cancellation.
- [ ] Default SQL admission is fail closed for multi-statement, DDL/DML/scripts and parsing uncertainty until a later approved feature changes that policy.
- [ ] `maximumBytesBilled` is applied to live jobs; dry runs cannot silently become live jobs; above-cap rejection has a regression test.
- [ ] Export is local, bounded, cancellable and free of cloud-write side effects; formula-like CSV cells are encoded according to the approved spreadsheet-safety policy.
- [ ] Source/package audit confirms no Google credential, `.env`, service-account artifact, protected project identifier or integration fixture leaks into the VSIX.
- [ ] Supply-chain review pins the selected Google client version through the lockfile, reviews its license/dependency footprint and runs the package/bundle test.

### 8.5 Release candidate command gate

The exact focused file list is resolved from the fresh index when each cycle is commissioned. The following is the minimum release sequence; every command must return exit code zero and its concise evidence is retained in the handoff/release record.

```bash
# 1. Focused RED/GREEN evidence is captured per task before this release gate.
npx vitest run <all-bigquery-unit-contract-and-lifecycle-tests>

# 2. Static/build checks.
npm run typecheck
npm run compile

# 3. Entire regression suite.
npm test

# 4. Isolated, explicitly opted-in GCP test lane only.
VSDB_BIGQUERY_INTEGRATION=1 npm run test:integration

# 5. Produce the candidate package only after all preceding checks pass.
npm run package -- --no-dependencies

# 6. Audit the actual VSIX archive for credentials and expected bundles.
unzip -l dist/*.vsix
```

The final package-audit task must use a committed, portable checker rather than trusting a human scan. It fails on private-key headers, Google service-account JSON markers, `.env` files, `application_default_credentials.json`, test fixture datasets, and unapproved source/test artifacts. It also asserts the required production bundle/dependency files exist.

### 8.6 Manual release matrix and operational readiness

| Scenario | Expected production behavior | Release evidence |
|---|---|---|
| First use without ADC | Clear local setup guidance; no crash, secret prompt or saved broken credential. | Screen recording or repeatable smoke notes on each supported OS. |
| Valid least-privilege ADC | Connect/test/browse/query works only for allowed project/dataset. | Controlled-project run with redacted job ID and location. |
| Billing project/location mistake | Actionable error names the safe field to correct; VSDB does not retry elsewhere. | Negative integration test plus manual check. |
| Cost cap rejection | No billed live job; user sees estimate/cap outcome and can adjust policy deliberately. | Dry-run/live-policy test and billing-project audit evidence. |
| Large result/export | UI remains responsive; Load More/export is bounded and cancellable. | Controlled large synthetic fixture and memory/late-cancel test. |
| Network/process interruption | Terminal state is surfaced; no stale result appears after reconnect/switch/reopen. | Fault-injection contract test and manual smoke. |
| Package installed fresh | BigQuery optional path works or explains prerequisites; ordinary drivers retain behavior. | Fresh VS Code profile / installed VSIX smoke. |
| Support incident | Redacted diagnostics can identify provider/job/location category without customer data or secrets. | Reviewer examines output produced from synthetic failure. |

Release artifacts required before market delivery:

- versioned VSIX and checksum;
- release notes listing ADC setup, supported scope, known limitations, IAM/cost guidance and rollback path;
- SBOM/dependency inventory if the organization requires it, plus lockfile/package audit evidence;
- test report for focused, full, integration and package stages;
- security/cost/IAM review sign-off and manual matrix sign-off;
- customer-facing support runbook: ADC troubleshooting, permission vs billing vs location diagnosis, cost-cap explanation, export limitations and how to collect redacted diagnostics.

### 8.7 Rollback and support policy

- BigQuery support ships behind an explicit extension setting/capability admission until at least one release cycle has stable field evidence.
- Disabling BigQuery prevents new jobs immediately; it does not delete existing user connection metadata unless the user requests removal.
- If a release defect can submit unexpected jobs, the emergency mitigation is to disable the provider command/admission in the next patch and publish a customer notice; do not rely on a silent server-side toggle that does not exist.
- Do not promise zero cost. Communicate that dry run and `maximumBytesBilled` reduce accidental spend but users remain responsible for approved live jobs and their cloud billing configuration.
- Support requests accept only redacted diagnostics, extension version, OS, configured region class and non-sensitive job/error category. Never ask customers to paste ADC files, private keys, bearer tokens or raw sensitive query results.

## 9. Commissioning instructions for future executors

1. Do **not** convert this document directly into changes while RLX-02 is active or while its target files are unsettled.
2. When BQ-00 is commissioned, make a new handoff cycle instead of overwriting any existing `docs/AI_HANDOFF` task/plan. Copy only the relevant BQ-00 task boundaries after refreshing the index and validating current paths.
3. Reconfirm package version, Node/bundler compatibility, the exact Google Node API methods, IAM requirements and current Google documentation before locking task file contracts.
4. Keep one BigQuery release slice narrow. BQ-01 through BQ-04 can be separate releases if the adapter/grid contract reveals risk.
5. Same-wave tasks must not modify the same file. If `src/adapters/types.ts`, `src/core/queryRunner.ts`, `src/ui/resultsPanel.ts`, or `src/extension.ts` are shared, sequence them explicitly rather than parallelizing them.
6. If any experiment disproves a premise (for example, the existing grid cannot retain an opaque page continuation safely), stop and revise the roadmap before coding around it.

## 9. Deferred ideas and why

| Deferred idea | Reason |
|---|---|
| Direct spreadsheet cell editing | BigQuery DML is job/cost/side-effect based, not a transactional grid commit. It needs a separate approval/audit/partition/concurrency design. |
| Service-account JSON and browser OAuth | User selected ADC first; credential import/token storage increases secret and support surface. |
| BigQuery Storage Read API | Useful potentially, but adds API/IAM/dependency/performance complexity before REST paging is proven insufficient. |
| Organization-wide project discovery | Could be slow, permission-heavy and confusing; start with explicit billing project and bounded discovery. |
| Automatic cost calculation in currency | Bytes processed is not a reliable personalized price quote; use caps/estimates only unless pricing source and region model are separately approved. |
| Automatic retry of jobs | Unsafe for DML/DDL/scripts and can conceal cost/partial-execution effects. |
| Saved queries and scheduled queries | Valuable but require privacy, workspace persistence, job labels and governance decisions after core query flow. |
| Data transfer/load/export to GCS | Changes data movement and permission model; local bounded export is sufficient for the Excel-like MVP. |

## Planning self-review

- [x] Creates a new standalone BigQuery roadmap only; does not modify RLX-02 or historical handoffs.
- [x] Prioritizes ADC connection and Excel-like query/view/paging/copy/export before BigQuery breadth.
- [x] Keeps BigQuery-native concepts explicit: billing project, location, asynchronous jobs, page tokens, dry runs, bytes caps, partitions/clustering, time travel, query plan and models/routines.
- [x] Separates confirmed platform constraints from Node-client/VSDB integration experiments.
- [x] Names candidate implementation and test files, task waves, acceptance checks, review gates and real verification commands.
- [x] Defers edit/DML and credential import until independently planned and reviewed.
