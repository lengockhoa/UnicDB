# INDEX_AIX06

Cycle: AIX-06 Agent Trace & Replay
Base: main @ 23309e5 (v1.25.0)
Plan: PLAN_AIX06.md
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

| Task | Summary | Status | Depends on | Reviewer |
|---|---|---|---|---|
| TASK-AIX06-001 | TraceRecorder pure module (redaction, bounded storage) | pending | — | unic-smart (cycle reviewer) |
| TASK-AIX06-002 | OmpChatEngine trace hook (onTrace event) | pending | AIX06-001 | unic-smart (cycle reviewer) |
| TASK-AIX06-003 | builtin path bridge (runAgent accepts trace) | pending | AIX06-001 | unic-smart (cycle reviewer) |
| TASK-AIX06-004 | AiChatPanel wiring + scaffold + CHANGELOG/README | pending | AIX06-002 + AIX06-003 | unic-smart (cycle reviewer) |

Graph: AIX06-001 → AIX06-002 + AIX06-003 → AIX06-004.
Release target: v1.26.0.
