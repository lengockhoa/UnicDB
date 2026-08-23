# Handoff Task Index

<!--
Status values (xem RULES.md §Status state machine):
ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | done | blocked | needs_breakdown

Cycle 2026-08-22-D+E: DONE — released v1.4.0 (commit bdbd7b5, tag v1.4.0).
Gates: compile OK · typecheck OK · 34 files / 388 tests · browser smoke grid thật (edit/commit/paste/undo/export/requery/checkbox).
-->

| ID | Title | Priority | Size | Status | Owner | Reviewer | File |
|----|-------|----------|------|--------|-------|----------|------|
| TASK-501 | Grid edit model + paste TSV + undo + toolbar | P0 | M | done | - | unic-smart | `docs/AI_HANDOFF/tasks/TASK-501.md` |
| TASK-505 | Run .sh button (terminal) | P1 | S | done | - | unic-smart | `docs/AI_HANDOFF/tasks/TASK-505.md` |
| TASK-502 | Export serializers + toolbar (8 format) | P0 | M | done | - | unic-smart | `docs/AI_HANDOFF/tasks/TASK-502.md` |
| TASK-503 | Save edits (PK/ctid) + Commit flow | P0 | L | done | - | unic-smart | `docs/AI_HANDOFF/tasks/TASK-503.md` |
| TASK-504 | WHERE/ORDER BY bar + requery | P1 | S | done | - | unic-smart | `docs/AI_HANDOFF/tasks/TASK-504.md` |
| TASK-506 | Version 1.4.0 + README + full-suite boundary | P1 | S | done | - | unic/unic-smart | `docs/AI_HANDOFF/tasks/TASK-506.md` |

## Queued (future cycles)

- AI assist tab (user 2026-08-22, chưa spec chi tiết).
- Known deferred minors: saveEdits refresh durationMs epoch bug (TASK-503 scope); delete-loop O(rows×cols); composeRequery trailing-`;` defense-in-depth; batched pickResult refresh.

Updated: 2026-08-22 · cycle 2026-08-22-D+E (released v1.4.0)
