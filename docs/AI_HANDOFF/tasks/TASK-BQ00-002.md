# TASK-BQ00-002 — Pure BigQuery job/page contract types

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (BQ-00.2), §4 (rows 002), §7 Global Constraints

## Goal

Define the pure boundary types that map BigQuery's async job + paged-result API into VSDB's adapter world — without importing the client and without touching `DbAdapter`. The contract must make continuation ownership explicit and make NUMERIC/BIGNUMERIC/INT64 precision preservation contractual (canonical strings, never JS `number`).

## Target Files

- `src/adapters/bigqueryTypes.ts` — **(new)** pure boundary types (below) **plus the named mapper export `toBigQueryPage(raw: BigQueryRawQueryResponse): BigQueryPage`**. No import from `@google-cloud/bigquery`.
- `src/adapters/__tests__/bigqueryTypes.test.ts` — **(new)** the test matrix below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `toBigQueryPage maps fixture to BigQueryPage preserving jobRef identity` | calling the exported `toBigQueryPage(rawFixture)` returns a `BigQueryPage`; `jobRef` `{projectId:"vsdb-it", location:"US", jobId:"job_abc"}` deep-equals verbatim; mapped `schema`/`rows`/`pageToken` match the fixture's raw values — the subject is the real function, not the type (a types-only implementation cannot pass) | synthetic job/page fixture (roadmap §8.1: no `{rows:[]}`-only mocks) |
| 2 | edge (empty) | `empty final page has no next` | `rows:[]`, `pageToken:null` → `hasNextPage(page) === false` | empty terminal page |
| 3 | edge (empty-vs-token) | `empty page can still continue` | `rows:[]` + non-null token → `hasNextPage(page) === true` (token — not row count — owns continuation) | empty non-terminal page |
| 4 | edge (continuation/ownership) | `page token round-trips opaquely` | token `"BE5BABA0ODA0MjcuMDgwMDA6MQ"` flows into a `BigQueryPageRequest` unmodified — no parse/trim/truncate | opaque token string |
| 5 | edge (structural) | `nested RECORD + REPEATED preserved` | 2-level nested schema (`fields[].fields`), REPEATED mode renders arrays verbatim, values intact | nested/repeated fixture |
| 6 | edge (precision/boundary) | `NUMERIC/BIGNUMERIC canonical strings` | `"12345678901234567890.123456789"` and `"9007199254740993"` (> `Number.MAX_SAFE_INTEGER`) are `typeof "string"` with exact digit equality — fails under any `Number` coercion | precision fixtures |
| 7 | edge (contract guard) | `type surface forbids number for decimal/int fields` | `BigQueryValue` decimal/int branches are string-typed at compile time; test uses `@ts-expect-error` on a numeric literal assignment to prove the contract | type-level test |

## Test Files

- `src/adapters/__tests__/bigqueryTypes.test.ts` — **(new)** tests #1-#7.

## Verification Commands

```bash
# 1. Focused proof
npx vitest run src/adapters/__tests__/bigqueryTypes.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck

# 3. Bundle gate
npm run compile

# 4. Full suite at wave boundary (floor: 3189 passed | 2 skipped, must not drop)
npm test
```

## Acceptance Criteria

- [ ] `src/adapters/bigqueryTypes.ts` is pure (zero imports from `@google-cloud/bigquery`, zero imports of `vscode`), exporting the full type surface below **AND the named mapper `toBigQueryPage`** (test #1's subject — shipping types without the function fails review).
- [ ] All 7 test cases pass; RED evidence pasted in Executor Report.
- [ ] Response field names validated against the installed client's `.d.ts` (`node_modules/@google-cloud/bigquery/build/src/*.d.ts`) — evidence (file + line refs for `pageToken`, `totalBytesProcessed`, `schema.fields`, `mode`) recorded in Discussion for ADR 0004.
- [ ] `hasNextPage` decides from `pageToken`, never row count (tests #2/#3 pin this).
- [ ] `npm run typecheck`, `npm run compile`, `npm test` green (floor 3189|2 preserved).
- [ ] No edit to `DbAdapter` or any §2-read-only file. If the spike DOES prove a `DbAdapter` gap: STOP, do not edit types.ts, record findings in Discussion as a stop-and-revise item (roadmap §9.6) — P0 micro-decision required.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ00-001 must complete first (the executor validates field names against the installed client's `.d.ts`; roadmap §2 mandate).

## Interfaces

- Consumes: `@google-cloud/bigquery` `.d.ts` (installed by TASK-BQ00-001) for field-name validation only — NOT imported by the source file.
- Produces (consumed by TASK-BQ00-004's ADR; later by BQ-01+):

```ts
export interface BigQueryJobRef {
  projectId: string;
  location: string;   // BigQuery location, e.g. "US" | "EU" | region
  jobId: string;
}
export interface BigQuerySchemaField {
  name: string;
  type: string;       // e.g. "STRING" | "INT64" | "NUMERIC" | "BIGNUMERIC" | "RECORD" | ...
  mode: "NULLABLE" | "REQUIRED" | "REPEATED";
  fields?: BigQuerySchemaField[];  // present when type === "RECORD"
}
// Decimal/int classes are contractually canonical strings — NEVER JS number.
export type BigQueryValue =
  | string            // STRING, INT64, NUMERIC, BIGNUMERIC, DATE/TIME family, BYTES(b64), JSON
  | boolean
  | number            // FLOAT64 only
  | null
  | BigQueryValue[]   // REPEATED
  | { [field: string]: BigQueryValue };  // RECORD
export interface BigQueryPage {
  jobRef: BigQueryJobRef;
  schema: BigQuerySchemaField[];
  rows: BigQueryValue[][];
  totalBytesProcessed?: string;   // bytes as string (may exceed safe integer)
  totalBytesBilled?: string;
  pageToken: string | null;       // null = final page
}
export interface BigQueryPageRequest {
  jobRef: BigQueryJobRef;
  pageToken?: string;
  maxResults?: number;
}
export function hasNextPage(page: Pick<BigQueryPage, "pageToken">): boolean;
/**
 * Named mapper (plan-review mandate): raw client response → contract page.
 * Pure; the raw-response shape is whatever the installed .d.ts validates in
 * this task's Discussion — not imported from the client package.
 */
export function toBigQueryPage(
  raw: BigQueryRawQueryResponse,
): BigQueryPage;
```

---

## Discussion

### 2026-09-02 · planner · unic-smart
To 002's executor: the `.d.ts` field-name validation (Acceptance #3) is a hard requirement, not a formality — the roadmap explicitly voids assumptions about "Node-client pagination method names" until validated against the selected version. Record what you actually find; if the real client names differ from the type surface above (e.g. `totalBytesProcessed` casing), correct THIS file to match reality and note the delta here — the type surface above is the planner's expectation, not gospel.

### 2026-09-02 · planner · unic-smart (Round 2)
`toBigQueryPage` is now a named deliverable (plan-review Important 1): previously no mapper was named, so a literal executor could ship types only and let the happy test check a fixture against itself — a self-referential test with no subject. Test #1 now calls the real function: fixture IN, `BigQueryPage` OUT, `jobRef` verbatim. Division of labor with 001: response **field names** (pageToken, totalBytesProcessed, schema.fields) stay yours (Acceptance #3); pagination/cancel **method names + return shapes** now live in 001's `docs/decisions/_bq00-evidence.md` — cite it if your validation touches those methods, don't duplicate it.
