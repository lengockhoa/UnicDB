# TASK-DBX06-004 — scaffold hygiene + CHANGELOG/README

Cycle: DBX-06 · Wave 4 · Priority: P2
Status: done
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

**Scaffold tests** (dbx06Scaffold.test.ts): 12/12 green — pure modules
are vscode-free, SQL builders parameterized with no `${schema}`-style
substitution, exports present, package.json declares both commands, all
cycle files exist.

**Cycle close**: `npm test` 2608 passed | 2 skipped (199 files);
`npm run typecheck` 0; `npm run compile` esbuild clean.

**CHANGELOG**: `## [1.23.0] — 2026-08-31` section + compare link
`v1.22.0...v1.23.0` (re-inserted 1.18/1.20/1.21 link rows that earlier
edits had dropped).

**README**: bullet after the 1.22.0 line — Safe Rename Refactor summary.

## Reviewer

(verdict appended by reviewer)
