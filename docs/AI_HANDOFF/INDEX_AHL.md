# INDEX_AHL

Cycle AHL — **ADMIN (ROLES / GRANTS / SESSIONS / LOCKS)**: roadmap AH slice (Admin). Plan: PLAN_AHL.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AHL-001 | pgAdmin pure module + AdminApi contract | done | none | unic-smart strict re-review APPROVED (2026-08-30) |
| TASK-AHL-002 | Admin tree provider + roles/grants wizard | done | AHL-001 | unic-smart strict re-review APPROVED (2026-08-30) |
| TASK-AHL-003 | Sessions/Locks panel + kill/terminate confirm | done | AHL-001 | unic-smart strict re-review APPROVED (2026-08-30) |
| TASK-AHL-004 | Extension wiring + package.json + regression | done (approved_minor) | AHL-002, AHL-003 | unic-smart strict re-review APPROVED (2026-08-30) |

Graph: AHL-001 → AHL-002, AHL-003; AHL-002 + AHL-003 → AHL-004.

Waves:
- Wave 1: TASK-AHL-001 (commit `adcd977`)
- Wave 2: TASK-AHL-002 | TASK-AHL-003 (commit `cc7fdbe`, file-disjoint)
- Wave 3: TASK-AHL-004 (commit `480e8df`)

All 4 tasks done. Final state: full suite 2133 passed | 2 skipped (145 files); typecheck 0; compile clean.

Reviewer note (resolved 2026-08-30): the same-model advisory review debt was cleared by an independent unic-smart strict re-review (AhlReviewer). Verdict history: CHANGES-REQUESTED (3 findings: gate ordering vs confirmDestructive opt-out, wizard bare-runQuery bypass, grant-target NUL/length validation) -> remediation commit 8f03b7b -> superseding APPROVED in TASK-AHL-001.md + TASK-AHL-004.md. Final: targeted 146/146, full 2453 passed | 2 skipped.

File locks (admin cycle owns):
- AHL-001: `src/core/admin/pgAdmin.ts` (NEW), `src/core/admin/__tests__/pgAdmin.test.ts` (NEW), additive to `src/adapters/types.ts`, additive to `src/adapters/postgres.ts`.
- AHL-002: `src/ui/adminTree.ts` (NEW), `src/ui/adminWizard.ts` (NEW), `src/ui/__tests__/adminTree.test.ts` (NEW), `src/ui/__tests__/adminWizard.test.ts` (NEW).
- AHL-003: `src/ui/adminSessionsPanel.ts` (NEW), `src/ui/__tests__/adminSessionsPanel.test.ts` (NEW).
- AHL-004: `src/extension.ts` (additive), `src/core/dangerousStatement.ts` (additive Kind/tier widening), `package.json` (additive 5 commands + 2 activation events + 1 setting + 1 view), `src/__tests__/ahlScaffold.test.ts` (NEW).
