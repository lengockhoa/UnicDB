Command: handoff-fullstack
Goal: Split results toolbar into exactly 2 rows — row 1 keeps icon buttons + tsv; row 2 holds WHERE/ORDER BY/run/clear/header/copy/export/chip/Search
Base: main @ 7e29d2e (v1.53.38)
Phase: P3
Cursor: P2.5 complete — APPROVED-WITH-MINOR (reviewer unic-smart, isolated). Applied 1 important finding (PLAN §2/§7 + §1 vs RUN.md release-bump contradiction reworded to defer to R5) + 5 minor findings (TASK case #2 added to per-file list, case #6 fixture name = dispatchState({type:"transactionStatus", open:true}), 4→5 pin assertions across 3 sites, styles.css:98-123 → 98-134 data-tooltip range). P3 lite-agent dispatched (a5a8d45df7282e833) — committing PLAN.md + INDEX.md + ACTIVE.md + RUN.md + tasks/TASK-COLLAPSE-002.md + INDEX_RES/ACTIVE_RES/PLAN_RES archive.
Constraints: USER OVERRIDE on version bump — patch v1.53.39 + publish at R5
Next: Phase 3 I1 setup (lite agent) → I2 wave groups (1 task = wave 1) → I3 feature-implementer (sonnet) executes TASK-COLLAPSE-002 → I4 consolidate
