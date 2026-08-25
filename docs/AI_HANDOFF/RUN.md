Command: handoff-fullstack
Goal: Fix `Error: column "ctid" does not exist` on opening views — stop eager ctid wrapping; resolve ctid lazily only at update/delete time
Base: main
Phase: R4.5
Cursor: fix round 1 done — TASK-001 tests #7b/#8b restored (commit e7db2ae); T2/T3 already approved
Next: re-review TASK-001 only (fresh code-reviewer, must differ from unic/unic-code)
