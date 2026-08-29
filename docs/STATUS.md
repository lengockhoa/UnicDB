# VSDB Status

## Freshness

- Last meaningful update: 2026-08-29
- Updated by: Claude
- Status confidence: medium
- Stale after: 72h

## Snapshot

- Branch/state: `main` at local release-prepared `v1.14.0`; external publication has not occurred for that local release state.
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- Cycle AIC is planning-complete: separately configurable free-form OpenAI-compatible SQL autocomplete model, schema-only context, 300ms debounced ghost text in SQL editor and Console. Its five ready tasks are in `docs/AI_HANDOFF/INDEX.md`.

## Active Work

- Handoff ACTIVE is Cycle AIC, planning done. Task graph: AIC-001 → AIC-002 → {AIC-003, AIC-004} → AIC-005.
- The plan independently reviewed initial design findings and applied them: explicit request/cost bounds, every-load settings migration, single cancellation/cache owner, Console overlay/acceptance contract, status-bar-only unavailable cue, and logging/privacy tests.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- AIC implementation is intentionally not started. User authorizes planning here; an executor must explicitly be asked to run the ready task cycle.
- Verify local v1.14.0 release-prepared state before any external release action.

## Next Candidates

1. Execute AIC-001 with the handoff executor, then follow the encoded dependency waves.
2. Select the next DBX/AIX portfolio cycle only after AIC is completed/cleared.
3. Verify local v1.14.0 release-prepared state before any external release action.

## Recently Completed

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
