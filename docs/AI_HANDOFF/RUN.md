Command: handoff-fullstack
Goal: Add Claude Code + Codex as first-class agents (ACP-based wrapper), parallel omp UKit audit, AIChat panel image+text support across all engines.
Base: main @ d60b743 (release 1.53.23)
Phase: I3
Cursor: Wave 1 Batch 1 done — TASK-001 (engine vocab) PASS after orchestrator-applied typecheck fix (commitGenCommand.ts:125 widened to AiEngine); TASK-002 (claude detect) PASS; typecheck clean, 36 in-scope tests green.
Next: spawn Wave 1 Batch 2 = TASK-003 (codex detect) + TASK-013 (manifest) in parallel, then Batch 3 = TASK-004 (omp audit, read-only).
