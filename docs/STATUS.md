# VSDB Status

- Last meaningful update: 2026-08-30
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **v1.18.0 + v1.19.0 released** (tags + GitHub Releases with vsix assets).
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- Cycle DBX-04 (Relationship Explorer) COMPLETE + REVIEWED (2026-08-30, unic-smart APPROVED after 3 fix rounds). Delivers `vsdb.relationshipExplorer`: FK graph, deterministic layered layout, SVG export, pan/zoom panel.
- Cycle AIX-01 (Grounded Workspace Context) COMPLETE + REVIEWED (2026-08-30, unic-smart APPROVED after 2 fix rounds at 6a2b560). Delivers opt-in grounding: selection + file blocks with line-ranged attribution, workspace_search bounded retrieval, panel toggle chips.
- Cycle DBX-02 (SQL Intelligence Navigation) COMPLETE on `main` (4 code commits + docs closure). Catalog completion (FK targets + views/routines/sequences), hover/definition over `vsdb-sql-catalog:` virtual documents, and parsed find-usages wired behind partial-mock guards.

## Active Work
- Handoff ACTIVE is Cycle AIX-01, done + reviewed (4/4, unic-smart APPROVED). DBX-04 shipped as v1.18.0; AIX-01 shipped as v1.19.0; DBX-03 shipped as v1.17.0.
- v1.19.0 is the latest published release.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- None blocking.

## Next Candidates
1. Next portfolio cycle: DBX-05 (wave 3) or AIX-02 (wave 3) per PRODUCT_ROADMAP.


## Recently Completed

- v1.19.0: Cycle AIX-01 Grounded Workspace Context — selection/file grounding with line-ranged attribution, bounded workspace_search tool (both engines), panel toggle chips; unic-smart APPROVED after 2 fix rounds.
- v1.18.0: Cycle DBX-04 Relationship Explorer — FK graph, layered layout, SVG export, pan/zoom panel, vsdb.relationshipExplorer; unic-smart APPROVED after 3 fix rounds.
- v1.17.0: Cycle DBX-03 Schema & Data Compare — schemaDiff/dataDiff/syncPlan pure modules, compare service + preview panel, vsdb.compareTables; unic-smart APPROVED after 2 fix rounds.

- v1.16.0: Cycle DBX-01 Data Workbench Completion — CSV/JSON import wizard, form view, vsdb-lv large-value editor, parameterized DbTransaction seam.
- v1.15.0: Cycle DBX-02 SQL Intelligence Navigation — catalog resolver + FK/root completion, hover/definition virtual docs, parsed find-usages, activation wiring.
- v1.14.0: Cycle AIC SQL autocomplete (settings + form + migration; cancellable schema-only service; editor + Console ghost-text; extension wiring).

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
