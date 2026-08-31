# INDEX_AIX05

Cycle: AIX-05 OMP Agent Workbench
Base: main @ d948ec1 (v1.24.0)
Plan: PLAN_AIX05.md
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

| Task | Summary | Status | Depends on | Reviewer |
|---|---|---|---|---|
| TASK-AIX05-001 | session_state wire + webview chip | pending | — | unic-smart (cycle reviewer) |
| TASK-AIX05-002 | OmpChatEngine.cancel + Stop parity + restart pins | pending | AIX05-001 | unic-smart (cycle reviewer) |
| TASK-AIX05-003 | protocol error recovery + detect reason→hint tests | pending | AIX05-002 | unic-smart (cycle reviewer) |
| TASK-AIX05-004 | registry parity + scaffold + CHANGELOG/README | pending | AIX05-003 | unic-smart (cycle reviewer) |

Graph: AIX05-001 → AIX05-002 → AIX05-003 → AIX05-004.
Release target: v1.25.0.
