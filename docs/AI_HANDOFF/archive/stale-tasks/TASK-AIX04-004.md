# TASK-AIX04-004 — scaffold hygiene + CHANGELOG/README

Cycle: AIX-04 · Wave 4 · Priority: P2
Status: done
Depends on: AIX04-003
Reviewer: unic-smart (cycle reviewer)

## Spec

1. `src/__tests__/aix04Scaffold.test.ts`:
   - `src/ai/changePlan.ts` + `src/ai/tools/changePlanTool.ts`: no vscode
     import (import-regex), no fs/child_process, no `shell: true`, no
     execSync.
   - plan_change registered via `createChangePlanTools(f)` (name in list).
   - exports present: classifyStatements, validatePlanStatements,
     detectDrift, createPlanChangeTool, createChangePlanTools.
2. CHANGELOG.md `## [1.24.0]` section + compare link v1.23.0...v1.24.0.
3. README.md bullet after the 1.23.0 bullet.

## Acceptance

- [ ] Scaffold tests green; full `npm test`; `npm run typecheck` 0;
      `npm run compile` clean.

## Executor

**RED**: file absent — no scaffold coverage for AIX-04 pure modules / wire
kinds / dual registry / shared consent gate.

**GREEN**: `npx vitest run src/__tests__/aix04Scaffold.test.ts` → Tests 6
passed (6): no vscode import in changePlan/changePlanTool; no shell/fs/
child_process; exports present; createChangePlanTools registered twice
(builtin + OMP); change_plan/plan_approve/plan_reject wire kinds;
extension.ts re-exports consent (no local TASK-606 modal copy).

Docs: CHANGELOG 1.24.0 section + compare link (and restored missing
1.10/1.11/1.12/1.13/1.19 links); README bullet after 1.23.0.

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
