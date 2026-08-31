# INDEX_AIX04

Cycle: AIX-04 Database Change Workflow
Base: main @ 75c6fa8 (v1.23.0)
Plan: PLAN_AIX04.md
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

| Task | Summary | Status | Depends on | Reviewer |
|---|---|---|---|---|
| TASK-AIX04-001 | changePlan pure module | pending | — | unic-smart (cycle reviewer) |
| TASK-AIX04-002 | plan_change agent tool | pending | AIX04-001 | unic-smart (cycle reviewer) |
| TASK-AIX04-003 | panel consent + apply flow | pending | AIX04-002 | unic-smart (cycle reviewer) |
| TASK-AIX04-004 | scaffold hygiene + CHANGELOG/README | pending | AIX04-003 | unic-smart (cycle reviewer) |

Graph: AIX04-001 → AIX04-002 → AIX04-003 → AIX04-004.
Release target: v1.24.0.
