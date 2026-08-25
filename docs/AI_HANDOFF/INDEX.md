# INDEX

Cycle S — Lazy ctid: fix `column "ctid" does not exist` on PG view browse; save-time ctid resolution. 3 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Remove eager ctid wrap + grid ctid special-casing; rewrite 2 webview bundle test blocks + webview/main.ts comment cleanup | changes_requested | Exec-T1 | unic/unic-smart |
| TASK-002 | Save path: single lazy ctid resolver covering updates + deletes | approved | Exec-T2 | unic/unic-smart |
| TASK-003 | buildSaveStatements: PG no-PK DELETE via ctidByRowId | pending_review | Exec-T3 | Rev-T3 |
Graph: 003→002; 001 wave-1 sibling (soft predecessor of 002). W1 = {001, 003}, W2 = {002}.
