Command: handoff-fullstack
Goal: Add Claude Code + Codex as first-class agents (ACP-based wrapper), parallel omp UKit audit, AIChat panel image+text support across all engines.
Base: main @ d60b743 (release 1.53.23)
Phase: I3
Cursor: Wave 3 complete at d700f3b — TASK-009 (claudeCodeChatEngine) PASS 7/7, TASK-010 (codexChatEngine) PASS 11/11. Wave 4 in flight — TASK-011 (panel dispatch + image pipeline, single owner) executor running in its own worktree. Big blast radius (central aiChatPanel.ts).
Next: wait for TASK-011 notification, copy back, commit wave 4 checkpoint, then Wave 5 = TASK-012 (extension wiring + chat webview switcher), then Wave 6 = TASK-014 (integration + env-gated smokes).
