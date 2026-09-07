Command: handoff-fullstack
Goal: Add Claude Code + Codex as first-class agents (ACP-based wrapper), parallel omp UKit audit, AIChat panel image+text support across all engines.
Base: main @ d60b743 (release 1.53.23)
Phase: I3
Cursor: Wave 2 Batch 1 checkpointed at 68a788f — TASK-005 (claudeCode process) PASS 5/5, TASK-006 (codex process) PASS 10/10. Wave 2 Batch 2 in flight — TASK-007 (engineChoice policy) + TASK-008 (settings form UI 4-engine dropdown) executors running in parallel worktrees.
Next: wait for both notifications, copy back, commit wave 2 checkpoint (this completes wave 2 = 4 tasks), then wave 3 = TASK-009 + TASK-010 in parallel.
