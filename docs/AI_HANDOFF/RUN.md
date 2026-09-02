Command: handoff-fullstack
Goal: Ship CL-01 cleanup cycle — close 6 documented follow-ups from STATUS.md backlog (MSSQL bracket, ARP-07 invalidation wiring, snapshot name cap, BQ R4.5 minors).
Base: main @ 611df12
Phase: I3
Cursor: P0 → P1 (lite summary) → P2 (planner 4-task plan, 12/12 self-audit; dropped item 1 + 7) → P2.5 r1 (Approved, 0c/0i/2m) → P3 (fe7e0b8 plan commit) → I1/I2 (clean tree, 4 tasks wave 1, disjoint files) → I3 wave 1 (4 parallel feature-implementer: CL-001..004 all PASS sonnet; 3c copy-back needed recovery via dangling-commit checkout for CL-001/002/003 source because worktree commits landed but main cp step ran on HEAD~ missing the source commits — fixed, suite 3283|2 GREEN, +32 new tests)
Next: I4 (consolidate INDEX: 4 tasks ready → pending_review) → R1 (read INDEX/ACTIVE + diff stat) → R2 (4 parallel code-reviewer on opus) → R3 (re-run verification) → R4 (unified diff review + verdict per task) → R4.5 (auto-fix loop, max 2 rounds) → R5 (CHANGELOG + version bump 1.47.0→1.48.0 + tag + push + vsce package + gh release)
