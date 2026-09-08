Cycle: RES-BAR   Date: 2026-09-08   Base: main @ accf1b5
Goal: Add WHERE / ORDER BY input boxes to the UnicDB Results toolbar; pressing Enter re-runs the original SQL with the typed fragments applied (server-side). Also fix toolbar hover polish (kill the late-appearing native title tooltip + the instant background-color flash).
Tasks: 3 total planned
  - TASK-RES-001 (webview): relocate requery bar into toolbar slot; placeholder `WHERE …` / `ORDER BY …`; Enter keydown listeners with IME-composition guard
  - TASK-RES-002 (ext): stripLeadingClauseKeyword helper at handleRequery message boundary; pure logic in src/ui/queryComposer.ts
  - TASK-RES-003 (webview, wave 2): drop btn.title from makeIconButton; add `transition: background-color 80ms ease-out, box-shadow 80ms ease-out` to .UnicDB-btn
Status: planning_done — ready for P2.5 review (code-reviewer)
  - P0 (locked): server-side re-run · free SQL fragment · in existing toolbar between tsv dropdown and Search input
  - P1: handoff context confirmed; previous cycle AGT-CLEANUP-2 fully closed (release 1.53.26)
  - P2: handoff-planner wrote PLAN.md + TASK-RES-001/002 (12/12 self-audit pass); orchestrator appended TASK-RES-003 (toolbar hover) + appended §2/§3/§4/§5/§6/§7 of PLAN.md
  - Wave plan: wave 1 = RES-001 ∥ RES-002 (parallel, disjoint files); wave 2 = RES-003 (sequenced after RES-001 — shares webview/main.ts + webview/styles.css)
  - No patch release in plan target — to be decided in R5
