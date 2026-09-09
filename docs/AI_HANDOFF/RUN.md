Command: handoff-fullstack
Goal: Split results toolbar into exactly 2 rows — row 1 keeps icon buttons + tsv; row 2 holds WHERE/ORDER BY/run/clear/header/copy/export/chip/Search
Base: main @ 7e29d2e (v1.53.38)
Phase: I3
Cursor: Wave 1 implementation completed in `.worktrees/task-collapse-002`; targeted verification passed, full suite has unrelated pre-existing failures. Executor report appended; ready for orchestrator copy-back and review.
Constraints: USER OVERRIDE on version bump — patch v1.53.39 + publish at R5
Next: Copy the 6 toolbar source/test files plus fixed syntax brace and task report back; remove worktree/branch; run targeted verification on main, then commit wave and continue I4/R1-R5.
