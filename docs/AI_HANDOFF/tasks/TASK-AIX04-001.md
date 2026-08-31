# TASK-AIX04-001 — changePlan pure module

Cycle: AIX-04 · Wave 4 · Priority: P1
Status: pending
Depends on: —
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/ai/changePlan.ts` — PURE (no vscode, no fs, no net):

1. `classifyStatements(sql: string[]): PlanStatement[]` where
   PlanStatement = `{sql, kind, hasWhere, tier, dangerNote}`:
   - per statement: `analyzeStatement(sql)` + `guardTier(...)` from
     `src/core/dangerousStatement.ts`
   - `dangerNote` set for tier red (`"destructive — will be confirmed"`)
     and admin-red (`"admin DCL — separate consent required"`); empty
     string otherwise.
2. `validatePlanStatements(sql: unknown): string[]` — errors, empty when
   valid:
   - not an array / empty → "at least one SQL statement required"
   - each element a non-empty string
   - each splits into ≥1 statement via `splitStatements(sql, dialect)`
3. `detectDrift(current: string[], claimed: string[]): string[]` —
   symmetric difference of column-name sets, sorted (stale-plan guard).

## Acceptance

- [ ] classifyStatements: DELETE w/o WHERE → red + dangerNote;
      UPDATE w/ WHERE → none; DROP → red; GRANT → admin-red; SELECT → none.
- [ ] validatePlanStatements: empty/missing/blank → errors; multi-line
      valid SQL passes.
- [ ] detectDrift: missing/extra/renamed columns reported; identical sets
      → [].
- [ ] `npx vitest run src/ai/__tests__/changePlan.test.ts` green.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
