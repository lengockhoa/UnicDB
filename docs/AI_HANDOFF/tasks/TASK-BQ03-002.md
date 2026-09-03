# TASK-BQ03-002 — BigQuery result page bridge (pure helpers)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (BQ-03.2), §3 Approach "Page bridge", §4 rows 3-4, 10

## Goal

Add a NEW pure module `src/adapters/bigqueryPages.ts` with two helpers: (1) `createBigQueryPageFetcher` — turns a raw `getQueryResults` tuple into a bounded page (token-verbatim continuation, 20 MB-aware budget/limit marking), and (2) `formatBigQueryCell` — display formatting for `BigQueryValue` cells that preserves the display semantics of nested/repeated/JSON/bytes/temporal/large-decimal types without `Number()` coercion. No `@google-cloud/bigquery`, no `vscode`, no I/O — unit-testable in isolation.

## Target Files

- `src/adapters/bigqueryPages.ts` (new) — the two pure helpers + their option types. Import from `./bigqueryTypes` only (frozen surface, import-only).
- `src/adapters/__tests__/bigqueryPages.test.ts` (new) — all tests below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | empty result | raw response with `rows: []` (or absent) and `pageToken: null` → fetcher returns `{ rows: [], pageToken: null, limited: false }`; a SECOND call with the same input yields the same output (pure, no hidden state) | empty `BigQueryRawQueryResponse` fixture |
| 2 | happy | first page | raw response with 2 rows + `pageToken: "tok-1"` → `{ rows: 2 tuples, pageToken: "tok-1", limited: false }`; schema mapped via frozen `toBigQueryPage` (column names surface in order) | 2-row fixture |
| 3 | happy | page token preserved verbatim | `pageToken: "  CkA+complex/token=="` (spaces, slashes, `=`) round-trips EXACTLY — no trim/decode/normalize (pins frozen mapper contract at the fetcher layer too) | token fixture with special chars |
| 4 | happy | final page | `pageToken: null` → `{ pageToken: null }`; helper reports `hasNext: false` (or equivalent) — continuation is decided by the token, never by row count | null-token fixture WITH rows present |
| 5 | edge (boundary) | 20 MB-aware bounded page | fetcher built with `byteBudget` where the fixture's `totalBytesProcessed` (`"25000000"`, 25 MB) exceeds the budget → result marked `limited: true` and the fetcher reports the enforced bound; a page inside budget stays `limited: false` | two fixtures: 25 MB and 10 MB vs 20 MB budget |
| 6 | happy | nested RECORD cell preserved | row cell `{ f: [{ v: "a" }, { v: "8" }] }` (RECORD) survives mapping + `formatBigQueryCell` renders structure without flattening errors — output contains both fields, INT64 child stays `"8"` (string) | RECORD fixture |
| 7 | happy | REPEATED cell preserved | cell `[{ v: "x" }, { v: "y" }]` (REPEATED) → formatted output shows both elements in order, no `Number()` coercion | REPEATED fixture |
| 8 | happy | JSON + BYTES + temporal cells | JSON string cell `{"k":1}` → rendered as the JSON text; BYTES base64 `aGVsbG8=` → rendered as the base64 text; DATE `"2026-09-03"`, TIME `"12:00:00"`, TIMESTAMP `"2026-09-03T12:00:00Z"` → rendered verbatim | mixed-type row fixture |
| 9 | edge (boundary) | large decimals stay strings | INT64 `"9007199254740993"`, NUMERIC `"123.45"`, BIGNUMERIC `"9007199254740993.0000000001"` → formatted output is the exact string; `typeof` stays `"string"`; NO scientific notation, NO rounding | branded-string fixtures (cast through the frozen types) |
| 10 | edge (empty/malformed) | null cell + missing field | `null` cell → `formatBigQueryCell(null)` returns `""` (or the agreed empty marker) without throw; field arg omitted → formatting still works (field is optional context, not required) | minimal fixtures |
| 11 | regression | frozen mapper parity | for the same fixture, `createBigQueryPageFetcher`'s mapped rows equal `toBigQueryPage(raw).rows` exactly (fetcher composes the frozen mapper, does not reimplement it) | shared fixture with `toBigQueryPage` import |

## Test Files

