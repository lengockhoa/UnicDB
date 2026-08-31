# INDEX_AIX07

Cycle: AIX-07 Trust, Privacy & Governance  
Base: main @ 4761043 (v1.27.0)  
Plan: `PLAN_AIX07.md`  
Release target: v1.28.0  
Executor: `unic-code` · Reviewer: `unic-smart` (MUST differ)

| Wave | Task | Summary | Status | Depends on | Reviewer |
|---|---|---|---|---|---|
| 1 | TASK-AIX07-001 | Central effective AI policy (pure) | ready | none | unic-smart |
| 1 | TASK-AIX07-002 | Redacted all-turn audit export primitive | ready | none | unic-smart |
| 2 | TASK-AIX07-003 | Policy and audit command host integration | ready | TASK-AIX07-001, TASK-AIX07-002 | unic-smart |

Graph: TASK-AIX07-001 → TASK-AIX07-003; TASK-AIX07-002 → TASK-AIX07-003.  
Waves: wave 1 = 2 parallel tasks; wave 2 = 1 integration task.
