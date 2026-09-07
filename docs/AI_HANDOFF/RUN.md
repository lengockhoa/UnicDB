Command: handoff-fullstack
Goal: Add Claude Code + Codex as first-class agents (ACP-based wrapper), parallel omp UKit audit, AIChat panel image+text support across all engines.
Base: main @ d60b743 (release 1.53.23)
Phase: I3
Cursor: Wave 2 Batch 1 partial — TASK-006 (codex process) PASS, claude-sonnet-4-5, 10/10 tests green, files copied back + branch handoff/task-006 deleted; TASK-005 (claudeCode process) still running.
Next: wait for TASK-005 notification, copy back, commit wave 2 batch 1 checkpoint, then Wave 2 Batch 2 = TASK-007 (engineChoice) + TASK-008 (settings form UI) in parallel.
