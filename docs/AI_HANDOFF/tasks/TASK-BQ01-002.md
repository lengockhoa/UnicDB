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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: -
SUMMARY: BigQueryAdapter implemented in `src/adapters/bigquery.ts` — owns `BigQueryClientFactory` (`{projectId, location}`) wrapping BQ-00's `createBigQueryClient`, validates config via `validateBigQueryConnection`, maps ADC failures to `BigQueryConnectError(diagnostic)`, idempotent close, and routes query results through `toBigQueryPage` so branded strings survive end-to-end. Unimplemented introspection throws `NotImplementedError` (BQ-02 scope). 6/6 tests pass.
TEST_PLAN_FOLLOWED: task §4 (Test Cases #1-#6)
FILES_CHANGED:
  - src/adapters/bigquery.ts: NEW — BigQueryAdapter, BigQueryConnectError, BigQueryClosedError, BigQueryClient, BigQueryClientFactory, default factory wrapping BQ-00.
  - src/adapters/__tests__/bigquery.test.ts: NEW — 6 tests (happy connect, typed diagnostic, idempotent close, location propagation, branded-string normalization, runQuery after close).
TESTS_ADDED:
  - src/adapters/__tests__/bigquery.test.ts: 6 tests, all green
VERIFICATION:
  command: npx vitest run src/adapters/__tests__/bigquery.test.ts
  result: 6 pass / 0 fail / exit 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq01-002
     ✓ src/adapters/__tests__/bigquery.test.ts  (6 tests) 6ms
     Test Files  1 passed (1)
          Tests  6 passed (6)
  command: npm run typecheck
  result: exit 0 (no errors)
  output_excerpt: |
    > vsdb@1.46.0 typecheck
    > tsc --noEmit
  command (sanity): npx vitest run src/adapters/__tests__/bigqueryAdc.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryConfig.test.ts src/adapters/__tests__/bigqueryPackage.test.ts
  result: 33 pass / 0 fail / exit 0 (BQ-00 and BQ-01-001 surfaces still green)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

### Executor Decision Log

- **RED first confirmed.** Initial run failed with `Error: Failed to load url ../bigquery` (source file absent) — exactly the expected RED shape. After implementation, 5/6 passed; test #1 was red because the helper used a plain `async () => [...]` for `listDatasets` instead of `vi.fn(...)`. Switched the test fixture to `vi.fn(async () => [{id:"ds1"}])` so `toHaveBeenCalledTimes(1)` works. No production-code change was needed for this.
- **Location-propagation mechanism (per Discussion 2026-09-02):** the adapter owns `BigQueryClientFactory = (opts: {projectId, location?}) => BigQueryClient`. The default implementation wraps BQ-00's `createBigQueryClient(projectId, impl)` where `impl` is a forwarder that constructs `new BigQuery({projectId, location})` (lazy-`require`d, so the GCP client only materializes at factory-call time, not at module import). The real `new BigQuery(...)` call is isolated in a private `buildRealClient` helper behind that lazy require — there is no `new BigQuery(` outside the default factory parameter (acceptance criterion).
- **Redaction discipline:** `BigQueryConnectError` only carries the typed `AdcDiagnostic` (category + fixed remediation). The leak marker `ZZZ-LEAK-9981` is asserted absent from both `error.message` and `error.diagnostic.remediation` (test #2).
- **Closed-error shape:** introduced a separate `BigQueryClosedError` for post-`close()` operation requests (lifecycle violation, not connection failure — does not carry a diagnostic). Test #3 and #6 both assert `/closed/i` on the rejection.
- **Idempotent close:** first `close()` flips `this.closed = true` and drops the client reference; second `close()` is a no-op. `connect()` after close throws `BigQueryClosedError` without re-entering the factory (asserted by `factory` call-count).
- **Branded-string survival:** `runQuery` routes the client's response through `toBigQueryPage` from BQ-00 and maps `page.schema[].name` → `columns` and `page.rows` → `rows` with `rowCount: page.rows.length`. INT64/NUMERIC/BIGNUMERIC cells are never coerced (test #5 uses `bigIntStr = "9007199254740993"` and asserts `typeof === "string"` and exact digit equality).
- **Unimplemented surfaces:** `listSchemas`, `listTables`, `listViews`, `listRoutines`, `listColumns`, `listRoutineParams`, `estimateTableRows`, `estimateTableRowsBatch`, `listTableDetail` each throw `NotImplementedError("bigquery")` per task Discussion (BQ-02 wires real introspection).
- **No `BigQuery`-imports leak into the test seam:** tests inject a `BigQueryClientFactory`; the real `BigQuery` class is only constructed inside the default factory's lazy `require`. Tests never touch `@google-cloud/bigquery`.
- **BQ-00 frozen surface:** `bigqueryAdc.ts` and `bigqueryTypes.ts` byte-untouched (`git status` shows only the two new untracked files).

## Executor Report (fix round 2 — 2026-09-02)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Retry build after the round-1 worktree was wiped. Re-implemented `BigQueryAdapter implements DbAdapter` in `src/adapters/bigquery.ts` from scratch and added the 6-test contract suite in `src/adapters/__tests__/bigquery.test.ts`. RED confirmed (load failure on missing source); GREEN achieved on first run after implementation (no test-quirk fixes needed this round). BQ-00 surface (`bigqueryAdc.ts`, `bigqueryTypes.ts`) byte-untouched. Work committed inside the worktree.
TEST_PLAN_FOLLOWED: task §4 (Test Cases #1-#6)
FILES_CHANGED:
  - src/adapters/bigquery.ts: NEW — BigQueryAdapter, BigQueryConnectError, BigQueryClosedError, BigQueryClient, BigQueryClientFactory, default factory wrapping BQ-00.
  - src/adapters/__tests__/bigquery.test.ts: NEW — 6 tests (happy connect, typed diagnostic, idempotent close, location propagation, branded-string normalization, runQuery after close).
TESTS_ADDED:
  - src/adapters/__tests__/bigquery.test.ts: 6 tests, all green on first run after implementation
VERIFICATION:
  command: npx vitest run src/adapters/__tests__/bigquery.test.ts
  result: 6 pass / 0 fail / exit 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq01-002
     ✓ src/adapters/__tests__/bigquery.test.ts  (6 tests) 3ms
     Test Files  1 passed (1)
          Tests  6 passed (6)
  command: npm run typecheck
  result: exit 0 (no errors)
  output_excerpt: |
    > vsdb@1.46.0 typecheck
    > tsc --noEmit
  command (sanity): npx vitest run src/adapters/__tests__/bigqueryAdc.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryConfig.test.ts src/adapters/__tests__/bigqueryPackage.test.ts src/adapters/__tests__/factory.test.ts
  result: 37 pass / 0 fail / exit 0 (5 files, BQ-00 + BQ-01-001 + factory surfaces all green)
  command: git diff --stat src/adapters/bigqueryAdc.ts src/adapters/bigqueryTypes.ts
  result: empty (BQ-00 frozen surface confirmed byte-untouched)
  git status: only 2 new untracked files: src/adapters/bigquery.ts, src/adapters/__tests__/bigquery.test.ts
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

### Fix-Round-2 Decision Log

- **RED confirmed:** initial `npx vitest run src/adapters/__tests__/bigquery.test.ts` failed with `Error: Failed to load url ../bigquery (resolved id: ../bigquery) ... Does the file exist?` — exactly the expected RED shape (source absent).
- **GREEN on first run:** all 6 tests passed immediately after the implementation landed. This round avoided the round-1 quirk (test #1 fixture needed `vi.fn(async () => [...])` for `listDatasets`, not a plain `async () => [...]`) by using `vi.fn` from the start on every fake-client method. No test-quirk fixes needed.
- **Location-propagation mechanism (per Discussion 2026-09-02):** the adapter owns `BigQueryClientFactory = (opts: {projectId, location?}) => BigQueryClient`. The default implementation wraps BQ-00's `createBigQueryClient(projectId)` (the narrow listDatasets seam) AND constructs the real client via `new BigQuery({projectId, location})` through a lazy `require("@google-cloud/bigquery")` so the GCP client only materializes at factory-call time, not at module import. There is no `new BigQuery(` outside the default factory body (acceptance criterion).
- **Redaction discipline:** `BigQueryConnectError` only carries the typed `AdcDiagnostic` (category + fixed remediation); the `error.message` is the safe category string and the raw err message is never echoed. The leak marker `ZZZ-LEAK-9981` is asserted absent from both `error.message` and `error.diagnostic.remediation` (test #2).
- **Closed-error shape:** separate `BigQueryClosedError` for post-`close()` operations (lifecycle violation, no diagnostic). Test #3 and #6 both assert `instanceof BigQueryClosedError`.
- **Idempotent close:** first `close()` flips `this.closed = true` and drops `this.client`; second `close()` is a no-op. `connect()` after close throws `BigQueryClosedError` without re-entering the factory (asserted via `factory` call-count, test #3).
- **Branded-string survival:** `runQuery` routes the client's response through `toBigQueryPage` from BQ-00 and maps `page.schema[].name` → `columns`, `page.rows` → `rows`, `rowCount: page.rows.length`. INT64/NUMERIC/BIGNUMERIC cells are never coerced (test #5 uses `bigIntStr = "9007199254740993"` and asserts `typeof === "string"` plus exact digit equality).
- **Unimplemented surfaces:** `listSchemas`, `listTables`, `listViews`, `listRoutines`, `listColumns`, `listRoutineParams`, `estimateTableRows`, `estimateTableRowsBatch`, `listTableDetail` each throw `NotImplementedError("bigquery")` per task Discussion (BQ-02 wires real introspection).
- **No `BigQuery`-imports leak into the test seam:** tests inject a `BigQueryClientFactory`; the real `BigQuery` class is only constructed inside the default factory's lazy `require`. Tests never touch `@google-cloud/bigquery`.
- **BQ-00 frozen surface:** `bigqueryAdc.ts` and `bigqueryTypes.ts` byte-untouched (`git diff --stat` on both is empty; `git status` shows only the two new untracked files).
- **Persistence:** committed inside the worktree on branch `handoff/task-bq01-002` so the work survives any external teardown.

