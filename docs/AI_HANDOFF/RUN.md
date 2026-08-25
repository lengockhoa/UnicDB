Command: handoff-fullstack
Goal: Unbreak the VSDB core — make table edit/save actually work and make AI chat + omp usable zero-config
Base: main
Phase: R4.5
Cursor: R1-R3 done — 4 opus reviewers over f8d088e..HEAD returned CRITICAL/CHANGES-REQUESTED/CHANGES-REQUESTED/CRITICAL; ~20 findings incl. 2 regressions this cycle introduced (data-modifying CTE -> DECLARE CURSOR; END WHILE pops BEGIN) and 1 critical found twice (30s bound on session/prompt)
Next: auto-fix round 1 of 2 — FIX-A (save/grid) + FIX-B (AI/omp) in parallel worktrees, then FIX-C (parser/adapters)
