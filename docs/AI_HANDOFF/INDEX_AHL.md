# INDEX_AHL

Cycle AHL — **ADMIN (ROLES / GRANTS / SESSIONS / LOCKS)**: roadmap AH slice (Admin). Plan: PLAN_AHL.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AHL-001 | pgAdmin pure module + AdminApi contract | done | none | unic-smart (next) |
| TASK-AHL-002 | Admin tree provider + roles/grants wizard | ready | AHL-001 | - |
| TASK-AHL-003 | Sessions/Locks panel + kill/terminate confirm | ready | AHL-001 | - |
| TASK-AHL-004 | Extension wiring + package.json + regression | ready | AHL-002, AHL-003 | - |

Graph: AHL-001 → AHL-002, AHL-003; AHL-002 + AHL-003 → AHL-004.

Waves:
- Wave 1: TASK-AHL-001
- Wave 2: TASK-AHL-002 | TASK-AHL-003 (file-disjoint)
- Wave 3: TASK-AHL-004

File locks (admin cycle owns; AF/AI/AH/AG/AA/AB/AD/AE untouched):
- AHL-001: `src/core/admin/pgAdmin.ts` (NEW), additive to `src/adapters/types.ts`, additive to `src/adapters/postgres.ts`.
- AHL-002: `src/ui/adminTree.ts` (NEW), `src/ui/adminWizard.ts` (NEW) — both new files, no overlap with existing trees.
- AHL-003: `src/ui/adminSessionsPanel.ts` (NEW).
- AHL-004: `src/extension.ts` (additive), `src/core/dangerousStatement.ts` (additive Kind), `package.json` (additive).
