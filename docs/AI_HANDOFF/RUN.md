Command: handoff-fullstack
Goal: Add Claude Code + Codex as first-class agents (ACP-based wrapper), parallel omp UKit audit, AIChat panel image+text support across all engines.
Base: main @ d60b743 (release 1.53.23)
Phase: I3
Cursor: Wave 1 Batch 2 checkpointed at ad7360b — TASK-003 (codex detect) PASS 12/12, TASK-013 (manifest) PASS 19/19, typecheck clean. Wave 1 Batch 3 in flight — TASK-004 (omp audit, read-only) executor running.
Next: wait for TASK-004 notification, append findings to TASK-004.md (verify `git diff --stat -- src/ai/omp` empty), then commit wave 1 checkpoint + proceed to wave 2 (TASK-005/006/007/008 in 2 batches).
