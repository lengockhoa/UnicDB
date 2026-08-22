# Handoff Task Index

<!--
Status values (xem RULES.md §Status state machine):
ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | done | blocked | needs_breakdown

Cycle 2026-08-22-D+E waves (không task cùng wave share file):
W1: 501 (resultsGridModel+webview/main) + 505 (extension.ts) — disjoint
W2: 502 (resultsGridModel serializers + webview export UI)
W3: 503 (messages/panel/adapters — depends 501+502)
W4: 504 (requery)
W5: 506 (version boundary — full suite)
-->

| ID | Title | Priority | Size | Status | Owner | Reviewer | File |
|----|-------|----------|------|--------|-------|----------|------|
| TASK-501 | Grid edit model + paste TSV + undo + toolbar | P0 | M | done | executor/feature-implementer | unic-smart | `docs/AI_HANDOFF/tasks/TASK-501.md` |
| TASK-505 | Run .sh button (terminal) | P1 | S | done | executor/feature-implementer | unic-smart | `docs/AI_HANDOFF/tasks/TASK-505.md` |
| TASK-502 | Export serializers + toolbar (8 format) | P0 | M | pending_review | executor/feature-implementer | unic-smart | `docs/AI_HANDOFF/tasks/TASK-502.md` |
| TASK-503 | Save edits (PK/ctid) + Commit flow | P0 | L | ready | - | - | `docs/AI_HANDOFF/tasks/TASK-503.md` |
| TASK-504 | WHERE/ORDER BY bar + requery | P1 | S | ready | - | - | `docs/AI_HANDOFF/tasks/TASK-504.md` |
| TASK-506 | Version 1.4.0 + README + full-suite boundary | P1 | S | ready | - | - | `docs/AI_HANDOFF/tasks/TASK-506.md` |

## Queued (future cycles)

- AI assist tab (user 2026-08-22, chưa spec chi tiết).

Updated: 2026-08-23 · TASK-502 fix round 1 → pending_review
