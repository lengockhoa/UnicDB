# INDEX

Cycle AIC — **AI SQL AUTOCOMPLETE**: separately configurable free-form OpenAI-compatible autocomplete model; schema-only, debounced, cancellable ghost-text suggestions in SQL editor and Console while preserving deterministic completion, query execution/results, and AI Chat.

| Task | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-AIC-001 | Add configurable autocomplete model role | done | none | unic-code |
| TASK-AIC-002 | Build schema-only cancellable autocomplete service | pending_review | TASK-AIC-001 | - |
| TASK-AIC-003 | Add native SQL editor ghost-text provider | ready | TASK-AIC-002 | - |
| TASK-AIC-004 | Add Console ghost-text autocomplete | ready | TASK-AIC-002 | - |
| TASK-AIC-005 | Wire AI autocomplete lifecycle into extension | ready | TASK-AIC-003, TASK-AIC-004 | - |

Graph: TASK-AIC-001 → TASK-AIC-002 → TASK-AIC-003 → TASK-AIC-005; TASK-AIC-002 → TASK-AIC-004 → TASK-AIC-005.

- Wave 1 (1): TASK-AIC-001
- Wave 2 (1): TASK-AIC-002
- Wave 3 (2): TASK-AIC-003, TASK-AIC-004
- Wave 4 (1): TASK-AIC-005

No same-wave target-file overlap. Historical AHL artifacts remain preserved in `PLAN_AHL.md`, `INDEX_AHL.md`, `tasks/TASK-AHL-001.md` through `TASK-AHL-004.md`, and `archive/cycle-AHL.md`.
