# VSDB Status

- Last meaningful update: 2026-09-01
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **HEAD @ de405a5**, v1.32.0 released (tag + vsdb-1.32.0.vsix). Wave 8 shipped: **RLX-03 Connection/Tunnel/Schema-refresh Recovery** — typed post-ready SSH tunnel exit with promise-identity coalescing + fresh-spawn-after-rejection; bounded ConnectionManager recovery states `recovering`/`recovered`/`failed`, exactly 2 attempts, injected clock, disposed-flag gating with post-dispose regression; `SchemaCache.invalidate()` clears inflight WITH the generation bump, closing the cross-adapter coalescing leak. 3/3 tasks approved after 1 fix round each, unic-smart review.
- Full suite: **2858 passed | 2 skipped**, typecheck + compile clean.

## Active Work

- None.

## Decisions Pending

- None — continuous autonomous execution per user directive; next cycle **PORT-DBX-06** (deps satisfied).

## Next Candidates

1. **PORT-DBX-06** — Reviewed PG rename workflow.
2. **PORT-AIX-03** — Read-only analysis copilot.
3. **PORT-AIX-05** (after AIX-03).
4. **PORT-DX-01** — available anytime.

## Recently Completed

- **v1.32.0 — Cycle RLX-03 Connection/Tunnel/Schema-refresh Recovery** (2026-09-01): typed post-ready SSH tunnel exit + promise-identity coalescing (`assert p2 === p1`) + fresh-spawn-after-rejection; ConnectionManager recovery states `recovering`/`recovered`/`failed` (exactly 2 attempts, injected clock, disposed-flag gating, post-dispose regression test); `SchemaCache.invalidate()` clears inflight WITH the generation bump — closes cross-adapter single-flight leak (regression test must start B's lookup while A is still deferred; resolve-order matters). 3/3 approved after 1 fix round each, unic-smart review. Full suite **2858|2** at release. Plan: PLAN_RLX03.md, Tasks: TASK-RLX03-001/002/003.
- v1.31.0 — Cycle RLX-02 Cross-dialect Query Lifecycle (2026-09-01): MySQL `PoolConnection.destroy` + pre-handoff stream cancel; MSSQL `activeRequests` snapshot + `request.cancel`; `vsdb.cancelQuery` awaits `runner.cancel()` before busy-clear; `mockMysqlTxConnection` `queryImpl` parameter drives natural rejection. unic-smart: TASK-001 fixed round 1, 002/003 APPROVED round 1. Full suite **2838|2 + 1 pre-existing perf flake** at release. Plan: PLAN_RLX02.md, Tasks: TASK-RLX02-001/002/003.
- v1.30.0 — Cycle AIX-08 Extensible MCP Tool Contracts (2026-09-01): curated MCP extension registry, fail-closed v1 declaration grammar, AIX-07/DBX-08 admission, least-privilege context, host-MCP curated call lane. unic-smart 2 reviewers CHANGES-REQUESTED round 1 → 4 fixed.
- v1.29.0 — Cycle DBX-08 Dialect Parity Contract (2026-09-01): `AdapterCapability`/`hasAdapterCapability`, frozen capability matrices, catalog/object-DDL + table-DDL/admin gating. unic-smart 001/003 APPROVED, 002 fixed round 1.
- v1.28.0 — Cycle AIX-07 Trust, Privacy & Governance (2026-08-31): central default-deny AI policy, redacted all-turn audit, host commands, panel policy gating, uniform wire redaction incl. raw-ACP + resumed history; unic-smart review, 2 fix rounds.
