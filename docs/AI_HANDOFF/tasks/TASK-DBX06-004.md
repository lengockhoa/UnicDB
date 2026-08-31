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

## Reviewer Verdict (unic-smart, cycle reviewer Dbx06Reviewer)

**Round history**:
- Round 1: CHANGES-REQUESTED — non-watch esbuild dropped Compare/ER bundles; Rename Column unavailable on column nodes.
- Round 2 (5cc199e): CHANGES-REQUESTED — objectKey parsing mishandled dotted quoted table names (public.foo.bar → bar).
- Final: **VERDICT: APPROVED** — column nodes carry exact parent objectName; resolveTableNode no longer parses objectKey; regression #8b covers foo.bar with zero introspection calls.

**Verified final behavior** (reviewer): focused DBX-06 Vitest 38/38; validateNewName guards before adapter acquisition; 4 catalog SQL builders bind $1/$2 (no WHERE interpolation); collision query covers r/v/m/S/i; buildRenamePlan short-circuits same-name/collision; runner polls cancel before each statement and reports applied/failedAt/error/failedStatement; webview DOM-only with compiled-bundle sink regression; commands guard PostgreSQL first; esbuild retains compare/er/rename bundles. Suite 2610 passed | 2 skipped; typecheck 0; esbuild clean.

**Residual notes**: none (webview source uses approved DOM-only pattern; test-only eval/innerHTML harness is not production code).

**Final: VERDICT: APPROVED** (all tasks TASK-DBX06-001..004 APPROVED).
