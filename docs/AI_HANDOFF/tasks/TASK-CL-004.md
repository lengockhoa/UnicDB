# TASK-CL-004 — BQ-00 + BQ-01 R4.5 carried minors (folded)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 TASK-CL-004

## Goal

Fold the two "optional, fold into BQ-02" follow-ups into one small task so they ship
without waiting for BQ-02: (a) BQ-01 adapter minors from TASK-BQ01-002's R4.5 round-2
carried list — distinct not-connected error, measured `durationMs`, top-level type
imports; (b) BQ-00 minors from TASK-BQ00-004's R4.5 round-1 list — unused `DECL_RE` and
two one-line ADR 0004 citation nits. BQ-00 frozen surface stays byte-untouched.

## Target Files

- `src/adapters/bigquery.ts` — new `BigQueryNotConnectedError extends Error` (`name = "BigQueryNotConnectedError"`); `requireClient()` (:299-310) throws it ONLY for `client === null && !closed`, keeps `BigQueryClosedError` for `closed`; measure `durationMs` around `client.query(...)` in `runQuery` (:225-238) via a `Date.now()` delta; replace the seven inline `import("./types").X` return annotations (:244-279) with names added to the existing top-level `import { … } from "./types"` block (:39-44).
- `src/adapters/__tests__/bigquery.test.ts` — new not-connected regression pin + durationMs pin; existing tests #3/#6 (closed-error) must stay green verbatim.
- `src/adapters/__tests__/bigqueryPackage.test.ts` — remove the unused `DECL_RE` (:236) or make it the single pattern source both loops derive from (behavior identical, 14/14 stays green).
- `docs/decisions/0004-bq-00-feasibility-contract.md` — nit 1: :110-112 re-point the `BigQueryValue` citation from `src/adapters/types.ts` to `src/adapters/bigqueryTypes.ts` (re-grep the exact current line — reviewer said :63, current grep shows the union at :90; cite what you find); nit 2: :348-349 drop or re-point the phantom `§"Hard constraints"` cross-reference (the read-only list lives in TASK-BQ00-004 §Target Files / the BQ-00 plan §2, not in this ADR).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | `runQuery` before any `connect()` (never closed) | rejects `BigQueryNotConnectedError` (instanceof + `name === "BigQueryNotConnectedError"`); factory call count 0 | `new BigQueryAdapter(cfg, factory)` then `runQuery` immediately; RED at `611df12` (throws `BigQueryClosedError`) |
| 2 | regression | `testConnection`/`runQuery` after `close()` still `BigQueryClosedError` | existing tests #3/#6 pass verbatim — instanceof `BigQueryClosedError`, factory still 1 call | existing tests, zero modification |
| 3 | edge (lifecycle preserve) | `connect()` after `close()` | still `BigQueryClosedError` (existing pin) | existing fixture |
| 4 | happy | durationMs measured | fake client whose `query` awaits a ~20ms timer → `result.results[0].durationMs >= 15` and `!== 0` for a non-trivial await | existing `makeFakeClient()` with a timer-waiting query |
| 5 | happy | fast query measures ≥ 0 | instantly-resolving fake → `durationMs` is a finite number ≥ 0 (not a constant) | existing fake client |
| 6 | edge (surface preserve) | introspection methods unchanged | `listSchemas`/`listTables`/`listColumns`/… still throw `NotImplementedError("bigquery")` | existing shape tests |
| 7 | unit | bigqueryPackage 14/14 green after DECL_RE cleanup | all existing assertions pass with the duplicated pattern removed/derived | existing test file |
| 8 | unit (non-test) | ADR nit 1 fixed | `grep -n "types.ts" docs/decisions/0004-bq-00-feasibility-contract.md` shows no claim that `BigQueryValue` lives in `src/adapters/types.ts`; the citation names `bigqueryTypes.ts` with a correct current line | grep before/after |
| 9 | unit (non-test) | ADR nit 2 fixed | `grep -n "Hard constraints" docs/decisions/0004-bq-00-feasibility-contract.md` returns no §-reference to a non-existent ADR section (either the phrase is gone or re-pointed to the real location) | grep before/after |

## Test Files

- `src/adapters/__tests__/bigquery.test.ts` — tests #1-#6
- `src/adapters/__tests__/bigqueryPackage.test.ts` — test #7 (file edited, suite count unchanged)

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/bigquery.test.ts src/adapters/__tests__/bigqueryPackage.test.ts
npm run typecheck
```

(No `lint` script exists — `npm run typecheck` is the static gate. Frozen-surface gate: `git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` must be EMPTY after this task. Sanity net: `npx vitest run src/adapters/__tests__/factory.test.ts src/adapters/__tests__/bigqueryAdc.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryConfig.test.ts`.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; test #1 confirmed RED at `611df12` (paste RED output).
- [ ] `BigQueryClosedError` semantics preserved exactly for post-close operations (tests #2, #3) — no existing test modified or deleted.
- [ ] `durationMs` is a real measurement; `commandTag` stays `undefined` (documented in a code comment: no tag source in the wire response — BQ-02).
- [ ] No inline `import("./types").X` annotations remain in bigquery.ts; type names come from the top-level import block.
- [ ] Frozen-surface gate empty: `git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` prints nothing.
- [ ] Both ADR greps (#8, #9) clean; ADR edits are citation-only (no decision content changed).
- [ ] `npm run typecheck` exits 0.

## Dependencies

- (none)

## Interfaces

- Consumes: `BigQueryAdapter`, `BigQueryClosedError`, `BigQueryClientFactory`, `BigQueryClient` (bigquery.ts, existing); `DbAdapter.runQuery(): Promise<RunResult>` with `QueryResult.durationMs: number` (types.ts, existing — `durationMs` was already declared, just hardcoded); `NotImplementedError` (types.ts, existing); `toBigQueryPage` / `BigQueryRawQueryResponse` (bigqueryTypes.ts — FROZEN, import only).
- Produces: `BigQueryNotConnectedError` (new export from bigquery.ts; constructor takes no args; `name === "BigQueryNotConnectedError"`). Contract: `requireClient()` now distinguishes never-connected (NotConnected) from post-close (Closed) — callers matching on `/closed/i` regexes still pass for the closed case (message unchanged: "BigQueryAdapter is closed").

---

## Discussion

### 2026-09-02 · planner · unic-smart
Both STATUS.md items 5 and 6 are one-line-scale fixes sharing one concern family (BQ carried reviewer minors), folded per the cycle instruction. Grounding notes for the executor: (1) reviewer's ADR nit cites `bigqueryTypes.ts:63` for `BigQueryValue`, but current grep puts the union at :90 — re-grep and cite the line you find, do not copy the reviewer's number. (2) `connectionManager.ts:716` mentions `BigQueryClosedError` in a doc comment — leave it alone; it describes the post-close path which is unchanged. (3) The not-connected error is a NEW public export — allowed explicitly by PLAN §6; do not export anything else while in there.
