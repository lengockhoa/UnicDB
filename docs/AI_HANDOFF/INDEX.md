# Handoff Task Index

<!--
Status values (xem RULES.md §Status state machine):
ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | done | blocked | needs_breakdown

Cycle history: A (AG Grid), B (edit/paste/undo), C, D+E (grid edit/save/export/requery), F, G, H — Plans archived trong archive/. Cycle I (2026-08-23, table designer) done.
-->

| ID | Title | Priority | Size | Status | Owner | Reviewer | File |
|----|-------|----------|------|--------|-------|----------|------|
| TASK-001 | AI config storage: SecretStorage + workspace config + reload (src/ai/config.ts) | P0 | M | pending_review | Exec-T001-2 | - | tasks/TASK-001.md |
| TASK-002 | OpenAI-compatible provider client (src/ai/provider.ts) | P0 | M | pending_review | Exec-T002-2 | - | tasks/TASK-002.md |
| TASK-003 | Agent loop: config-driven routing + tool registry + step budget (src/ai/agent.ts) | P0 | L | pending_review | Exec-T003-2 | - | tasks/TASK-003.md |
| TASK-004 | AI Settings form (webview) + extension wiring + README privacy | P0 | L | pending_review | Exec-T004-2 | - | tasks/TASK-004.md |

Waves: 1 = TASK-001,002 (parallel — T1 owns src/ai/settings.ts+config.ts, T2 owns src/ai/provider.ts standalone, no shared files) → 2 = TASK-003 → 3 = TASK-004.