Command: handoff-fullstack
Goal: WHERE / ORDER BY inputs in the Results toolbar (Enter = server-side re-run) + toolbar hover polish (drop native title-tooltip flicker + instant background flash).
Base: main @ accf1b5 (v1.53.26)
Phase: R1
Cursor: All 3 waves done. Wave 1 = RES-001 + RES-002 committed at 109008b (cleanup f078391). Wave 2 = RES-003 copy-backed from .worktrees/task-res-003 (worktree + branch handoff/task-res-003 deleted). INDEX.md updated: all 3 tasks → pending_review. Full suite: 4081 passed | 4 skipped (no regressions). wave-2 status about to commit.
Next: commit wave 2; then R1 (lite agent reads ACTIVE+INDEX, runs git status + git diff --stat, resolves PLAN_COMMIT review range); then R2 (model isolation check on 3 task executor reports); then R3 (re-run typecheck + targeted vitest for all 3); then R4 batch reviewers (max 2 parallel — batch 1 RES-001 + RES-002, batch 2 RES-003); then R4.5 auto-fix (max 2 rounds if any changes_requested); then R5 (push + INDEX done/blocked + STATUS/WORKLOG refresh).
