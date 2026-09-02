# TASK-BQ00-003 — ADC diagnostic classifier + client seam

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (BQ-00.3), §4 (rows 003), §7 Global Constraints

## Goal

Make the four ADC/connection failure classes the roadmap requires — **missing ADC, bad billing project, denied API, wrong location** — distinguishable without secrets: a pure classifier that maps error shapes to a category + fixed copy-safe remediation text (redaction by construction), plus a thin client seam so CI can exercise the full smoke path with an injected fake. No real GCP call anywhere in this cycle.

## Target Files

- `src/adapters/bigqueryAdc.ts` — **(new)** classifier + seam (interface below). May import the client for the real-constructor wrapper; must not construct a real client at module load or in any test.
- `src/adapters/__tests__/bigqueryAdc.test.ts` — **(new)** the test matrix below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `fake client smoke resolves ok` | injected fake `listDatasets` resolving one dataset → `runAdcSmoke` resolves `"ok"`; construction observed via a `vi.fn()` impl passed as `createBigQueryClient`'s second parameter, asserted `toHaveBeenCalledTimes(1)`; `projectId` propagated to the client options and visible in the options object the spy received | fake client via the seam; spy = the injectable `impl` parameter itself, no extra mocking library |
| 2 | edge (missing credential) | `missing ADC classified with gcloud remediation` | synthetic error `"Could not load the default credentials..."` → `classifyAdcDiagnostic` returns `missing_adc`; remediation mentions `gcloud auth application-default login` | synthetic `Error` |
| 3 | edge (two distinct permission classes) | `denied API vs bad billing project distinguishable` | synthetic 403 `"Access Denied: Project ..."` → `api_denied`; synthetic 404 project-not-found → `bad_billing_project`; two DIFFERENT categories | two synthetic errors |
| 4 | edge (semantic) | `wrong location classified; unknown falls back` | location-mismatch text (e.g. `"Dataset ... is not found in region EU"`) → `location_mismatch`; unrecognized error → `unknown` with generic remediation | synthetic errors |
| 5 | edge (security/redaction) | `classifier never echoes raw error text` | error message embedding `"Bearer abc123"` → returned `category` + `remediation` contain neither the token nor any substring of the raw message | poisoned synthetic error |
| 6 | edge (input shape) | `null/non-Error/non-string inputs never throw` | `classifyAdcDiagnostic(null)` / `42` / `{}` / `new Error()` (empty message) each return a valid `AdcDiagnostic` with a defined category (typically `unknown`), never throwing | degenerate inputs |

## Test Files

- `src/adapters/__tests__/bigqueryAdc.test.ts` — **(new)** tests #1-#6.

## Verification Commands

```bash
# 1. Focused proof
npx vitest run src/adapters/__tests__/bigqueryAdc.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck

# 3. Bundle gate
npm run compile

# 4. Full suite at wave boundary (floor: 3189 passed | 2 skipped, must not drop)
npm test
```

## Acceptance Criteria

- [ ] All 6 test cases pass; RED evidence pasted in Executor Report.
- [ ] `classifyAdcDiagnostic` covers all four roadmap classes (`missing_adc`, `bad_billing_project`, `api_denied`, `location_mismatch`) + `unknown` fallback, and returns ONLY `{category, remediation}` — never the raw error, never env values, never tokens (test #5 pins this).
- [ ] `createBigQueryClient` is a thin injectable seam (real constructor behind it; CI passes fakes); no test constructs a real GCP client; the module performs no I/O at import time.
- [ ] `npm run typecheck`, `npm run compile`, `npm test` green (floor 3189|2 preserved).
- [ ] No edit to `DbAdapter` or any §2-read-only file (same stop-and-revise rule as 002).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ00-001 must complete first (its seam wraps the real constructor from the installed package). Deliberately NOT dependent on TASK-BQ00-002 — the classifier consumes no contract types; that is what lets 002 ∥ 003 share wave 2.

## Interfaces

- Consumes: `@google-cloud/bigquery`'s `BigQuery` constructor (installed by TASK-BQ00-001).
- Produces (consumed by TASK-BQ00-004's ADR; later by BQ-01's connection-manager diagnostics):

```ts
export type AdcDiagnosticCategory =
  | "missing_adc" | "bad_billing_project" | "api_denied" | "location_mismatch" | "unknown";
export interface AdcDiagnostic {
  category: AdcDiagnosticCategory;
  remediation: string;   // fixed copy-safe text; never derived from err.message
}
export function classifyAdcDiagnostic(err: unknown): AdcDiagnostic;
/** Minimal structural client surface the smoke needs — fakes implement this. */
export interface BigQueryClientLike {
  listDatasets(projectId?: string): Promise<Array<{ id?: string }>>;
}
/** Test seam: injectable factory. Production default wraps `new BigQuery(opts)`. */
export function createBigQueryClient(
  projectId?: string,
  impl?: (opts: { projectId?: string }) => BigQueryClientLike,
): BigQueryClientLike;
/** Smoke: list one allowed resource; resolves "ok" or a diagnostic. */
export function runAdcSmoke(client: BigQueryClientLike): Promise<"ok" | AdcDiagnostic>;
```

---

## Discussion

### 2026-09-02 · planner · unic-smart
Design note for the executor: classification must be **redaction by construction** — the function's output type has no field for the raw message, so echo is impossible by type, not just by test. Matching keys off error `code`/`status` properties (e.g. Google API status codes) is preferred over substring-matching English message text where the client's error shape supports it; if you find the real client's error shape exposes a better discriminator than substrings, use it and record the finding here for the ADR. The synthetic message fixtures above remain the tests regardless.

### 2026-09-02 · planner · unic-smart (Round 2)
Test #1's "constructed once" now has an explicit observation mechanism (plan-review Minor 1): the seam's existing injectable `impl` parameter IS the spy — wrap it in `vi.fn((opts) => fakeClient)` and assert `toHaveBeenCalledTimes(1)` plus `projectId` inside the captured options. No new mocking surface; the assertion must be in the test, not prose.
