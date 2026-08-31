# VSDB Status

- Last meaningful update: 2026-08-31
- Updated by: Claude
- Status confidence: high

## Snapshot

- Branch/state: `main` — **HEAD @ e1cb41a**, v1.25.0 released. Cycles AIX-05 and AIX-06 shipped on main; **DBX-07 (AIX-06 r3 review fixes) landed at e1cb41a** with plan/index/task artifacts + 70 focused tests green + full suite 2715 passed.
- Active handoff cycle (per ACTIVE.md): **RLX-01 Operational Reliability Foundation** — planning_done, 3 tasks ready (TASK-RLX-001 cancel active non-cursor PG queries; TASK-RLX-002 coalesce SchemaCache stale refreshes; TASK-RLX-003 fail closed on malformed import plans).
- Wave roadmap: Wave 5 = DBX-07 ✅ → AIX-06 cycle-review close → AIX-07; Wave 6 = DBX-08, AIX-08.
- Durable two-pillar product queue: `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` with its portfolio plan in `PLAN_PRODUCT_VISION.md`; `ROADMAP.md` is the compatibility index.
- omp approval prompts stem from `.omp/config.yml`: `tools.approval.bash` matches ENTIRE non-compound commands only; compound `&&`/`;`/`|` falls through to `approvalMode: write` and prompts. `tools.approval.eval: prompt` always prompts. Normal pattern, not a defect.

## Active Work
- **DBX-07 done** (commit e1cb41a, awaiting reviewer verdict). Next: unic-smart cycle review → close AIX-06 (ship v1.26.0).
- **RLX-01** planning_done; 3 tasks ready in `docs/AI_HANDOFF/tasks/TASK-RLX-{001,002,003}.md`. Order: 001 (PG cancel) → 002 (schema cache coalesce) → 003 (import plan gate). Coordinate with omp before executing to avoid conflicts.
- AHL is archived as completed historical work; its artifacts remain preserved under `docs/AI_HANDOFF/`.

## Decisions Pending

- None blocking.

## Next Candidates
1. unic-smart cycle review for DBX-07 (TASK-DBX07-001 verdict) → then close AIX-06 (ship v1.26.0).
2. Execute RLX-01 (TASK-RLX-001 → 002 → 003) for v1.27.0.
3. Resume roadmap waves (AIX-07, DBX-08, AIX-08 → v1.28.0+) after RLX-01 ships.

## Recently Completed
- **DBX-07 (AIX-06 r3)** at e1cb41a: `TurnState { turnId, seq }` + `buildEv()` in ompChatEngine so `onTrace` works with a real monotonic seq even without a recorder (state allocated when recorder OR onTrace subscriber exists); KV_RE extended with `authorization|auth` so bare `Authorization=ab` forms scrub; agent.ts "AI is not configured" no longer double-records (outer catch is the single error emission point). New r3 tests: Authorization=ab, auth=tk alias, onTrace-monotonic-seq-without-recorder, recorder+onTrace co-existence. 70 focused tests + full suite 2715 passed + typecheck clean. Plan: PLAN_DBX07.md, Index: INDEX_DBX07.md, Task: TASK-DBX07-001.md.
- AIX-06 implementation: TraceRecorder pure module (redaction, bounded storage, global insertion order), OmpChatEngine trace hook (onTrace event with records-before-emit ordering, KV_RE whitespace+no-min), builtin path bridge via `runAgent` accepting trace, AiChatPanel wiring + scaffold + CHANGELOG/README; r1 fixed redaction false negatives, ordering, delta/thought/onTrace emission; r2 fixed outer error catch. Awaiting cycle-review verdict.
- v1.25.0: Cycle AIX-05 OMP Agent Workbench — `session_state` wire + webview chip, `OmpChatEngine.cancel` (no-op/idempotent/restart-safe with `sessionNewInFlight` gate + `pendingCancel` drain), panel Stop parity in omp+ompChatEngine mode, `dispatchNotification` crash-proof (top-level `isParamsRecord` + toolCallId guard), `resolveEngine` reason→hint pinned, builtin↔OMP/MCP tool permission parity via `registerStandardToolset`; unic-smart APPROVED after 2 fix rounds.

- v1.24.0: Cycle AIX-04 Database Change Workflow — plan_change reviewed change plans (danger tiers + live-schema drift, READ-ONLY), ONE shared confirmDangerousStatements consent gate, change_plan consent card (Approve/Reject, disabled when drifted, drift re-check at approve), per-statement sequential apply with partial-failure + cancel reporting, builtin + OMP/MCP registry parity; unic-smart APPROVED after 2 fix rounds.
- v1.23.0: Cycle DBX-06 Safe Rename Refactor — catalog usage analysis, reviewable ALTER plan, rename dialog with per-statement progress/cancel; unic-smart APPROVED after 2 fix rounds.
- v1.22.0: Cycle AIX-03 Database Analysis Copilot — visible tool-call cards (shape-only, incl. denial + OMP parity), analyze_table composite (injection-guarded), diagnose_query classifier; unic-smart APPROVED after 2 fix rounds.
- v1.21.0: Cycle AIX-02 Safe File Operations — gated workspace_write tool (exact URI allowlist, request-scoped snapshot binding, host CAS atomic writes, workspace-trust gate), unified diff preview on the approval card (builtin + omp/MCP); unic-smart APPROVED after 4 fix rounds.
- v1.20.0: Cycle DBX-05 Connection Workspace — folder grouping, read-only guard (client-side mutation block with EXPLAIN/CTE regressions), SSH tunnels with listener PID identity proof; unic-smart APPROVED after 6 fix rounds.
- v1.19.0: Cycle AIX-01 Grounded Workspace Context — selection/file grounding with line-ranged attribution, bounded workspace_search tool (both engines), panel toggle chips; unic-smart APPROVED after 2 fix rounds.
- v1.18.0: Cycle DBX-04 Relationship Explorer — FK graph, layered layout, SVG export, pan/zoom panel, vsdb.relationshipExplorer; unic-smart APPROVED after 3 fix rounds.
- v1.17.0: Cycle DBX-03 Schema & Data Compare — schemaDiff/dataDiff/syncPlan pure modules, compare service + preview panel, vsdb.compareTables; unic-smart APPROVED after 2 fix rounds.

- v1.16.0: Cycle DBX-01 Data Workbench Completion — CSV/JSON import wizard, form view, vsdb-lv large-value editor, parameterized DbTransaction seam.
- v1.15.0: Cycle DBX-02 SQL Intelligence Navigation — catalog resolver + FK/root completion, hover/definition virtual docs, parsed find-usages, activation wiring.
- v1.14.0: Cycle AIC SQL autocomplete (settings + form + migration; cancellable schema-only service; editor + Console ghost-text; extension wiring).

- v1.12.0: Cycle AF database catalog/DDL viewer/formatter/Console v2; Cycle AG AI-chat toolbar icons; Cycle AI below-editor results placement.
- v1.13.0: Cycle AH DataGrip-style accumulating multi-statement results.
- AE.5 OMP activation shim caveat recorded as resolved in handoff active state.
