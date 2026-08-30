# VSDB Status

- Last meaningful update: 2026-08-30
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` == `origin/main`; **v1.15.0 published** (tag + GitHub Release with `dist/vsdb-1.15.0.vsix`, commit d24294e).
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- Cycle DBX-01 (Data Workbench Completion) COMPLETE on `main` (2026-08-30, re-opened after audit found the prior "done" claim had no code). Final state: 2301 passed | 2 skipped, typecheck clean, esbuild clean. Delivers CSV/JSON import wizard (pure parse → auto-map → dry-run → dangerous-confirm → single-transaction execute), form view, and the vsdb-lv: large-value editor.
- Cycle DBX-02 (SQL Intelligence Navigation) COMPLETE on `main` (4 code commits + docs closure). Catalog completion (FK targets + views/routines/sequences), hover/definition over `vsdb-sql-catalog:` virtual documents, and parsed find-usages wired behind partial-mock guards.

## Active Work

- Handoff ACTIVE is Cycle DBX-01, done (4/4 committed). DBX-02 done previously (5/5). Both shipped with executor reports.
- v1.15.0 (Cycle DBX-02) published on GitHub Releases; DBX-01 commits are local-only, ahead of origin until the next push.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- None blocking.

## Next Candidates
1. Next portfolio cycle: DBX-03 (Schema & Data Compare — prerequisites DBX-01 + DBX-02 now both done) or AIX-01.
2. Push DBX-01 commits and cut v1.16.0 when the user asks.

## Recently Completed

- Cycle DBX-01 (unreleased): Data Workbench Completion — CSV/JSON import wizard, form view, vsdb-lv large-value editor, parameterized DbTransaction seam.
- v1.15.0: Cycle DBX-02 SQL Intelligence Navigation — catalog resolver + FK/root completion, hover/definition virtual docs, parsed find-usages, activation wiring.
- v1.14.0: Cycle AIC SQL autocomplete (settings + form + migration; cancellable schema-only service; editor + Console ghost-text; extension wiring).

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
