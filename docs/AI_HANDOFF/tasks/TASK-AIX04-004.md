# TASK-AIX04-004 — scaffold hygiene + CHANGELOG/README

Cycle: AIX-04 · Wave 4 · Priority: P2
Status: pending
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

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
