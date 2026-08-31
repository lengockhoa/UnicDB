# INDEX

Cycle RLX-01 — **Operational Reliability Foundation**. Active, executable scope is narrowly limited to targeted PostgreSQL cancellation, SchemaCache single-flight refresh, and fail-closed import-plan validation. Portfolio rows are planning queue only and are not task contracts.

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-RLX-001 | Cancel active PostgreSQL non-cursor queries | ready | none | - |
| TASK-RLX-002 | Coalesce SchemaCache stale refreshes | ready | none | - |
| TASK-RLX-003 | Fail closed on malformed import execution plans | ready | none | - |
| TASK-DBX07-001 | AIX-06 Trace r3 review fixes | done | none | unic-smart |
| PORT-RLX-02 | Cross-dialect query lifecycle completion | queued — NOT READY | RLX-01 | - |
| PORT-RLX-03 | Connection, tunnel, and schema-refresh recovery | queued — NOT READY | RLX-01, PORT-RLX-02 | - |
| PORT-DBX-06 | Reviewed PostgreSQL rename workflow | queued — NOT READY | PORT-RLX-03 | - |
| PORT-DBX-08 | Explicit adapter capability parity | queued — NOT READY | PORT-RLX-02 | - |
| PORT-AIX-03 | Read-only database analysis copilot hardening | queued — NOT READY | PORT-RLX-03 | - |
| PORT-AIX-05 | Optional OMP engine resilience | queued — NOT READY | PORT-AIX-03 | - |
| PORT-AIX-06/07 | Redacted agent trace and centralized governance | queued — NOT READY | PORT-AIX-03, PORT-AIX-05 | - |
| PORT-DX-01 | Regression and release confidence lane | queued — NOT READY | shipped contracts | - |

Graph: TASK-RLX-001 independent; TASK-RLX-002 independent; TASK-RLX-003 independent.

- Wave 1 (3): TASK-RLX-001, TASK-RLX-002, TASK-RLX-003

No same-wave target-file overlap. Portfolio rows require a new source-grounded plan and task batch before becoming active.
