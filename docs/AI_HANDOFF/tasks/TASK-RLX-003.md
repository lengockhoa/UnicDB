# TASK-RLX-003 — Fail closed on malformed import execution plans

- Status: `pending_review`
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

### 2026-08-31 · executor · claude-code · unic-code · feature-implementer

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/core/importer/__tests__/importExecute.test.ts (before implementation):

   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-rlx-003

   ❯ src/core/importer/__tests__/importExecute.test.ts  (15 tests | 2 failed) 9ms
     ❯ executeImport — structural plan gate > declared batch lacks SQL statement → gate error, no transaction
       → expected 2 to be +0 // Object.is equality
     ❯ executeImport — structural plan gate > executable plan with no parameter sets → gate error, no transaction
       → expected undefined to be 'gate' // Object.is equality

   FAIL  executeImport — structural plan gate > declared batch lacks SQL statement → gate error, no transaction
   AssertionError: expected 2 to be +0 // Object.is equality
    ❯ src/core/importer/__tests__/importExecute.test.ts:251:29
        249|     };
        250|     const result = await executeImport(malformed, adapter);
        251|     expect(result.rowCount).toBe(0);
        |                             ^

   FAIL  executeImport — structural plan gate > executable plan with no parameter sets → gate error, no transaction
   AssertionError: expected undefined to be 'gate' // Object.is equality
    ❯ src/core/importer/__tests__/importExecute.test.ts:271:33
        269|     const result = await executeImport(malformed, adapter);
        270|     expect(result.rowCount).toBe(0);
        271|     expect(result.error?.phase).toBe("gate");

    Test Files  1 failed (1)
         Tests  2 failed | 13 passed (15)

  RED analysis: both failures are exactly the malformed-plan contract gap — the old code
  executed partial work (rowCount 2, began a transaction) for the mismatched
  statement/batch plan, and silently no-opped (no error at all) for the
  batches>0/parameterSets=[] plan. Test 1 (valid aligned 2/2) and Test 4 (regression:
  mid-batch failOnBatch=2 rollback) already existed in the test file and passed both
  before and after — kept as regressions, not duplicated.
Verification Output: |
  Command 1 — npx vitest run src/core/importer/__tests__/importExecute.test.ts (after implementation):

   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-rlx-003

   ✓ src/core/importer/__tests__/importExecute.test.ts  (15 tests) 5ms

   Test Files  1 passed (1)
        Tests  15 passed (15)
   Start at  20:48:36
   Duration  172ms

  Command 2 — npm run typecheck:

   > vsdb@1.26.0 typecheck
   > tsc --noEmit

   TYPECHECK_EXIT=0

  Extra shared-scope regression (same lane, 1 caller in src/ui/importWizard.ts):
  npx vitest run src/core/importer

   ✓ src/core/importer/__tests__/importCsv.test.ts      (10 tests) 2ms
   ✓ src/core/importer/__tests__/importDryRun.test.ts    (6 tests) 3ms
   ✓ src/core/importer/__tests__/importMapping.test.ts  (10 tests) 3ms
   ✓ src/core/importer/__tests__/importExecute.test.ts  (15 tests) 5ms
   ✓ src/core/importer/__tests__/importJson.test.ts      (7 tests) 2ms

   Test Files  5 passed (5)
        Tests  48 passed (48)

  Implementation note: the structural gate was added AFTER the driver gate and the
  INSERT-only statement gate, BEFORE adapter.beginTransaction(). A truly empty plan
  (batches=0 AND statements=0 AND values=0) keeps the successful no-op; every
  non-empty plan must satisfy Number.isSafeInteger(batches) && batches >= 1 &&
  sqlStatements.length === batches && parameterSets.length > 0, else it returns
  { rowCount: 0, errors: [], error: { phase: "gate", message } } with no transaction
  and no adapter.runQuery. Valid plans are untouched: same values order, same
  chunking, same BEGIN/COMMIT/ROLLBACK flow. Verified importDryRun's
  buildDryRunPlan always emits batches === sqlStatements.length, so no legitimately
  built plan can be rejected by the new gate.
Status: PASS
Note: none

## Reviewer Verdict

(pending)

## Executor Report (fix round 1)

### 2026-08-31 · executor · claude-code · unic-code (main session)

EXECUTOR_TOOL: claude-code (main session)
EXECUTOR_MODEL: unic-code

Fix applied: The structural gate in `src/core/importer/importExecute.ts` now reports the offending plan entry index (0-based, matching plan array order) plus the concrete per-case reason instead of counts only. Reasons: `invalid batch count batches=N` for non-safe-integer/`<1`; `statement <idx> is missing` when `sqlStatements.length < batches`; `statement <idx> is unexpected` when `> batches`; `statement 0 has empty parameterSets (parameterSets=N)` for the empty-parameterSets case. Gate stays fail-closed before `beginTransaction()`, empty-plan no-op and valid-plan behavior untouched.

RED_OUTPUT (index/reason assertions against the round-1 implementation):
|
  npx vitest run src/core/importer/__tests__/importExecute.test.ts (before fix):

   ❯ src/core/importer/__tests__/importExecute.test.ts  (15 tests | 2 failed) 9ms
     ❯ executeImport — structural plan gate > declared batch lacks SQL statement → gate error, no transaction
       → expected 'Malformed executable plan: batches=2, statements=1, parameterSets=2 (…)' to contain 'statement 1 is missing'
     ❯ executeImport — structural plan gate > executable plan with no parameter sets → gate error, no transaction
       → expected 'Malformed executable plan: batches=1, statements=1, parameterSets=0 (…)' to contain 'statement 0 has empty parameterSets'

   FAIL src/core/importer/__tests__/importExecute.test.ts > … > declared batch lacks SQL statement → gate error, no transaction
   AssertionError: expected 'Malformed executable plan: batches=2,…' to contain 'statement 1 is missing'

    - Expected
    + Received

    - statement 1 is missing
    + Malformed executable plan: batches=2, statements=1, parameterSets=2 (expected batches ≥ 1, one INSERT statement per batch, and at least one parameter set)

    ❯ src/core/importer/__tests__/importExecute.test.ts:257:35

   FAIL src/core/importer/__tests__/importExecute.test.ts > … > executable plan with no parameter sets → gate error, no transaction
   AssertionError: expected 'Malformed executable plan: batches=1,…' to contain 'statement 0 has empty parameterSets'

    ❯ src/core/importer/__tests__/importExecute.test.ts:280:35

    Test Files  1 failed (1)
         Tests  2 failed | 13 passed (15)

Verification: npx vitest run src/core/importer/__tests__/importExecute.test.ts → 15 passed (15), 1 file passed. npm run typecheck → tsc --noEmit, exit 0.

Status: PASS
