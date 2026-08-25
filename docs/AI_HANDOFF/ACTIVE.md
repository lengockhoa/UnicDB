# ACTIVE

Cycle: U   Date: 2026-08-25   Base: main
Goal: DataGrip parity — per-table tabs, sort, NULL/value view, retry, autocomplete, manual-commit, MSSQL params, export fix
Tasks: 9 total
Status: done — 9/9 implemented, reviewed, and approved
Verification: compile clean · typecheck clean · 1327 passed / 2 skipped / 0 failed
Review summary: adapters/export + grid/webview + autocomplete APPROVED-WITH-MINOR (R1); TASK-009 manual-commit APPROVED (R2) after the session-pinned DbTransaction fix (transaction leak, requery deadlock, cursor conflict, R-A4 refresh race).
