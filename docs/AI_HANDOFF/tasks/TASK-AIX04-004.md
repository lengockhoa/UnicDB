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
