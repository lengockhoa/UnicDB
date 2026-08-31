# VSDB Status

- Last meaningful update: 2026-08-31
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **v1.24.0 released** (AIX-04). Parallel session queued RLX-01 (Operational Reliability Foundation) in ACTIVE.md.
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- Cycle DBX-04 (Relationship Explorer) COMPLETE + REVIEWED (2026-08-30, unic-smart APPROVED after 3 fix rounds). Delivers `vsdb.relationshipExplorer`: FK graph, deterministic layered layout, SVG export, pan/zoom panel.
- Cycle AIX-01 (Grounded Workspace Context) COMPLETE + REVIEWED (2026-08-30, unic-smart APPROVED after 2 fix rounds at 6a2b560). Delivers opt-in grounding: selection + file blocks with line-ranged attribution, workspace_search bounded retrieval, panel toggle chips.
- Cycle DBX-02 (SQL Intelligence Navigation) COMPLETE on `main` (4 code commits + docs closure). Catalog completion (FK targets + views/routines/sequences), hover/definition over `vsdb-sql-catalog:` virtual documents, and parsed find-usages wired behind partial-mock guards.

## Active Work
- AIX-04 done + reviewed (4/4, unic-smart APPROVED after 2 fix rounds). Released v1.24.0.
- NEXT per roadmap: AIX-05 OMP Agent Workbench (wave 4) → release v1.25.0, then DBX-07, AIX-06, AIX-07 (wave 5), DBX-08, AIX-08 (wave 6).
- A parallel session rotated ACTIVE.md to Cycle RLX-01 (Operational Reliability Foundation, planning_done) — coordinate before executing RLX tasks to avoid conflicts with the roadmap wave order.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- None blocking.

## Next Candidates
1. AIX-05 OMP Agent Workbench (roadmap wave 4), then DBX-07, AIX-06, AIX-07 (wave 5), DBX-08, AIX-08 (wave 6). RLX-01 is queued by a parallel session — reconcile ordering first.


## Recently Completed

- v1.24.0: Cycle AIX-04 Database Change Workflow — plan_change reviewed change plans (danger tiers + live-schema drift, READ-ONLY), ONE shared confirmDangerousStatements consent gate, change_plan consent card (Approve/Reject, disabled when drifted, drift re-check at approve), per-statement sequential apply with partial-failure + cancel reporting, builtin + OMP/MCP registry parity; unic-smart APPROVED after 2 fix rounds.
- v1.23.0: Cycle DBX-06 Safe Rename Refactor — catalog usage analysis, reviewable ALTER plan, rename dialog with per-statement progress/cancel; unic-smart APPROVED after 2 fix rounds.
- v1.22.0: Cycle AIX-03 Database Analysis Copilot — visible tool-call cards (shape-only, incl. denial + OMP parity), analyze_table composite (injection-guarded), diagnose_query classifier; unic-smart APPROVED after 2 fix rounds.
- v1.21.0: Cycle AIX-02 Safe File Operations — gated workspace_write tool (exact URI allowlist, request-scoped snapshot binding, host CAS atomic writes, workspace-trust gate), unified diff preview on the approval card (builtin + omp/MCP); unic-smart APPROVED after 4 fix rounds.
- v1.20.0: Cycle DBX-05 Connection Workspace — folder grouping, read-only guard (client-side mutation block with EXPLAIN/CTE regressions), SSH tunnels with listener PID identity proof; unic-smart APPROVED after 6 fix rounds.
- v1.19.0: Cycle AIX-01 Grounded Workspace Context — selection/file grounding with line-ranged attribution, bounded workspace_search tool (both engines), panel toggle chips; unic-smart APPROVED after 2 fix rounds.
- v1.18.0: Cycle DBX-04 Relationship Explorer — FK graph, layered layout, SVG export, pan/zoom panel, vsdb.relationshipExplorer; unic-smart APPROVED after 3 fix rounds.
- v1.17.0: Cycle DBX-03 Schema & Data Compare — schemaDiff/dataDiff/syncPlan pure modules, compare service + preview panel, vsdb.compareTables; unic-smart APPROVED after 2 fix rounds.

- v1.16.0: Cycle DBX-01 Data Workbench Completion — CSV/JSON import wizard, form view, vsdb-lv large-value editor, parameterized DbTransaction seam.
- v1.15.0: Cycle DBX-02 SQL Intelligence Navigation — catalog resolver + FK/root completion, hover/definition virtual docs, parsed find-usages, activation wiring.
- v1.14.0: Cycle AIC SQL autocomplete (settings + form + migration; cancellable schema-only service; editor + Console ghost-text; extension wiring).

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