- `src/adapters/__tests__/bigqueryPages.test.ts` (new) — pure unit tests, no fakes needed beyond raw-response literals.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/bigqueryPages.test.ts
npm run typecheck
git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # must print nothing
```

(`npm run typecheck` is the static gate — **no lint script exists** in this repo. The frozen-surface gate is mandatory.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; the new file exits 0.
- [ ] `bigqueryPages.ts` imports ONLY from `./bigqueryTypes` (plus standard lib) — no `@google-cloud/bigquery`, no `vscode`, no adapter state.
- [ ] Token continuation is verbatim and token-driven (never row-count-driven).
- [ ] The byte budget marks `limited` without mutating or accumulating all results.
- [ ] All decimal/int/bytes/JSON/temporal display semantics preserved; zero `Number()` coercion of branded strings.
- [ ] Frozen-surface `git diff --stat` prints nothing; `npm run typecheck` exits 0.

## Dependencies

- (none)

## Interfaces

- Consumes: frozen `toBigQueryPage`, `BigQueryPage`, `BigQueryRawQueryResponse`, `BigQueryValue`, `BigQuerySchemaField` from `./bigqueryTypes` (import-only).
- Produces (consumed by TASK-BQ03-001's `BigQueryPagedQuery` from wave 2 onward, and by any later display wiring):
  `createBigQueryPageFetcher(deps: { fetch: (opts: { maxResults?: number; pageToken?: string }) => Promise<unknown>; byteBudget?: number }): { first(): Promise<BigQueryPageFetch>; next(): Promise<BigQueryPageFetch | null>; readonly exhausted: boolean }` where `BigQueryPageFetch = { page: BigQueryPage; rows: unknown[][]; limited: boolean }` — `next()` returns `null` once the last seen `pageToken` is null;
  `formatBigQueryCell(value: BigQueryValue | null | undefined, field?: BigQuerySchemaField): string`.
- **Limited-channel contract (locked by PLAN.md round-1 review)**: `BigQueryPageFetch.limited: boolean` is the only carrier of the byte-budget signal. TASK-BQ03-001's `BigQueryPagedQuery` reads it on the FIRST call that returns `limited: true` and stores it internally; on the next call that returns `null` (EOF), `BigQueryPagedQuery` invokes `onExhausted?.({ limited: this.limited })` if 03.3 set the callback when constructing the runner's view. This keeps `BatchedQuery` (`src/adapters/types.ts:62-67`) frozen.
- **Wiring scope (locked by PLAN.md round-1 review)**: `formatBigQueryCell` is **deliverable-but-unwired this cycle**. None of the 5 tasks (03.1–03.5) plug it into the results grid; today RECORD/REPEATED keep the existing `ResultsPanel` rendering. The function ships tested + exported so a follow-up cycle (BQ-04 or later) can swap it in without re-deriving the display rules. This is recorded in `PLAN.md` §2 Out of scope and §6 Acceptance as an explicit follow-up, not a TODO hiding in code.

---

## Discussion

### 2026-09-03 · planner · unic-smart
Grounding notes for the executor:

1. **Purity is the point.** This module is the test-isolation layer between the frozen wire mapper and the jobful adapter. If you find yourself wanting `vscode` or the client here, the boundary is wrong — push it up to 03.1's `BigQueryPagedQuery`.
2. The 20 MB budget is *advisory at the seam*: real GCP page sizing varies by region and cannot be asserted against live GCP in CI. What is pinned: the budget is compared against a page-level byte figure (prefer `totalBytesProcessed` deltas or a projected row-bytes estimate — pick ONE and document it in the code), `limited` flips exactly at the boundary, and nothing accumulates.
3. `formatBigQueryCell` output feeds the grid, which treats cells as display strings. Keep RECORD/REPEATED output compact (single-line, deterministic key order as received). Do not JSON.parse JSON cells — render the raw text.
4. RED-first: tests #5, #9 fail against an empty module trivially — write them first, then implement.
5. Keep both exports narrow; wave-2 tasks consume exactly these shapes (see Interfaces). If you must deviate, note it in Discussion — 03.3/03.4 do NOT import this module directly (only 03.1's paged query does), so changes stay local.

---

## Executor Report

## Reviewer Verdict
