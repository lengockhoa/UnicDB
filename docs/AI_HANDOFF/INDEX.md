# INDEX

Cycle S — Lazy ctid: fix `column "ctid" does not exist` on PG view browse; save-time ctid resolution. 3 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Remove eager ctid wrap + grid ctid special-casing; rewrite 2 webview bundle test blocks + webview/main.ts comment cleanup | ready | - | - |
| TASK-002 | Save path: single lazy ctid resolver covering updates + deletes | ready | - | - |
| TASK-003 | buildSaveStatements: PG no-PK DELETE via ctidByRowId | ready | - | - |
Graph: 003→002; 001 wave-1 sibling (soft predecessor of 002). W1 = {001, 003}, W2 = {002}.
