Cycle: RES-BAR   Date: 2026-09-08   Base: main @ accf1b5
Goal: Add WHERE / ORDER BY input boxes to the UnicDB Results toolbar; pressing Enter re-runs the original SQL with the typed fragments applied (server-side). Also fix toolbar hover polish (kill the late-appearing native title tooltip + the instant background-color flash).
Tasks: 3 total planned
  - TASK-RES-001 (webview): relocate requery bar into toolbar slot; placeholder `WHERE …` / `ORDER BY …`; Enter keydown listeners with IME-composition guard
  - TASK-RES-002 (ext): stripLeadingClauseKeyword helper at handleRequery message boundary; pure logic in src/ui/queryComposer.ts
  - TASK-RES-003 (webview, wave 2): drop btn.title from makeIconButton; add `transition: background-color 80ms ease-out, box-shadow 80ms ease-out` to .UnicDB-btn
Status: review_in_progress — R4 reviewer agents dispatched (unic-smart, batch 1 = RES-001 + RES-002 in parallel). R1 (review-context scout), R2 (model isolation: executor=unic-code ≠ reviewer=unic-smart, holds), R3 (re-run verification: typecheck 0 · compile clean · targeted vitest 69/69 · full npm test 4081/4 green) all done.
  - P0 (locked): server-side re-run · free SQL fragment · in existing toolbar between tsv dropdown and Search input
  - P1: handoff context confirmed; previous cycle AGT-CLEANUP-2 fully closed (release 1.53.26)
  - P2: handoff-planner wrote PLAN.md + TASK-RES-001/002 (12/12 self-audit pass); orchestrator appended TASK-RES-003 (toolbar hover) + appended §2/§3/§4/§5/§6/§7 of PLAN.md
  - P3: plan committed at 2bc0544
  - Wave 1 (RES-001 + RES-002): committed at 109008b · cleanup f078391 (drop accidental node_modules_backup cache)
  - Wave 2 (RES-003): committed at 59e9ae8
  - I4 docs checkpoint: committed at 5d11664 (INDEX/RUN/TASK-RES-003 report)
  - R1–R3: complete (model isolation holds, all 4 verification commands green)
  - R4: in flight — batch 1 (RES-001 + RES-002 reviewers) running; batch 2 (RES-003) queued
  - No patch release in plan target — to be decided in R5
  - Review range for R4: 2bc0544..59e9ae8 (plus 5d11664 docs checkpoint, no code)
