# TASK-DBX06-004 — scaffold hygiene + CHANGELOG/README

Cycle: DBX-06 · Wave 4 · Priority: P2
Status: pending
Depends on: DBX06-003
Reviewer: unic-smart (cycle reviewer)

## Spec

1. `src/__tests__/dbx06Scaffold.test.ts`:
   - renameAnalysis.ts / renameCatalog.ts: NO vscode import (import-regex),
     no fs/child_process, no `shell: true`, no execSync.
   - renameCatalog SQL builders: no identifier interpolation into WHERE
     (assert `$1`/`$2` present and identifier fragments absent).
   - Exports present: validateNewName, analyzeUsage, the 4 SQL builders,
     buildRenamePlan.
   - package.json: `vsdb.renameTable` + `vsdb.renameColumn` declared in
     contributes.commands.
2. CHANGELOG.md `## [1.23.0]` section + compare link v1.22.0...v1.23.0.
3. README.md bullet after the AIX-03 bullet.

## Acceptance

- [ ] Scaffold tests green; full `npm test`; `npm run typecheck` 0;
      `npm run compile` clean.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
