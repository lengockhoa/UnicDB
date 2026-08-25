# ACTIVE

Cycle: S   Date: 2026-08-25   Base: main
Goal: Fix `Error: column "ctid" does not exist` when opening PG views/matviews/foreign tables in the Results grid by removing the eager no-PK ctid browse wrap, and resolve ctid lazily at save time (updates + deletes) via the existing fetchPostgresCtids value-match path.
Tasks: 3 total
Status: planning_done — ready for executor (W1 = TASK-001/003 parallel; W2 = TASK-002)
