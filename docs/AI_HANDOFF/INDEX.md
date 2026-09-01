# INDEX

Cycle AIX-07 — **Trust, Privacy & Governance**. Active, executable scope covers the central effective AI policy (TASK-AIX07-001), the redacted all-turn audit export primitive (TASK-AIX07-002), and their policy + audit command host integration (TASK-AIX07-003). All three tasks complete and pending review.

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-RLX-001 | Cancel active PostgreSQL non-cursor queries | done | none | unic-smart |
| TASK-RLX-002 | Coalesce SchemaCache stale refreshes | done | none | unic-smart |
| TASK-RLX-003 | Fail closed on malformed import execution plans | done | none | unic-smart |
| TASK-AIX07-001 | Central effective AI policy (pure) | approved | fix round 1 verified | unic-smart |
| TASK-AIX07-002 | Redacted all-turn audit export primitive | approved | fix round 1 verified | unic-smart |
| TASK-AIX07-003 | Policy and audit command host integration | blocked | none | unic-smart |
| TASK-DBX07-001 | AIX-06 Trace r3 review fixes | done | none | unic-smart |
| PORT-RLX-02 | Cross-dialect query lifecycle completion | active — planned in Cycle RLX-02 | RLX-01 | unic-smart |
| PORT-RLX-03 | Connection, tunnel, and schema-refresh recovery | queued — NOT READY | RLX-01, PORT-RLX-02 | - |
| PORT-DBX-06 | Reviewed PostgreSQL rename workflow | queued — NOT READY | PORT-RLX-03 | - |
| PORT-DBX-08 | Explicit adapter capability parity | superseded (shipped in v1.29.0) | - | unic-smart |
| PORT-AIX-03 | Read-only database analysis copilot hardening | queued — NOT READY | PORT-RLX-03 | - |
| PORT-AIX-05 | Optional OMP engine resilience | queued — NOT READY | PORT-AIX-03 | - |
| PORT-AIX-06/07 | Redacted agent trace and centralized governance | superseded (shipped in v1.26.0–v1.28.0) | - | unic-smart |
| PORT-DX-01 | Regression and release confidence lane | queued — NOT READY | shipped contracts | - |

Graph: TASK-AIX07-001 independent; TASK-AIX07-002 independent; TASK-AIX07-003 independent.

- Wave 1 (2): TASK-AIX07-001, TASK-AIX07-002
- Wave 2 (1): TASK-AIX07-003

No same-wave target-file overlap. Portfolio rows require a new source-grounded plan and task batch before becoming active.

## Cycle AIX-08 — Extensible MCP Tool Contracts

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-AIX08-001 | Curated MCP extension registry and least-privilege contract | approved | fix round 1 verified | unic-smart |
| TASK-AIX08-002 | Contain curated extensions in host MCP calls | approved | fix round 1 verified | unic-smart |

Graph: TASK-AIX08-001 → TASK-AIX08-002.

- Wave 1 (1): TASK-AIX08-001
- Wave 2 (1): TASK-AIX08-002

No same-wave target-file overlap. The registry contract is intentionally separate from host transport integration.

## Cycle RLX-02 — Cross-dialect Query Lifecycle Completion

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-RLX02-001 | Cancel live MySQL query ownership safely | done | fix round 1 verified | unic-smart |
| TASK-RLX02-002 | Cancel live SQL Server Requests safely | done | approved round 1 | unic-smart |
| TASK-RLX02-003 | Surface cross-dialect cancellation through runner and panel | done | approved round 1 | unic-smart |

Graph: TASK-RLX02-001 independent; TASK-RLX02-002 independent; TASK-RLX02-001 → TASK-RLX02-003; TASK-RLX02-002 → TASK-RLX02-003.

- Wave 1 (2): TASK-RLX02-001, TASK-RLX02-002
- Wave 2 (1): TASK-RLX02-003

No same-wave target-file overlap. MySQL and SQL Server own disjoint adapter/test files; the runner, panel, and command integration begins only after both dialect seams are available.
