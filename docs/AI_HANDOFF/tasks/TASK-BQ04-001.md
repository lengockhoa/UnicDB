# TASK-BQ04-001 — additive `dialect?` marker on `StatementResult` + BQ setter

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 BQ-04.1, §3 Approach 1-2, §4 rows 001.a-c

## Goal

Add an additive optional `dialect?: "bigquery" | SqlDialect` field to the `StatementResult` interface — declared in BOTH the canonical `src/core/queryRunner.ts` interface AND its local mirror in `src/ui/resultsGridModel.ts` — and stamp `dialect: "bigquery"` on each of this run's settled statements from the BigQuery branch of `runStatements` in `src/extension.ts`. Non-BQ runs leave the field `undefined`. No renderer changes (TASK-BQ04-002), no frozen-file edits, no new webview message type.

## Target Files

- `src/core/queryRunner.ts` — add `dialect?: "bigquery" | SqlDialect` to `export interface StatementResult` (line ~49), with a doc comment in the established style of the `pending?: boolean` / `cursorExhausted?: boolean` fields; import `type SqlDialect` from `./statementParser` (it exports it, `statementParser.ts:21`).
- `src/ui/resultsGridModel.ts` — add the identical `dialect?: "bigquery" | SqlDialect` field to the local mirror `export interface StatementResult` (lines 54-61). Mirror-site edit ONLY — no logic change in this task. The mirror may re-declare the union inline (`"bigquery" | "postgres" | "mysql" | "mssql"`) or import `SqlDialect` from `../core/statementParser` (a pure module import, allowed — the mirror's existing constraint is only "no webview/ import"); executor picks one and keeps both sites structurally identical.
- `src/extension.ts` — in `runStatements` (line ~2059), after `await runner.run(...)` settles (line ~2102): if `active?.driver === "bigquery"`, stamp `dialect: "bigquery"` on each statement in the run slice `results.slice(appendBase)` BEFORE the `panel.render(results, finalHeader, { appendBase })` call. Non-BQ branches never enter the block → field stays `undefined`. Do NOT touch the streaming `onUpdate` path (renders only running/pending states). Also stamp `schemaFields` per §3.4 (structural, optional — see Interfaces below).
- `src/core/__tests__/queryRunner.test.ts` — add the tests below in a new `describe("BQ-04 dialect marker")` block. Do NOT modify existing tests in this file.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | BQ run stamps `dialect: "bigquery"` on each settled statement | With `active.driver === "bigquery"`, after the `runStatements` flow settles, every entry of `results.slice(appendBase)` has `r.dialect === "bigquery"`; `r.schemaFields` is present and structurally `{name,type,mode}`-shaped (or `undefined` only when the page source exposes none — see Interfaces) | fake `mgr.getActive()` → `{driver: "bigquery", bigquery: {...}}`; stub `runner.run` resolving 2 settled statements; drive `runStatements` via the exported path or extract a small pure `stampBqDialect(runSlice)` helper — either is acceptable, keep it testable without a VS Code handle |
| 2 | edge (non-BQ) | non-BQ drivers leave `dialect` `undefined` | Same harness with `active.driver` = `"postgres"`, `"mysql"`, `"mssql"`: every settled `r.dialect === undefined` and `r.schemaFields === undefined` → `formatCell` path preserved downstream (regression for TASK-BQ04-002) | same harness, non-BQ active connection |
| 3 | edge (spread survival) | `dialect` survives the loadMore/requery rest-spread | Given `stmt = {...base, dialect: "bigquery", resultLimited: true, cursorClosed: true}`, execute the `resultsPanel.ts:692` pattern `const { resultLimited, cursorClosed, ...rest } = stmt` → `rest.dialect === "bigquery"` (proves the reconstruction sites preserve the marker); plus a compile-time `satisfies`/type assertion that both `StatementResult` sites declare the field (tsc passing is the compile assertion) | pure JS, no VS Code |
| 4 | regression | existing runner tests unchanged-green | All pre-existing tests in `src/core/__tests__/queryRunner.test.ts` still pass unmodified (`npx vitest run src/core/__tests__/queryRunner.test.ts` green at cycle end) | current file |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — new `describe("BQ-04 dialect marker")` block appended at the end. If the stamping helper is extracted as a new pure function (recommended: `export function stampBqDialect(results: StatementResult[]): StatementResult[]` in `src/extension.ts` or a tiny `src/core/bqDialect.ts` — executor's choice, keep it pure and dependency-light), test THAT directly; otherwise test through the `runStatements` seam with a fake `ConnectionManager`.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] `dialect?: "bigquery" | SqlDialect` present on BOTH `StatementResult` declarations (`src/core/queryRunner.ts`, `src/ui/resultsGridModel.ts`).
- [ ] `src/extension.ts` BQ branch stamps `dialect: "bigquery"` (+ `schemaFields`) on this run's slice post-settle; non-BQ untouched.
- [ ] `npm run typecheck` green (both mirror sites compile).
- [ ] All 4 test rows above pass; no pre-existing test in the file regresses.
- [ ] No frozen file touched (`git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json` empty).
- [ ] No new webview message type; no change to `formatCell`, `formatBigQueryCell`, or `webview/main.ts` (that is TASK-BQ04-002's file).

## Dependencies

- (none)

## Interfaces

- Consumes: `SqlDialect` from `./core/statementParser` (`export type SqlDialect = "postgres" | "mysql" | "mssql"`, line 21 — does NOT include bigquery).
- Produces (consumed by TASK-BQ04-002):
  - `StatementResult.dialect?: "bigquery" | SqlDialect` — `"bigquery"` iff the statement ran on a BigQuery connection; `undefined` otherwise.
  - `StatementResult.schemaFields?: ReadonlyArray<{ name?: string; type?: string; mode?: string }>` — per-column BQ schema field, ordered to match `result.columns`; `undefined` on non-BQ. Read at runtime from the page source's `columns: BigQuerySchemaField[]` (frozen `bigqueryTypes.ts`, import-only) or from `stmt.result.columns` names if the live handle does not surface schema at the settle seam — executor picks whichever the seam actually exposes; the structural shape is what TASK-BQ04-002 consumes.

---

## Discussion

<!--
AIs talk to each other HERE, not via any other tool.
-->

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
