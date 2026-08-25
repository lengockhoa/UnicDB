Command: handoff-fullstack
Goal: Unbreak the VSDB core — make table browse/edit/save actually work (ctid, no-PK, views, save path) and make AI chat + omp usable zero-config
Base: main
Phase: P2
Cursor: P0 done — 4 decisions locked (cycle 1 = unbreak-only; omp default zero-config; coloring=injection+semantic deferred to cycle 2; per-table tabs = top parity item, cycle 2). Cycle S absorbed.
Next: spawn handoff-planner to write PLAN.md + TASK files for the unbreak cycle (overwrite cycle S — all its tasks are `ready`, guard permits)
