# TASK-RLX-003 — Fail closed on malformed import execution plans

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Reject structurally malformed `DryRunPlan` input before transaction acquisition so import execution cannot guess statement/batch/value alignment or perform partial database work.

## Target Files

- `src/core/importer/importExecute.ts` — validate executable plan cardinality after the existing driver gate but before transaction work; return the existing `ImportExecuteResult` gate-error shape.
- `src/core/importer/__tests__/importExecute.test.ts` — add malformed-plan gate tests while retaining valid transaction regression coverage.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy / unit | valid aligned plan commits | 2 statements/2 batches with ordered values call `beginTransaction()` once, call `tx.runQuery` twice in order, and return `rowCount: 4` with no error. | Existing `plan(2, 2)` fake Postgres adapter. |
| 2 | edge — malformed structure | declared batch lacks SQL statement | Result is `rowCount: 0`, `error.phase: "gate"`, and neither `beginTransaction` nor `adapter.runQuery` is called. | `batches: 2`, one SQL statement, non-empty values. |
| 3 | edge — malformed cardinality | executable plan has no parameter sets | Result is a `gate` error with `rowCount: 0`; no transaction is begun. | `batches: 1`, one INSERT statement, `parameterSets: []`. |
| 4 | regression | valid execution failure rolls back | A second valid batch failure calls rollback once, never commits, and never issues batch three. | Existing `makeTx({ failOnBatch: 2 })` fixture. |

## Test Files

- `src/core/importer/__tests__/importExecute.test.ts` — importer execution gate and transaction regressions.

## Verification Commands

```bash
npx vitest run src/core/importer/__tests__/importExecute.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Empty plans retain their current successful no-op result and acquire no transaction.
- [ ] Non-empty executable plans require positive safe-integer batch count, matching SQL-statement count, and non-empty parameter sets before any driver/transaction effect.
- [ ] Invalid shape returns `ImportExecuteResult.error.phase === "gate"`, rowCount 0, and no SQL effect.
- [ ] Valid PostgreSQL import remains parameterized through `DbTransaction.runQuery(sql, values?)`, commits once on success, and rolls back on execution failure.
- [ ] Tests 1–4 pass after observed RED, and both verification commands pass.

## Dependencies

- none

## Interfaces

- Consumes: `executeImport(plan: DryRunPlan, adapter: DbAdapter, opts?: ImportExecuteOptions): Promise<ImportExecuteResult>` from `src/core/importer/importExecute.ts`; `DryRunPlan` fields `sqlStatements`, `parameterSets`, `batches`, `rowCount`, `totalBytes` from `src/core/importer/importDryRun.ts`; `DbAdapter.beginTransaction?(): Promise<DbTransaction>` from `src/adapters/types.ts`.
- Produces: the existing `ImportExecuteResult` shape, with malformed-plan failures reported as `{ phase: "gate", message: string }` before transaction acquisition.

---

## Discussion

### 2026-08-31 · planner · unic-smart
Validate only structural executable-plan invariants. Do not repair plans, reorder values, alter mapping/dry-run generation, or weaken the existing PostgreSQL-only and INSERT-only guards.

---

## Executor Report

(pending)

## Reviewer Verdict

(pending)
