# TASK-AIX04-001 — changePlan pure module

Cycle: AIX-04 · Wave 4 · Priority: P1
Status: done
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

**RED**: `Failed to load url ../changePlan ... Does the file exist?` —
Tests no tests.

**GREEN**: `npx vitest run src/ai/__tests__/changePlan.test.ts` →
Tests 11 passed (11).

Notes:
- classifyStatements reuses analyzeStatement + guardTier verbatim — the
  plan carries the SAME danger semantics as the confirm path.
- validatePlanStatements uses splitStatements(sql, dialect).

## Reviewer

(verdict appended by reviewer)

## Reviewer Verdict (unic-smart, cycle reviewer Aix04Reviewer)

### Round 1 — CHANGES-REQUESTED
1. TASK-AIX04-002 — both `createChangePlanTools` registrations omitted the live fingerprint → factory fallback `[]` flagged every targeted plan stale (Approve disabled).
2. TASK-AIX04-003 — approval split only for consent; raw candidate strings went to the runner → progress/cancel/failure not per actual statement; a raw `SELECT; DROP` candidate could render one safe-tier card item.
3. TASK-AIX04-004 — scaffold did not statically guard `appendChangePlan` against innerHTML/outerHTML/insertAdjacentHTML/eval/new Function.

### Round 2 — re-review
Fixes 1+2 (live `adapter.listColumns` fingerprints in both registries; flatten candidates for the runner; `planCancelled` Stop signal + cancellation test; scoped webview unsafe-sink assert). One remaining: `classifyStatements` still ran on raw candidates.

### Round 3 — final re-review
`changePlanTool` flattens each valid candidate with `splitStatements` before drift/classification; regression asserts `SELECT; DROP` → two items none/red with zero runQuery.

### Verified behavior
- plan_change NEVER executes (runQuery pinned at 0); target fingerprints live.
- ONE shared consent gate (`src/ui/confirmDangerous.ts`) precedes every panel runQuery; drift re-checked at approve; sequential runner reports per-statement progress/partial failure; Stop reports cancellation; both registries gate-wrapped.
- No `as any`/`: any`, `shell:true`, `execSync`, or `child_process` additions in changed production modules; plan card is DOM/textContent-only; task docs carry RED/GREEN evidence.
- Reviewer did not independently run the suite/typecheck/compile (read-only source/diff verification).

### Final per-task verdicts
- TASK-AIX04-001: APPROVED
- TASK-AIX04-002: APPROVED
- TASK-AIX04-003: APPROVED
- TASK-AIX04-004: APPROVED

**Final: VERDICT: APPROVED**
