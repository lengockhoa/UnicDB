# TASK-GC-002 — Git diff source adapter (vscode.git extension API)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3

## Goal

New adapter that turns the active git repository's pending changes into a truncated,
prompt-ready diff via the vscode.git extension API (`getExtension('vscode.git').exports.getAPI(1)`),
plus the two SCM seams the command needs: repository lookup and the commit input box.
Structural interfaces keep it unit-testable without the real git extension.

## Target Files

- `src/adapters/gitDiff.ts` (new) — exports:
  - `GitUriLike { fsPath: string }`, `GitChangeLike { uri: GitUriLike }`,
    `GitRepositoryLike { rootUri: GitUriLike; diff(cached?: boolean): Promise<string>;
    state: { HEAD?: { name?: string }; indexChanges: readonly GitChangeLike[];
    workingTreeChanges: readonly GitChangeLike[]; mergeChanges?: readonly GitChangeLike[] };
    inputBox: { value: string } }`, `GitApiLike { repositories: readonly GitRepositoryLike[] }`
    (structural subsets of the real vscode.git d.ts — real instances assign cleanly).
  - `getGitApi(): GitApiLike | undefined` — the only vscode-bound function
    (`vscode.extensions.getExtension<{ getAPI(id: number): GitApiLike }>("vscode.git")`
    → `.exports.getAPI(1)`; guard `isActive`/undefined exports).
  - `pickRepository(api: GitApiLike | undefined): GitRepositoryLike | null` — `repositories[0] ?? null`
    (multi-repo picker out of scope, PLAN §2).
  - `GIT_DIFF_MAX_BYTES = 12_288` (12 KB) + local pure truncation used by `collectCommitDiff`.
  - `interface CommitDiffInput { repoName: string; branch?: string; files: string[]; diffText: string }`.
  - `collectCommitDiff(repo: GitRepositoryLike): Promise<CommitDiffInput | null>` —
    algorithm (frozen): staged = `await repo.diff(true)`; if `trim()` non-empty use it,
    else unstaged = `await repo.diff()`; if that trims empty → `null`. `files` = repo-relative
    paths from `state.indexChanges` + `workingTreeChanges` + `mergeChanges` (deduped; `[]`
    when state is unavailable). `repoName` = basename of `rootUri.fsPath`; `branch` =
    `state.HEAD?.name` when present. `diffText` truncated at `GIT_DIFF_MAX_BYTES` with a
    trailing `\n… [diff truncated]` marker.
- `src/adapters/__tests__/gitDiff.test.ts` (new) — fakes implement `GitRepositoryLike`; mock
  `vscode` only for `getGitApi` cases (`vi.mock("vscode", ...)` — see
  `src/ui/__tests__/aiSettingsForm.test.ts` for the mock idiom).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | staged diff preferred | `collectCommitDiff` returns `diffText` = staged text, `repoName` = "UnicDB", `branch` = "main", files deduped repo-relative | repo with staged + unstaged text |
| 2 | edge (empty) | nothing to commit → null | staged and unstaged both whitespace → returns `null` | `diff()` returns "   \n  " |
| 3 | edge (boundary) | falls back to unstaged | staged empty string → `diffText` = unstaged text | `diff(true)` = "", `diff()` = "diff --git …" |
| 4 | edge (boundary) | 12 KB truncation | 20 KB staged diff → `diffText.length` ≤ 12 KB + marker, ends with "[diff truncated]" | oversized diff string |
| 5 | edge (missing data) | state fields absent tolerated | repo without `HEAD`/changes still returns diff with `branch` undefined, `files: []` | minimal fake repo |
| 6 | happy | getGitApi + pickRepository | extension exports resolve → `pickRepository` returns `repositories[0]`; no extension / empty list → `undefined` / `null` | mocked `vscode.extensions` |

## Test Files

- `src/adapters/__tests__/gitDiff.test.ts` (new) — contains tests #1–#6.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/adapters/__tests__/gitDiff.test.ts
```

(No lint script exists in this project — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] All tests #1–#6 green; `npm run typecheck` clean.
- [ ] `gitDiff.ts` imports vscode ONLY inside `getGitApi`'s module scope (rest is pure/structural).
- [ ] Real vscode.git `Repository` instances structurally satisfy `GitRepositoryLike` (no `any`).
- [ ] No SQL/adapter factory changes — `src/adapters/factory.ts` untouched.

## Dependencies

- (none)

## Interfaces

- Consumes: vscode.git extension API shape (`GitExtension.exports.getAPI(1)`) — structural,
  no import from the real d.ts.
- Produces (GC-007 consumes): `collectCommitDiff(repo): Promise<CommitDiffInput | null>`,
  `pickRepository(api): GitRepositoryLike | null`, `getGitApi(): GitApiLike | undefined`,
  and `repo.inputBox.value` as the commit-message injection point. `CommitDiffInput` shape is
  structurally identical to GC-003's inline prompt-input parameter (frozen text in both files).

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: `diff(cached?: boolean)` semantics are from the official vscode.git d.ts:
`diff(true)` = index vs HEAD (staged), `diff()` = working tree vs index (unstaged). Do not
shell out to the `git` CLI. Untracked-only changes produce an empty `diff()` — that is the
accepted limitation (PLAN §2); the command surfaces "no changes" for it, which is honest.

(no comments yet)

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-002

 ❯ src/adapters/__tests__/gitDiff.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/adapters/__tests__/gitDiff.test.ts [ src/adapters/__tests__/gitDiff.test.ts ]
Error: Failed to load url vscode (resolved id: vscode) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-002/src/adapters/__tests__/gitDiff.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
```
(Suite failed to load because `gitDiff.ts` did not yet exist; after adding
`vi.mock("vscode", ...)` the suite loaded and tests #1-#5 (which don't depend
on `vscode`) failed with `Cannot find module '../gitDiff'`. After implementing
`src/adapters/gitDiff.ts`, all 12 cases pass.)

Verification Output:
```
$ npm run typecheck
> UnicDB@1.51.7 typecheck
> tsc --noEmit
(exit 0, no output)

$ npx vitest run src/adapters/__tests__/gitDiff.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-002
 ✓ src/adapters/__tests__/gitDiff.test.ts  (12 tests) 2ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
(exit 0)

$ npm test  (worktree summary; bundle tests require npm run compile — pre-existing)
 Test Files  8 failed | 209 passed | 29 skipped (246)
      Tests  20 failed | 3292 passed | 243 skipped (3555)
(The 8 failing files are bundle/webview tests that read `dist/*.js` artifacts
which do not exist in this worktree — same failures occur on a fresh worktree
of `main` before `npm run compile`. None of the failures touch `src/adapters/`
or the new `gitDiff.ts`; my gitDiff test passes and so does every other
`src/adapters/__tests__/*.test.ts` suite.)
```
Status: PASS
Note: All 6 required test cases from §Test Cases green (split into 12 vitest
cases). `getGitApi` is the only function that touches `vscode`; everything else
in `gitDiff.ts` is pure structural code. The 12 KB truncation reserves room for
the marker so the final string is always `≤ GIT_DIFF_MAX_BYTES + marker.length`.
Multi-repo picker is intentionally `repositories[0] ?? null` per PLAN §2.
