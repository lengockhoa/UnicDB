Command: handoff-fullstack
Goal: Ship ARP-02 Shutdown-safe query ownership and connection provenance (fault-injection proof that late work cannot leak across close/deactivate/connection-change).
Base: main @ 367cb80 (v1.37.0)
Phase: I3
Cursor: wave 1 done — commit f2d92ff, 110/110 focused cross-verified; all 3 tasks PASS. TASK-ARP02-004 gate OPEN: executor 002 recorded real host gaps (runStatements finally-busy leak, deactivate ordering in extension.ts)
Next: wave 2 — worktree for TASK-ARP02-004 (host integration), single feature-implementer.
