# VSDB Status

## Freshness

- Last meaningful update: 2026-08-29
- Updated by: Claude
- Status confidence: medium
- Stale after: 72h

## Snapshot

- Branch/state: `main` at local release-prepared `v1.14.0`; external publication has not occurred for that local release state.
- Historical handoff cycles AF (catalog/DDL/Console v2), AG (AI-chat icon toolbar), AI (results placement), and AH (accumulating multi-statement results) are recorded as complete/released in `docs/AI_HANDOFF/ACTIVE.md`.
- Durable parity roadmap: `docs/AI_HANDOFF/ROADMAP.md`. Remaining major scopes include advanced grid/import-export, admin, diff/refactor, ER/SSH/connection UX, and MySQL/MSSQL parity.

## Active Work

- Handoff ACTIVE is idle; choose the next cycle from `docs/AI_HANDOFF/ROADMAP.md`.
- Admin roadmap work has an AHL-prefixed plan/index/task draft to avoid collision with shipped results-panel Cycle AH.
- Untracked admin implementation/test files are present in the working tree: `src/ui/adminTree.ts`, `adminSessionsPanel.ts`, `adminWizard.ts` and their three tests. Their implementation/verification state is unknown from this status update; preserve and inspect before modifying.

## Decisions Pending

- User requested a long-horizon roadmap for two product pillars: DataGrip/PyCharm-style direct database work in VS Code, and an AI extension that chats with workspace files and databases, including OMP-agent execution.
- This needs a fresh planning session due to the current context handoff boundary.

## Next Candidates

1. Start a fresh planning session and reconcile the durable roadmap with the two-pillar product vision (DB IDE + AI/OMP workspace agent).
2. Inspect the AHL admin draft and untracked admin files before selecting or revising that cycle.
3. Verify local v1.14.0 release-prepared state before any external release action.

## Recently Completed

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
