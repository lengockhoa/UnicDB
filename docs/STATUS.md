# VSDB Status

- Last meaningful update: 2026-09-01
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **HEAD @ cb27b86**, v1.31.0 released (tag + vsdb-1.31.0.vsix). Wave 7 shipped: **RLX-02 Cross-dialect Query Lifecycle** — MySQL `PoolConnection.destroy` + pre-handoff stream cancel; MSSQL `activeRequests` snapshot + `request.cancel`; `vsdb.cancelQuery` now awaits `runner.cancel()` before busy-clear. 3/3 tasks approved (001 after 1 fix round), unic-smart review.
- Full suite: **2838 passed | 2 skipped + 1 pre-existing flaky perf test** (`saveStatementsParser` 200KB perf — passes in isolation), typecheck + compile clean.

## Active Work

- None — Wave 7 (RLX-02) is complete and released as v1.31.0.

## Decisions Pending

- None — standing user directive is continuous autonomous execution through the remaining portfolio; next cycle = **PORT-RLX-03** (deps now satisfied).

## Next Candidates

1. **PORT-RLX-03** (connection/tunnel/schema-refresh recovery) — launch via new handoff cycle.
2. **PORT-DBX-06** → **PORT-AIX-03** as the subsequent autonomous waves.

## Recently Completed

- **v1.31.0 — Cycle RLX-02 Cross-dialect Query Lifecycle** (2026-09-01): MySQL `PoolConnection.destroy` + pre-handoff stream cancel (natural-rejection DML fixtures); MSSQL `activeRequests` snapshot + `request.cancel`; `vsdb.cancelQuery` awaits `runner.cancel()` before busy-clear; `mockMysqlTxConnection` `queryImpl` parameter drives natural rejection (no `.then` patch). unic-smart review: TASK-001 fixed round 1 (real `beforeDestroys` counter instead of constant zero), 002/003 APPROVED round 1. Focused green, full suite **2838|2 + 1 pre-existing perf flake** at release. Plan: PLAN_RLX02.md, Tasks: TASK-RLX02-001/002/003.
- v1.30.0 — Cycle AIX-08 Extensible MCP Tool Contracts (2026-09-01): curated MCP extension registry, fail-closed v1 declaration grammar, AIX-07/DBX-08 admission, least-privilege context, host-MCP curated call lane. unic-smart 2 reviewers CHANGES-REQUESTED round 1 → 4 fixed. Plan: PLAN_AIX08.md, Tasks: TASK-AIX08-001/002.
- v1.29.0 — Cycle DBX-08 Dialect Parity Contract (2026-09-01): `AdapterCapability`/`hasAdapterCapability`, frozen capability matrices, catalog/object-DDL + table-DDL/admin gating across all touched modules. unic-smart 001/003 APPROVED, 002 fixed round 1. Plan: PLAN_DBX08.md, Tasks: TASK-DBX08-001/002/003.
- v1.28.0 — Cycle AIX-07 Trust, Privacy & Governance (2026-08-31): central default-deny AI policy, redacted all-turn audit, host commands, panel policy gating, uniform wire redaction incl. raw-ACP + resumed history; unic-smart review, 2 fix rounds.
- v1.27.0 — Cycle RLX-01 Operational Reliability Foundation (2026-08-31): PG non-cursor cancellation, SchemaCache single-flight coalescing, fail-closed import plan validation; unic-smart APPROVED round 2 after 1 auto-fix round each.
