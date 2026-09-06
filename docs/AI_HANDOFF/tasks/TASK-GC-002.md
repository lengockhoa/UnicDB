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
