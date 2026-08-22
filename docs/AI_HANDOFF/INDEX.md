# Handoff Task Index

<!--
Status values (xem RULES.md §Status state machine):
ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | done | blocked | needs_breakdown

Wave structure (không task cùng wave share file):
W1: 401, 402 (file disjoint) | W2: 403 (boundary: full suite)
-->

| ID | Title | Priority | Size | Status | Owner | Reviewer | File |
|----|-------|----------|------|--------|-------|----------|------|
| TASK-401 | Grid theme theo VS Code (CSS var mapping) | P0 | S | approved_minor | unic/unic-smart | 2026-08-22 | `docs/AI_HANDOFF/tasks/TASK-401.md` |
| TASK-402 | Excel-like column filters + colFilterActive gating | P0 | M | done | - | unic/unic-smart | `docs/AI_HANDOFF/tasks/TASK-402.md` |
| TASK-403 | Version 1.3.2 + README + full-suite boundary | P1 | S | approved_minor | - | unic/unic-smart | `docs/AI_HANDOFF/tasks/TASK-403.md` |

## Queued (future cycles)

- Cycle D — Results grid edit mode (user 2026-08-22): inline cell edit, Cmd+Enter commit 1 lần (batch), paste từ Excel (TSV, auto-ignore dòng thừa), export toolbar TSV/CSV/XML/JSON/SQL Inserts/SQL Insert Multirow/SQL Updates/Where Clause + Header checkbox + To Clipboard/Export; save theo PK hoặc PostgreSQL ctid khi không PK (warning banner); WHERE/ORDER BY bar; toolbar refresh/add/delete/undo/CSV toggle/Commit.
- Cycle E — Run .sh button (user 2026-08-22): mở file .sh → nút Run chạy nội dung script như chạy full file trong terminal (Integrated Terminal).

Updated: 2026-08-22 · cycle 2026-08-22-C (planning done)
