# TASK-BQ01-002 — BigQuery adapter / client lifecycle (`bigquery.ts`)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Adapter)

## Goal

New `BigQueryAdapter implements DbAdapter` that connects through BQ-00's injectable
`createBigQueryClient` seam, maps ADC failures to the typed diagnostic, propagates the
configured billing project + location, closes idempotently, and normalizes results via
BQ-00's `toBigQueryPage` without breaking branded-string precision.

## Target Files

- `src/adapters/bigquery.ts` (new) — `BigQueryAdapter`, `BigQueryConnectError`. Imports
  `createBigQueryClient`, `runAdcSmoke`, `AdcDiagnostic`, `BigQueryClientLike` from
  `./bigqueryAdc` and `toBigQueryPage` + page types from `./bigqueryTypes`. Implements
  `DbAdapter` from `./types`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | connect with injected fake client resolves and propagates project | `connect()` resolves; injected impl called once with `{projectId:"proj-billing"}`; smoke "ok" | fake `BigQueryClientLike` via `vi.fn` impl (mirror `bigqueryAdc.test.ts` #1) |
| 2 | edge-diag | no-ADC failure → typed diagnostic | fake smoke throwing `Error("Could not load the default credentials.")` makes `connect()` reject `BigQueryConnectError` with `diagnostic.category==="missing_adc"` and remediation matching `/gcloud auth application-default login/`; raw message NOT carried on the error object | impl returning rejecting fake |
| 3 | edge-lifecycle | idempotent close | `await a.close(); await a.close();` both resolve; factory impl still called exactly once (no rebuild); subsequent `connect()` after close throws explicit closed-error | connected adapter |
| 4 | edge-propagation | explicit location propagation | cfg `bigquery.location:"EU"` → impl observed opts include location `"EU"` alongside projectId | fake impl recording opts |
| 5 | edge-normalization | branded strings survive normalization | fake page (`jobReference`+`schema`+`rows` with cell `"9007199254740993"`) through the adapter's result path keeps the cell a `string` (`typeof === "string"`), rowCount/pageToken mapped via `toBigQueryPage` semantics | fixture shaped like `bigqueryTypes.test.ts` raw responses |
| 6 | edge-concurrent | runQuery after close | rejects with the explicit closed-error (does not construct a client) | closed adapter |

## Test Files

- `src/adapters/__tests__/bigquery.test.ts` (new) — contains tests #1-#6. All client
  I/O via injected fakes; zero real GCP calls; no network dependency.

## Verification Commands

```bash
# 1. Focused proof
npx vitest run src/adapters/__tests__/bigquery.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED output pasted in Executor Report first).
- [ ] Adapter imports BQ-00 modules as-is — `bigqueryAdc.ts` / `bigqueryAdc.test.ts`
      / `bigqueryTypes.ts` byte-untouched (check via `git status`).
- [ ] No direct `new BigQuery(` outside the default factory parameter; no
      `@google-cloud/bigquery` mock plumbing in tests (seam only).
- [ ] INT64/NUMERIC/BIGNUMERIC cells remain strings end-to-end in the adapter result
      path (branded discipline).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ01-001 (imports `validateBigQueryConnection` usage target + `BigQueryConnectionFields`
  from `src/config/types.ts`; constructor asserts `validateBigQueryConnection(cfg).ok`).

## Interfaces

- Consumes (BQ-00, exact):

```ts
import { createBigQueryClient, runAdcSmoke, type BigQueryClientLike, type AdcDiagnostic } from "./bigqueryAdc";
import { toBigQueryPage, type BigQueryPage } from "./bigqueryTypes";
```

- Produces (consumed by TASK-BQ01-003):

```ts
// Adapter-OWNED factory type — broader than BQ-00's BigQueryClientLike
// (which only has listDatasets) and wider than BQ-00's projectId-only seam
// (createBigQueryClient forwards only {projectId}, bigqueryAdc.ts:172-178).
// The default implementation wraps createBigQueryClient and forwards
// {projectId, location} to the underlying new BigQuery(opts) call.
export type BigQueryClientFactory = (
  opts: { projectId: string; location?: string },
) => BigQueryClient;

export interface BigQueryClient {
  query(sql: string): Promise<unknown>;
  getQueryResults(jobId: string, opts?: unknown): Promise<unknown>;
  createQueryJob(sql: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  listDatasets(projectId?: string): Promise<Array<{ id?: string }>>;
  getDataset(id: string): Promise<unknown>;
  getTable(datasetId: string, tableId: string): Promise<unknown>;
}

export class BigQueryAdapter implements DbAdapter {
  constructor(cfg: ConnectionConfig, clientFactory?: BigQueryClientFactory);
  // DbAdapter surface: connect/close/runQuery/listSchemas/listTables/listViews/
  // listRoutines/listColumns/testConnection/estimateTableRows/... (full interface)
}
export class BigQueryConnectError extends Error {
  readonly diagnostic: AdcDiagnostic;
}
```

---

## Discussion

### 2026-09-02 · planner · unic-smart
BQ-00's `createBigQueryClient(projectId?, impl?)` seam forwards only `{projectId}`. The
location propagation (test #4) must NOT be implemented by editing `bigqueryAdc.ts`
(BQ-00 surface is frozen this cycle). Wrap the seam: the adapter's default factory
builds the client via `createBigQueryClient(projectId)` and the adapter passes location
through the client's own option surface at the wrapper level; if the seam proves
insufficient, extend the adapter's OWN factory type — never `bigqueryAdc.ts`. Record the
chosen mechanism in the Executor Report.

### 2026-09-02 · planner · unic-smart
Round-2 plan-review sync (see PLAN.md Plan Review Log): the Interfaces block now pins the
mechanism described above — the adapter owns `BigQueryClientFactory`
(`{projectId, location}` opts → broader `BigQueryClient` surface) and its default
implementation wraps `createBigQueryClient`. The earlier `clientFactory?:
typeof createBigQueryClient` sketch was wrong: that BQ-00 signature only forwards
`{projectId}` and returns `BigQueryClientLike` (listDatasets-only), which cannot carry
location or support tests #4-#6. No test change — the existing test plan already
exercises the richer surface.

### 2026-09-02 · planner · unic-smart
Unimplemented introspection surfaces (listColumns on INFORMATION_SCHEMA etc.) may throw
`NotImplementedError` (existing `./types` export) this cycle — BQ-02 wires real
introspection. Tests only pin connect/close/runQuery-normalization behavior, so this is
honest scope, not a stub claim.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
