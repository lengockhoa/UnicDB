Command: handoff-fullstack
Goal: Multi-query SQL execution must auto-stop on error — exit immediately and report the error instead of hanging the connection requiring manual stop.
Base: main
Phase: I3
Cursor: wave 1 batch 1 done (001+002 PASS, copied back, committed); batch 2 TASK-SQLHANG-003 spawning
Next: I3 batch 2 executor → copy-back → I4
QuietScans: 0/2
