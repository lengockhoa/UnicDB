# VSDB Status

- Last meaningful update: 2026-08-30
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` == `origin/main`; **v1.15.0 published** (tag + GitHub Release with `dist/vsdb-1.15.0.vsix`, commit d24294e).
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- Cycle DBX-02 (SQL Intelligence Navigation) COMPLETE on `main` (4 code commits + docs closure). Final state: 2237 passed | 2 skipped regression, typecheck clean, esbuild clean. Catalog completion (FK targets + views/routines/sequences), hover/definition over `vsdb-sql-catalog:` virtual documents, and parsed find-usages are wired into activation behind partial-mock guards.

## Active Work

- Handoff ACTIVE is Cycle DBX-02, done. Task graph: DBX02-001 → {002, 003, 004} → 005; all five tasks committed with executor reports.
- v1.15.0 (Cycle DBX-02) is tagged/pushed and published on GitHub Releases; nothing pending on the publication side.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- None blocking.

## Next Candidates
1. Select the next DBX/AIX portfolio cycle to follow DBX-02 (candidates: DBX-03, AIX-01 per PRODUCT_ROADMAP.md).
2. Pick up the next portfolio cycle (DBX-03 / AIX-01) when the user asks.

## Recently Completed

- v1.15.0: Cycle DBX-02 SQL Intelligence Navigation — catalog resolver + FK/root completion, hover/definition virtual docs, parsed find-usages, activation wiring.
- v1.14.0: Cycle AIC SQL autocomplete (settings + form + migration; cancellable schema-only service; editor + Console ghost-text; extension wiring).

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
