# VSDB Status

- Last meaningful update: 2026-09-01
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **HEAD @ 3564b69**, v1.33.0 released (tag + vsdb-1.33.0.vsix). Wave 9 shipped: **DBX-06 Reviewed PostgreSQL Rename Workflow** — catalog usage analysis with always-three-value binding + inclusion rules; pure multi-step rename-plan builder with named applied/failed reporting; host preview/confirmation integration with DBX-08 `tableDdl` capability gating and pinned denial literal. 2/2 tasks approved round 1, unic-smart.
- Full suite: **2878 passed | 2 skipped**, typecheck + compile clean.

## Active Work

- None.

## Decisions Pending

- None.

## Next Candidates

1. **PORT-AIX-03** — Read-only analysis copilot.
2. **PORT-AIX-05** (after AIX-03).
3. **PORT-DX-01** — available anytime.

## Recently Completed

- **v1.33.0 — Cycle DBX-06 Reviewed PostgreSQL Rename Workflow** (2026-09-01): catalog usage analysis with always-three-value binding ($1/$2/$3 with table-mode fallback $3="" + short-circuit) and inclusion rules; pure multi-step rename-plan builder with named applied/failed reporting; host preview/confirmation integrated with DBX-08 `tableDdl` capability gating and pinned denial literal. 2/2 approved round 1, unic-smart. Full suite **2878|2** at release. Plan: PLAN_DBX06.md, Tasks: TASK-DBX06-001/002.
- v1.32.0 — Cycle RLX-03 Connection/Tunnel/Schema-refresh Recovery (2026-09-01): typed post-ready SSH tunnel exit + promise-identity coalescing + fresh-spawn-after-rejection; ConnectionManager recovery states `recovering`/`recovered`/`failed`; `SchemaCache.invalidate()` clears inflight WITH the generation bump. 3/3 approved after 1 fix round each, unic-smart. Full suite **2858|2** at release. Plan: PLAN_RLX03.md, Tasks: TASK-RLX03-001/002/003.
- v1.31.0 — Cycle RLX-02 Cross-dialect Query Lifecycle (2026-09-01): MySQL `PoolConnection.destroy` + pre-handoff stream cancel; MSSQL `activeRequests` snapshot + `request.cancel`; `vsdb.cancelQuery` awaits `runner.cancel()` before busy-clear; `mockMysqlTxConnection` `queryImpl` parameter drives natural rejection. unic-smart: TASK-001 fixed round 1, 002/003 APPROVED round 1. Full suite **2838|2 + 1 pre-existing perf flake** at release. Plan: PLAN_RLX02.md, Tasks: TASK-RLX02-001/002/003.
- v1.30.0 — Cycle AIX-08 Extensible MCP Tool Contracts (2026-09-01): curated MCP extension registry, fail-closed v1 declaration grammar, AIX-07/DBX-08 admission, least-privilege context, host-MCP curated call lane. unic-smart 2 reviewers CHANGES-REQUESTED round 1 → 4 fixed.
- v1.29.0 — Cycle DBX-08 Dialect Parity Contract (2026-09-01): `AdapterCapability`/`hasAdapterCapability`, frozen capability matrices, catalog/object-DDL + table-DDL/admin gating. unic-smart 001/003 APPROVED, 002 fixed round 1.
- v1.28.0 — Cycle AIX-07 Trust, Privacy & Governance (2026-08-31): central default-deny AI policy, redacted all-turn audit, host commands, panel policy gating, uniform wire redaction incl. raw-ACP + resumed history; unic-smart review, 2 fix rounds.
