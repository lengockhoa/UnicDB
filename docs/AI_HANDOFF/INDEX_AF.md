# INDEX_AF

Cycle AF — **DATAGRIP PARITY, WAVE 1**: catalog/DDL expansion + Console v2 + SQL formatter, PostgreSQL-first. Release target v1.12.0 (v1.11.0 reserved by deferred cycle AE). Roadmap context: `ROADMAP.md`.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AF-001 | pgCatalog pure module + Postgres adapter catalog capability | ready | none | - |
| TASK-AF-002 | Schema tree catalog nodes + real DDL viewer | ready | TASK-AF-001 | - |
| TASK-AF-003 | SQL formatter pure module | ready | none | - |
| TASK-AF-004 | SQL Console v2: tabs, per-statement run, history, EXPLAIN, Format | ready | TASK-AF-002, TASK-AF-003 | - |

Graph: TASK-AF-001 → TASK-AF-002; TASK-AF-003 independent; TASK-AF-002 + TASK-AF-003 → TASK-AF-004.

- Wave 1 (2): TASK-AF-001, TASK-AF-003
- Wave 2 (1): TASK-AF-002
- Wave 3 (1): TASK-AF-004

No same-wave file overlap: AF-001 owns core/ddl/pgCatalog.ts + adapters; AF-003 owns core/sqlFormat.ts;
AF-002 owns ui/schemaTree.ts + ui/ddlView.ts + extension.ts (wave 2); AF-004 owns ui/consolePanel.ts +
webview console files + extension.ts (wave 3). extension.ts waves 2/3 → dependency edge encoded above.

Scope lock: no import wizard, no grid row add/delete, no admin/diff/diagram/SSH (ROADMAP.md cycles AG–AK),
no touch to src/ai/omp/* (deferred cycle AE owns it), no MySQL/MSSQL changes.
