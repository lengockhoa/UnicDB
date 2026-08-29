# VSDB Status

- Last meaningful update: 2026-08-30
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` at local release-prepared `v1.14.0`; external publication has not occurred for that local release state.
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- Cycle AIC implementation COMPLETE on `main` (5 commits: AIC-001..AIC-005). Final state: 2188 passed | 2 skipped regression, typecheck clean, esbuild clean. The previously-stated "AIC implementation is intentionally not started" line is stale; the cycle is closed.

## Active Work

- Handoff ACTIVE was Cycle AIC, planning done. Task graph: AIC-001 → AIC-002 → {AIC-003, AIC-004} → AIC-005. All five tasks are now done.
- The plan independently reviewed initial design findings and applied them: explicit request/cost bounds, every-load settings migration, single cancellation/cache owner, Console overlay/acceptance contract, status-bar-only unavailable cue, and logging/privacy tests.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- Verify local v1.14.0 release-prepared state before any external release action.
- Select the next DBX/AIX portfolio cycle to follow AIC.

## Next Candidates
1. Select the next DBX/AIX portfolio cycle to follow AIC (cycle is closed).
2. Verify local v1.14.0 release-prepared state before any external release action.

## Recently Completed

- v1.14.0: Cycle AIC SQL autocomplete (settings + form + migration; cancellable schema-only service; editor + Console ghost-text; extension wiring).
- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
