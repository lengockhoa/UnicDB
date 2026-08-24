# INDEX

Cycle R — AI overhaul + Grid Excel hóa. 9 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Full-DB structure builder + export_structure agent tool | done | Exec-T1 | unic-smart |
| TASK-002 | Full-DB DDL context injection vào buildMessages | done | Exec-T2 | unic-smart |
| TASK-003 | Chat reliability: Clear dead-state + not-configured error | done | Exec-T3 | unic-smart |
| TASK-004 | vsdb.exportAllStructures — copy toàn-DB DDL | done | Exec-T4 | unic/unic-smart |
| TASK-005 | Cmd+Enter cursor-mode: gap-rule fix + regression lock | done | Exec-T5 | unic-smart |
| TASK-006 | Grid A (P0): no-PK ctid save bug — hidden ctid column | done | Exec-T6 | unic/unic-smart |
| TASK-007 | Grid B: dirty highlight + add/delete-row commit | done | Exec-T7 | unic/unic-smart |
| TASK-008 | Grid C: unified undo/redo stack | done | Exec-T8 | unic-smart |
| TASK-009 | Grid D: requery/set-filter alignment | done | Exec-T9 | unic/unic-smart |
Graph: 001→{002,004}; 002→003; 006→007; 007→{008,009}; 005 độc lập.
