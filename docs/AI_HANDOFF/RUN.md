Command: handoff-fullstack
Goal: Add Claude Code + Codex as first-class agents (ACP-based wrapper), parallel omp UKit audit, AIChat panel image+text support across all engines.
Base: main @ d60b743 (release 1.53.23)
Phase: I3
Cursor: Wave 4 complete at fc3729b — TASK-011 (panel dispatch + image pipeline) PASS 102/102. Wave 5 in flight — TASK-012 (extension wiring + command handlers + webview switcher) executor running in its own worktree. Single owner.
Next: wait for TASK-012 notification, copy back, run `npm run compile` for bundle refresh, commit wave 5 checkpoint, then Wave 6 = TASK-014 (integration + env-gated smokes, final task).
