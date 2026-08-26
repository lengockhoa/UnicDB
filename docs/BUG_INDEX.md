# BUG INDEX

Append-only recurring bug signatures.

## Entry format
- Date:
- Signature:
- Repro command:
- Root cause:
- Files changed:
- Tests used:
- Commit/PR:

---

## 2026-08-27 — Worktree copy-back silently loses new files (recurring)

- Signature: `git -C .worktrees/<t> diff --name-only | while read f; do cp "$f" "$f"` — relative destinations vanish; agent work "commits" clean with zero new files.
- Repro command: `cd .worktrees/task-004 && npm run compile` (persists cwd into the worktree), then `git worktree remove` + main-side copy-back with relative paths → `git status` shows nothing new.
- Root cause: the shell's cwd outlives the Bash call and lands INSIDE a worktree that is then deleted; relative destination paths resolve against a nonexistent directory, so `cp` writes into the void while appearing to succeed.
- Files changed: (incident) `src/ui/keysetPaging.ts`, `src/ui/__tests__/keysetPaging.test.ts` — recovered by re-running the executor; fixed the protocol, not a code defect.
- Tests used: `git show HEAD --stat` + `git status` after every copy-back.
- Commit/PR: protocol hardened in Cycle Y — every copy-back batch starts `cd "$ROOT"`, absolute paths BOTH sides, commit BEFORE removing any worktree, verify `git status`/`git show HEAD --stat` before deleting. Related WORKLOG lesson (Cycle H): `git diff --name-only` + `ls-files` also skips gitignored files. Guard: `git status` after copy-back must show the expected M/?? set.
