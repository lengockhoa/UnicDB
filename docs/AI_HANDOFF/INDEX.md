# INDEX

Cycle R — AI overhaul + Grid Excel hóa. 9 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Full-DB structure builder + export_structure agent tool | ready | - | - |
| TASK-002 | Full-DB DDL context injection vào buildMessages | ready | - | - |
| TASK-003 | Chat reliability: Clear dead-state + not-configured error | pending_review | Exec-T3 | Rev-T003 |
| TASK-004 | vsdb.exportAllStructures — copy toàn-DB DDL | ready | - | - |
| TASK-005 | Cmd+Enter cursor-mode: gap-rule fix + regression lock | ready | - | - |
| TASK-006 | Grid A (P0): no-PK ctid save bug — hidden ctid column | ready | - | - |
| TASK-007 | Grid B: dirty highlight + add/delete-row commit | ready | - | - |
| TASK-008 | Grid C: unified undo/redo stack | ready | - | - |

Waves (cycle R, sau Round-1 review): W1 = 001, 005, 006 · W2 batch A = 002, 004, 007 (007 dep 006) · W2 batch B = 003 (dep 002), 008, 009 (dep 007; 008/009 tuần tự vì cùng webview files).
Graph: 001→{002,004}; 002→003; 006→007; 007→{008,009}; 005 độc lập.
