# INDEX_AF

Cycle AF — **DATAGRIP PARITY, WAVE 1**: catalog/DDL expansion + Console v2 + SQL formatter, PostgreSQL-first. Release target v1.12.0 (v1.11.0 reserved by deferred cycle AE). Roadmap context: `ROADMAP.md`.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AF-001 | pgCatalog pure module + Postgres adapter catalog capability | done | none | unic-smart |
| TASK-AF-002 | Schema tree catalog nodes + real DDL viewer | done | TASK-AF-001 | unic-smart |
| TASK-AF-003 | SQL formatter pure module | done | none | unic-smart |
| TASK-AF-004 | SQL Console v2: tabs, per-statement run, history, EXPLAIN, Format | done | TASK-AF-002, TASK-AF-003 | unic-smart |

Closure (2026-08-29): Phase 4 review completed post-release by unic-smart (mustDifferFromExecutor ok, executor unic-code). Verdicts: AF-001 approved_minor (executor report recovered from parked artifact ExecAF001), AF-002 approved_minor, AF-003 approved, AF-004 approved_minor. Targeted suites re-run fresh: pgCatalog+adapterCatalog 24/24, sqlFormat 10/10, tree+ddl 74/74 (incl. 62 regression), console 12/12; typecheck exit 0. Cycle shipped in v1.12.0 (a72b9cf); no product code changed by review.

Graph: TASK-AF-001 → TASK-AF-002; TASK-AF-003 independent; TASK-AF-002 + TASK-AF-003 → TASK-AF-004.

- Wave 1 (2): TASK-AF-001, TASK-AF-003
- Wave 2 (1): TASK-AF-002
- Wave 3 (1): TASK-AF-004

No same-wave file overlap: AF-001 owns core/ddl/pgCatalog.ts + adapters; AF-003 owns core/sqlFormat.ts;
AF-002 owns ui/schemaTree.ts + ui/ddlView.ts + extension.ts (wave 2); AF-004 owns ui/consolePanel.ts +
webview console files + extension.ts (wave 3). extension.ts waves 2/3 → dependency edge encoded above.

Scope lock: no import wizard, no grid row add/delete, no admin/diff/diagram/SSH (ROADMAP.md cycles AG–AK),
no touch to src/ai/omp/* (deferred cycle AE owns it), no MySQL/MSSQL changes.
