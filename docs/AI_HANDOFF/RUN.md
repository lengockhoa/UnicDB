Command: handoff-fullstack
Goal: Multi-query SQL execution must auto-stop on error — exit immediately and report the error instead of hanging the connection requiring manual stop.
Base: main
Phase: R1
Cursor: all 3 tasks PASS, copied back, committed; INDEX → pending_review
Next: R2-R4 — code-reviewer per task (parallel), re-run verification, verdicts
QuietScans: 0/2
