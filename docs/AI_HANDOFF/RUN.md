Command: handoff-fullstack
Goal: Fix `Error: column "ctid" does not exist` on opening views — stop eager ctid wrapping; resolve ctid lazily only at update/delete time
Base: main
Phase: I3
Cursor: wave 1 done — TASK-001 PASS, TASK-003 PASS (commit 4489b34); context checkpoint: wave 1 collapsed, 2 tasks summarized
Next: wave 2 — TASK-002 (resultsPanel lazy ctid save path; dep TASK-003 satisfied)
