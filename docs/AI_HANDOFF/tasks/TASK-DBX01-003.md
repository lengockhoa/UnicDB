# TASK-DBX01-003 — Import execute module (mocked adapter + transaction)

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX01.md` §4 (Test Plan), §2 Scope, §3 Approach 6

## Goal

Write RED tests first, then implement `importExecute.ts` — the one and only module in the importer that touches a `DbAdapter`. It runs the dry-run plan inside a single transaction (`DbTransaction`), respecting the existing `dangerousStatement` guard, batching INSERTs, and producing a typed `ImportExecuteResult` that the wizard surfaces to the user. Roll back on any mid-batch failure; never truncate oversized rows; never call `adapter.runQuery` for anything other than the plan statements.

## Target Files

- `src/core/importer/importExecute.ts` **(new)** — `executeImport(plan, adapter, opts?)` async function.
- `src/core/importer/__tests__/importExecute.test.ts` **(new)** — execute contract with mocked `DbTransaction`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | happy path: BEGIN + N batched INSERTs + COMMIT | transaction method sequence is `runQuery` ×N then `commit`; `rollback` never called | dry-run plan with 3 batches |
| 2 | unit | sends plan parameterSets in order | spy transaction sees `[$1..$N]` per statement matching `parameterSets[i]` | 2 batches × 3 rows |
| 3 | edge | mid-batch failure → ROLLBACK, no further runQuery | sequence ends with `rollback`; inserted batch count stops at the failed batch | 3rd batch throws |
| 4 | edge | oversized row is reported as a per-row error, not an exception | `result.errors[0].message` names the row index, no throw | `MAX_BATCH_BYTES` exceeded by one row |
| 5 | regression | never calls `adapter.runQuery` for anything except plan statements | `runQuery` call count == `plan.batches` | happy path + transactional spies |
| 6 | edge | non-PostgreSQL adapter → result has `errors[0]` mentioning driver gate, no transaction started | `adapter.beginTransaction` not called | `driver: "mysql"` |
| 7 | unit | returns `rowCount === sum of inserted batch sizes` on success | `result.rowCount` matches plan | happy path |
| 8 | edge | BEGIN failure (e.g. `adapter.beginTransaction` rejects) → ImportExecuteResult with fatal error | result.error names the phase, no INSERT issued | begin fails |
| 9 | unit | uses default batch size 1000 when no opts provided | one statement per 1000 rows | plan with 2500 rows |
| 10 | regression | respects dangerousStatement gate | module imports `analyzeStatement` and refuses to run a plan that contains DROP/DELETE/ALTER | dry-run forged with DROP column |
| 11 | edge | empty plan (zero rows) → no transaction, returns `rowCount: 0, errors: []` | `beginTransaction` not called | `plan.batches: 0` |
| 12 | unit | COMMIT failure → result.error names the phase, no partial state surfaced | `result.error.phase === "commit"` | commit rejects |

## Test Files

- `src/core/importer/__tests__/importExecute.test.ts` — cases 1–12.

## Verification Commands

```bash
npx vitest run src/core/importer/__tests__/importExecute.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] RED output recorded; all 12 cases green.
- [ ] No `vscode` import, no `as any`/`: any`, no second transaction wrapper.
- [ ] One and only one `runQuery` channel into the adapter (the `DbTransaction`).
- [ ] Funnels through `analyzeStatement` for the dangerous-statement gate; rejects non-INSERT plans.
- [ ] Never truncates a row — reports and skips.

## Dependencies

- TASK-DBX01-001 + TASK-DBX01-002 must complete first.

## Interfaces

- Consumes (from earlier tasks): `DryRunPlan`, `MappedRows`.
- Consumes (from existing repo):
  - `import { DbAdapter, DbTransaction } from "../../adapters/types";`
  - `import { analyzeStatement } from "../dangerousStatement";`
- Produces (for DBX01-004):
  - `interface ImportExecuteOptions { maxBatchBytes?: number; defaultBatchSize?: number }`
  - `interface ImportExecuteResult { rowCount: number; errors: ImportRowError[]; error?: { phase: "begin"|"runQuery"|"commit"; message: string } }`
  - `async function executeImport(plan: DryRunPlan, adapter: DbAdapter, opts?: ImportExecuteOptions): Promise<ImportExecuteResult>`
  - Default `maxBatchBytes = 1_048_576`; default `defaultBatchSize = 1000`.

---
## Discussion

(no comments yet)

---
