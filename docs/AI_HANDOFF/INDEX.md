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
| PORT-RLX-03 | Connection, tunnel, and schema-refresh recovery | active — planned in Cycle RLX-03 | RLX-01, PORT-RLX-02 | unic-smart |
| PORT-DBX-06 | Reviewed PostgreSQL rename workflow | active — expanded plan ready | PORT-RLX-03 | unic-smart |
| PORT-DBX-08 | Explicit adapter capability parity | superseded (shipped in v1.29.0) | - | unic-smart |
| PORT-AIX-03 | Read-only database analysis copilot hardening | superseded (shipped v1.34.0) | - | unic-smart |
| PORT-AIX-05 | Optional OMP engine resilience | superseded (shipped v1.35.0) | - | unic-smart |
| TASK-AIX05-101 | ACP child lifecycle and bounded reaping | done | none | unic-smart |
| TASK-AIX05-102 | Terminal MCP bridge disposal guard | done | none | unic-smart |
| TASK-AIX05-103 | Production OMP engine lifecycle, fallback, and context continuity | done | TASK-AIX05-101, TASK-AIX05-102 | unic-smart |
| PORT-AIX-06/07 | Redacted agent trace and centralized governance | superseded (shipped in v1.26.0–v1.28.0) | - | unic-smart |
| PORT-DX-01 | Regression and release confidence lane | superseded (shipped in v1.36.0) | - | unic-smart |

## Cycle AIX-03 — Read-only Database Analysis Copilot Hardening

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-AIX03-101 | Parser hardening + row-cap/sentinel redaction | done | fix round 1 verified | unic-smart |
| TASK-AIX03-102 | Connection-loss bounded propagation (RLX-03 consumer) | done | fix round 1 verified | unic-smart |
| TASK-AIX03-103 | Tool-result attribution in the redacted audit trace | done | approved round 1 | unic-smart |
| PORT-AIX-03 | Read-only database analysis copilot hardening | superseded (shipped v1.34.0) | - | unic-smart |

Graph: TASK-AIX03-101 independent; TASK-AIX03-102 independent; TASK-AIX03-103 independent.

- Wave 1 (3): TASK-AIX03-101, TASK-AIX03-102, TASK-AIX03-103

No same-wave target-file overlap: TASK-AIX03-101 owns `readonlySqlParser.ts`/`sqlTool.ts`/`dbAwareTools.ts`; TASK-AIX03-102 owns `ompChatEngine.ts`/`aiChatPanel.ts`; TASK-AIX03-103 owns `agent.ts` (+ its test only). Plan: `docs/AI_HANDOFF/PLAN_AIX03.md`.

Graph: TASK-AIX07-001 independent; TASK-AIX07-002 independent; TASK-AIX07-003 independent.

- Wave 1 (2): TASK-AIX07-001, TASK-AIX07-002
- Wave 2 (1): TASK-AIX07-003

No same-wave target-file overlap. Portfolio rows require a new source-grounded plan and task batch before becoming active.

## Cycle AIX-05 — Optional OMP Engine Resilience

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-AIX05-101 | ACP child lifecycle and bounded reaping | done | none | unic-smart |
| TASK-AIX05-102 | Terminal MCP bridge disposal guard | done | none | unic-smart |
| TASK-AIX05-103 | Production OMP engine lifecycle, fallback, and context continuity | done | TASK-AIX05-101, TASK-AIX05-102 | unic-smart |
| PORT-AIX-05 | Optional OMP engine resilience | superseded (shipped v1.35.0) | - | unic-smart |

Graph: TASK-AIX05-101 → TASK-AIX05-103; TASK-AIX05-102 → TASK-AIX05-103.

- Wave 1 (2): TASK-AIX05-101, TASK-AIX05-102
- Wave 2 (1): TASK-AIX05-103

No same-wave target-file overlap: TASK-AIX05-101 owns `acpProcess.ts` and its test; TASK-AIX05-102 owns `mcpBridge.ts` and its test; TASK-AIX05-103 begins only after both lifecycle seams exist and owns production engine/panel/extension integration. Plan: `docs/AI_HANDOFF/PLAN_AIX05.md`.

## Cycle DBX-06 — Reviewed PostgreSQL Rename Workflow Expansion

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-DBX06-005 | Expanded PostgreSQL rename catalog and typed plan | done | approved round 1 | unic-smart |
| TASK-DBX06-006 | Expanded rename preview and confirmed execution | done | approved round 1 | TASK-DBX06-005 | unic-smart |
| PORT-DBX-06 | Reviewed PostgreSQL rename workflow | active — expanded plan ready | PORT-RLX-03 | unic-smart |

Graph: TASK-DBX06-005 → TASK-DBX06-006. Historical `TASK-DBX06-001 → TASK-DBX06-002 → TASK-DBX06-003 → TASK-DBX06-004` was approved and released as v1.23.0; its task files remain immutable handoff evidence.

- Wave 1 (1): TASK-DBX06-005
- Wave 2 (1): TASK-DBX06-006

No same-wave target-file overlap. Current source confirms `registerTableCommands` is imported and activated by `src/extension.ts:34,218`; rename command handlers live in `src/ui/tableCommands.ts:469-534`, not the stale portfolio anchor `src/extension.ts:1231-1368`.

## Cycle AIX-08 — Extensible MCP Tool Contracts

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-AIX08-001 | Curated MCP extension registry and least-privilege contract | approved | fix round 1 verified | unic-smart |
| TASK-AIX08-002 | Contain curated extensions in host MCP calls | approved | fix round 1 verified | unic-smart |

Graph: TASK-AIX08-001 → TASK-AIX08-002.

- Wave 1 (1): TASK-AIX08-001
- Wave 2 (1): TASK-AIX08-002

No same-wave target-file overlap. The registry contract is intentionally separate from host transport integration.

## Cycle RLX-03 — Connection, Tunnel, and Schema-Refresh Recovery

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-RLX03-001 | Make SSH child exit observable and restart-safe | done | fix round 1 verified | unic-smart |
| TASK-RLX03-002 | Bound active tunnel reconnects and surface status | done | fix round 1 verified | unic-smart |
| TASK-RLX03-003 | Invalidate SchemaCache on adapter replacement | done | fix round 1 verified | unic-smart |

Graph: TASK-RLX03-001 → TASK-RLX03-002; TASK-RLX03-003 independent.

- Wave 1 (2): TASK-RLX03-001, TASK-RLX03-003
- Wave 2 (1): TASK-RLX03-002

No same-wave target-file overlap. Connection recovery is sequenced only behind the real post-ready tunnel-exit interface; cache adapter-identity invalidation remains independent.

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
