# VSDB Status

- Last meaningful update: 2026-09-01
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **HEAD @ d9d30e3**, v1.30.0 released (tag + VSIX). Wave 6 shipped end-to-end: **DBX-08 Dialect Parity Contract (v1.29.0)** and **AIX-08 Extensible MCP Tool Contracts (v1.30.0)**, each with its own plan/task artifacts, unic-smart review, fix round, full-suite green, tag, and package.
- Full suite: 2825 passed | 2 skipped (pre-existing), typecheck + compile clean.
- omp approval prompts stem from `.omp/config.yml`: `tools.approval.bash` matches ENTIRE non-compound commands only; compound `&&`/`;`/`|` falls through to `approvalMode: write` and prompts. `tools.approval.eval: prompt` always prompts. Normal pattern, not a defect.

## Active Work

- None in flight — Wave 6 is complete. `docs/AI_HANDOFF/RUN.md` cursor is at `done`-equivalent ("final report to user").
- INDEX.md: all active-cycle tasks approved; only `queued — NOT READY` portfolio rows remain, which require a new source-grounded plan per the pipeline rules.

## Decisions Pending

- Whether to continue to the next roadmap wave (Wave 7 candidates: PORT-RLX-02 cross-dialect query lifecycle, or other portfolio rows) — needs a fresh planning cycle (P0 scope question to the user).

## Next Candidates

1. Portfolio PORT-RLX-02 (cross-dialect query lifecycle completion) — first NOT-READY row whose dependency (RLX-01) is done; requires a new plan + unblocking its dependency chain (PORT-RLX-03 etc.).
2. Re-run `ukit:handoff-fullstack` with a new goal for Wave 7.

## Recently Completed

- **v1.30.0 — Cycle AIX-08 Extensible MCP Tool Contracts** (2026-09-01): curated MCP extension registry (`mcpExtensionRegistry.ts`) with fail-closed v1 declaration grammar (pinned `MCP extension contract rejected: ...` literals for every boundary: version, name grammar, unknown keys, scalar types, duplicate/unknown capabilities, padded descriptions), AIX-07 policy + DBX-08 capability admission (malformed policy default-denies, never throws), least-privilege context (`runReadOnlyQuery` bound to the single capability-checked adapter, two-result factory race test; workspace handlers get only `readWorkspaceFile`), exact `MCP extension invalid arguments: ...` literals; host-MCP curated call lane (timeout/crash containment, single-settle late settlement, curated-name collision loses to standard tool). unic-smart review: 2 reviewers CHANGES-REQUESTED in round 1 → 4 findings fixed (trim-strict description, fail-closed policy admission, collision regression, late-settlement regression). Focused 41/41, full suite 2825|2 skipped. Plan: PLAN_AIX08.md (2 review rounds + capped application), Tasks: TASK-AIX08-001/002.
- **v1.29.0 — Cycle DBX-08 Dialect Parity Contract** (2026-09-01): `AdapterCapability`/`AdapterCapabilities` + fail-closed `hasAdapterCapability` in `src/adapters/types.ts`; frozen capability matrices (PG all-true; MySQL/MSSQL all-false); catalog/object-DDL gating across schemaCache/schemaTree/sqlCatalog/ddlView (baseline MySQL/MSSQL navigation + estimate fallback preserved; resolver option `isPostgres`→`declaresCatalog` awaited predicate with fail-closed rejected-predicate helper; accurate non-"Postgres-only" unsupported-DDL document); table-DDL/admin gating across tableCommands/adminTree/adminSessionsPanel/extension (pinned Admin-tree node `VSDB: Admin tools are not supported by this connection's database.`, zero AdminApi calls for undeclared adapters). unic-smart review: 001/003 APPROVED round 1, 002's fail-closed finding fixed round 1. Full suite 2811|2 skipped at release. Plan: PLAN_DBX08.md, Tasks: TASK-DBX08-001/002/003.
- v1.28.0 — Cycle AIX-07 Trust, Privacy & Governance (2026-08-31): central default-deny AI policy, redacted all-turn audit export, host commands, panel policy gating, uniform wire redaction incl. raw-ACP + resumed history; unic-smart review, 2 fix rounds.
- v1.27.0 — Cycle RLX-01 Operational Reliability Foundation (2026-08-31): PG non-cursor cancellation, SchemaCache single-flight coalescing, fail-closed import plan validation; unic-smart APPROVED round 2 after 1 auto-fix round each.
- v1.26.0 — Cycle AIX-06 Agent Trace & Replay (2026-08-31): TraceRecorder (redaction-first, bounded), OmpChatEngine trace hook, builtin bridge, panel wiring; unic-smart APPROVED after the DBX-07 r3 fix pass.
