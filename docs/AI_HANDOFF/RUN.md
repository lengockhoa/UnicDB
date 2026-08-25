Command: handoff-fullstack
Goal: Unbreak the VSDB core — make table edit/save actually work and make AI chat + omp usable zero-config
Base: main
Phase: R4.5
Cursor: R4 re-review done — both opus reviewers returned CHANGES-REQUESTED; round 1 closed both original CRITICALs (Add Row data loss, 30s ACP prompt bound) but introduced 5 new defects, incl. 2 CRITICAL construct-stack regressions in statementParser (mssql sequential WHILE; END IF asymmetry)
Next: auto-fix round 2 of 2 (final) — FIX-D (omp spawn quoting, Clear-mid-turn bubble, no-PK insert, phantom placeholders) + FIX-E (construct-stack pop-by-top-of-stack) running in parallel worktrees; then copy back, verify, commit, R5
