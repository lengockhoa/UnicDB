# Handoff Task Index

<!--
Status values (xem RULES.md §Status state machine):
ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | done | blocked | needs_breakdown

Cycle history: A (AG Grid), B (edit/paste/undo), C, D+E (v1.4.0 grid edit/save/export/requery), F, G (v1.5.0 set filter/toolbar/lens/guard), H (v1.5.1 hardening) — Plans archived trong archive/.
-->

| ID | Title | Priority | Size | Status | Owner | Reviewer | File |
|----|-------|----------|------|--------|-------|----------|------|
| TASK-001 | Pure CREATE TABLE generator (src/core/ddl/createTable.ts) | P0 | M | ready | - | - | tasks/TASK-001.md |
| TASK-002 | pg_catalog introspection → TableSpec (src/core/ddl/pgIntrospect.ts) | P0 | M | ready | - | - | tasks/TASK-002.md |
| TASK-003 | Pure ALTER diff engine (src/core/ddl/alterTable.ts) | P0 | M | ready | - | - | tasks/TASK-003.md |
| TASK-004 | Table designer webview + host (create + modify modes) | P0 | L | ready | - | - | tasks/TASK-004.md |
| TASK-005 | Extension wiring: menus, commands, utilities, refresh + reveal | P0 | L | ready | - | - | tasks/TASK-005.md |
| TASK-006 | PG integration tests (VSDB_IT=1) + docs (CODE_MAP, README) | P0 | M | ready | - | - | tasks/TASK-006.md |

Waves: 1 = TASK-001,002,003 (parallel) → 2 = TASK-004 → 3 = TASK-005 → 4 = TASK-006.

## Queued (future cycles)

- AI assist tab / AI core — Cycle J queued: full spec at `docs/AI_HANDOFF/queue/AI-CORE-spec.md`.
- Editable SQL preview; MySQL/MSSQL table designer; Postman payload (see PLAN.md §2 Backlog).

Updated: 2026-08-23 · Cycle I planning_done — 6 tasks ready (4 waves). Previous: cycle H released v1.5.1.
