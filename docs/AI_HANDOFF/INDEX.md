# INDEX

Cycle AIX-07 — **Trust, Privacy & Governance** — complete; shipped in v1.28.0. Cycle DX-01 — Release confidence lane — shipped in v1.36.0. Cycle ARP-02 — shutdown-safe query ownership — shipped in v1.38.0. Cycle ARP-03 — retained-result memory budget — shipped in v1.39.0 (2026-09-02). Cycle ARP-04 — tunnel and endpoint identity hardening — shipped in v1.40.0 (2026-09-02; 5/5 tasks approved round 1, released). Cycle ARP-05 — cross-driver resilience contract — shipped in v1.41.0. Cycle ARP-06 — AI SQL policy unification and usage visibility — shipped in v1.42.0. Cycle ARP-07 — successful-DDL cache/context invalidation — shipped in v1.43.0 (2026-09-02; 4/4 tasks approved round 1, released). Cycle ARP-08 — console draft recovery — shipped in v1.44.0 (2026-09-02; 4/4 tasks approved round 1, released).

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-RLX-001 | Cancel active PostgreSQL non-cursor queries | done | none | unic-smart |
| TASK-RLX-002 | Coalesce SchemaCache stale refreshes | done | none | unic-smart |
| TASK-RLX-003 | Fail closed on malformed import execution plans | done | none | unic-smart |
| TASK-AIX07-001 | Central effective AI policy (pure) | done | fix round 1 verified | unic-smart |
| TASK-AIX07-002 | Redacted all-turn audit export primitive | done | fix round 1 verified | unic-smart |
| TASK-AIX07-003 | Policy and audit command host integration | done | fix round 2 verified | unic-smart |
| TASK-DBX07-001 | AIX-06 Trace r3 review fixes | done | none | unic-smart |
| PORT-RLX-02 | Cross-dialect query lifecycle completion | superseded (shipped in v1.31.0) | - | unic-smart |
| PORT-RLX-03 | Connection, tunnel, and schema-refresh recovery | superseded (shipped in v1.32.0) | - | unic-smart |
| PORT-DBX-06 | Reviewed PostgreSQL rename workflow | superseded (shipped in v1.33.0) | - | unic-smart |
| PORT-DBX-08 | Explicit adapter capability parity | superseded (shipped in v1.29.0) | - | unic-smart |
| PORT-AIX-03 | Read-only database analysis copilot hardening | superseded (shipped v1.34.0) | - | unic-smart |
| PORT-AIX-05 | Optional OMP engine resilience | superseded (shipped v1.35.0) | - | unic-smart |
| TASK-AIX05-101 | ACP child lifecycle and bounded reaping | done | none | unic-smart |
| TASK-AIX05-102 | Terminal MCP bridge disposal guard | done | none | unic-smart |
| TASK-AIX05-103 | Production OMP engine lifecycle, fallback, and context continuity | done | TASK-AIX05-101, TASK-AIX05-102 | unic-smart |
| PORT-AIX-06/07 | Redacted agent trace and centralized governance | superseded (shipped in v1.26.0–v1.28.0) | - | unic-smart |
| PORT-DX-01 | Regression and release confidence lane | superseded (shipped in v1.36.0) | - | unic-smart |
| PORT-ARP-01 | Read-only enforcement completeness | superseded (shipped in v1.37.0) | - | unic-smart |
| PORT-ARP-02 | Shutdown-safe query ownership and connection provenance | superseded (shipped in v1.38.0) | - | unic-smart |
| PORT-ARP-03 | Retained-result memory budget | superseded (shipped in v1.39.0) | - | unic-smart |
| PORT-ARP-04 | Tunnel and endpoint identity hardening | superseded (shipped in v1.40.0) | - | unic-smart |
| PORT-ARP-05 | Cross-driver timeout/pool resilience contract | superseded (shipped in v1.41.0) | - | unic-smart |
| PORT-ARP-06 | AI SQL policy unification and usage visibility | superseded (shipped in v1.42.0) | - | unic-smart |
| PORT-ARP-07 | Successful-DDL cache/context invalidation | superseded (shipped in v1.43.0) | ARP-01 | unic-smart |
| PORT-ARP-08 | Console draft recovery | superseded (shipped in v1.44.0) | ARP-03 | unic-smart |
| PORT-ARP-09 | Redacted support diagnostics + release-confidence profiles | active — implementation done, pending review | ARP-02, ARP-05, ARP-06 | unic-smart |

## Cycle ARP-05 — Cross-driver timeout, pool, and resilience contract

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP05-000 | ADR: cross-driver resilience contract (measured matrix + SLO/no-replay) | done | none | - |
| TASK-ARP05-001 | PostgreSQL pool isolation, failed-connect/close release, cancel recovery | done | TASK-ARP05-000 | - |
| TASK-ARP05-002 | MySQL held-connection streaming + bounded acquire wait | done | TASK-ARP05-000 | - |
| TASK-ARP05-003 | MSSQL paused-stream survival, cancel timeout, no enqueue wedge | done | TASK-ARP05-000 | - |
| TASK-ARP05-004 | Host message normalization (conditional gate) | done | TASK-ARP05-000, TASK-ARP05-001, TASK-ARP05-002, TASK-ARP05-003 | - |

Graph: TASK-ARP05-000 → TASK-ARP05-001; TASK-ARP05-000 → TASK-ARP05-002; TASK-ARP05-000 → TASK-ARP05-003;
TASK-ARP05-000, 001, 002, 003 → TASK-ARP05-004.

- Wave 0 (1): TASK-ARP05-000 (docs gate — no source change before it)
- Wave 1 (3): TASK-ARP05-001, TASK-ARP05-002, TASK-ARP05-003
- Wave 2 (1): TASK-ARP05-004 (conditional — closes as not-needed if the ADR measurement shows the host error UX is already actionable)

No same-wave file sharing: 000 owns `docs/decisions/` only; 001 owns `src/adapters/postgres.ts`(+`postgres.test.ts`); 002 owns `src/adapters/mysql.ts`(+ new `mysqlQueueBound.test.ts` + `adapterQueryShape.test.ts`); 003 owns `src/adapters/mssql.ts`(+`mssql.parameterized.test.ts`); 004 owns `src/core/connectionManager.ts`(+`connectionManager.test.ts`) in wave 2 only. Driver suites are DB-free (pg/mysql2/tedious mocked); integration suites are DB-gated and run only via the cycle `npm run test:integration` net. Baseline: 3025 passed | 2 skipped at `main @ 65b9c4f` (v1.40.0). Plan: `docs/AI_HANDOFF/PLAN.md`.

## Cycle ARP-06 — AI SQL policy unification and usage visibility

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-06 (lines 277-320). Dep: ARP-01 (shipped v1.37.0); preserve AIX-07/AIX-08 unchanged. Base: `main @ 6ee4c51` (v1.41.0). One fail-closed policy decision (ADR `0003`) with two documented profiles (`parseReadonly` core; `isReadOnlySql` run_sql) + privacy-safe usage/budget display.

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP06-001 | Fail-closed policy decision API + security parser corpus (readonlySqlParser + ADR 0003) | done | none | - |
| TASK-ARP06-002 | run_sql tool adoption: only approved SQL executes | done | none | - |
| TASK-ARP06-003 | Usage transport: missing/malformed safe, final usage once, no body retained | done | none | - |
| TASK-ARP06-004 | Per-turn usage accounting + bounded-session budget (agent) | done | none | - |
| TASK-ARP06-005 | Privacy-safe policy + usage display in the chat panel | done | TASK-ARP06-004 | - |

Graph: TASK-ARP06-001 independent; TASK-ARP06-002 independent; TASK-ARP06-003 independent;
TASK-ARP06-004 independent; TASK-ARP06-004 → TASK-ARP06-005.

- Wave 1 (3): TASK-ARP06-001, TASK-ARP06-002, TASK-ARP06-003 (parallel — disjoint `src/` files)
- Wave 2 (1): TASK-ARP06-004 (agent accounting — the panel must not re-invent it)
- Wave 3 (1): TASK-ARP06-005 (panel display, consumes 004's `AgentRunResult.usage`)

No same-wave file sharing: 001 owns `readonlySqlParser.ts`(+test) + `docs/decisions/0003-ai-sql-policy.md` (new; no other task appends); 002 owns `sqlTool.ts`(+test); 003 owns `provider.ts`(+`provider.test.ts`); 004 owns `agent.ts`(+`agent.test.ts`); 005 owns `aiChatPanelMessages.ts` + `aiChatPanel.ts` + `webview/aiChatPanelMain.ts` + `aiChatPanelPolicy.test.ts` + `aiChatPanel.test.ts` + `aiChatPanelSessionStateWebview.test.ts`. Security-sensitive cycle: mandatory parser corpus + redaction review. No lint script — static gate is `npm run typecheck`. Plan: `docs/AI_HANDOFF/PLAN.md`.

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

## Cycle ARP-02 — Shutdown-safe Query Ownership and Connection Provenance

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP02-001 | Cancel ownership: sticky cancel + in-flight-scoped pending + monotonic seq | done | none | unic-smart |
| TASK-ARP02-002 | Panel-close session-epoch guard for deferred continuations | done | none | unic-smart |
| TASK-ARP02-003 | Late-completion connection provenance (per-connection revision map) | done | none | unic-smart |
| TASK-ARP02-004 | Host integration: runStatements busy ownership + deactivate fence | done | TASK-ARP02-001, TASK-ARP02-002 | unic-smart |

Graph: TASK-ARP02-001 independent; TASK-ARP02-002 independent; TASK-ARP02-003 independent; TASK-ARP02-001 → TASK-ARP02-004; TASK-ARP02-002 → TASK-ARP02-004.

- Wave 1 (3): TASK-ARP02-001, TASK-ARP02-002, TASK-ARP02-003
- Wave 2 (1): TASK-ARP02-004

No same-wave target-file overlap. Plan: docs/AI_HANDOFF/PLAN_ARP02.md.

## Cycle ARP-03 — Retained-Result Memory Budget

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP03-001 | Pure retained-result budget helper | done | none | unic-smart |
| TASK-ARP03-002 | Runner enforcement: retained-row cap + one-shot cursor close + graceful no-op | done | TASK-ARP03-001 | unic-smart |
| TASK-ARP03-003 | Panel state: limited statements ride the wire without an error toast | done | TASK-ARP03-002 | unic-smart |
| TASK-ARP03-004 | Webview UX: distinct truncated state + Load More gate closes | done | TASK-ARP03-002 | unic-smart |

Graph: TASK-ARP03-001 → TASK-ARP03-002 → TASK-ARP03-003; TASK-ARP03-002 → TASK-ARP03-004.

- Wave 1 (1): TASK-ARP03-001
- Wave 2 (1): TASK-ARP03-002
- Wave 3 (2): TASK-ARP03-003, TASK-ARP03-004

No same-wave target-file overlap: TASK-ARP03-001 owns `resultBatcher.ts`/its test; TASK-ARP03-002 owns `queryRunner.ts`/its test; TASK-ARP03-003 owns `resultsPanel.ts`/its test; TASK-ARP03-004 owns `webview/main.ts` + new `src/ui/__tests__/webviewResultLimit.test.ts`. Plan: docs/AI_HANDOFF/PLAN.md.

## Cycle ARP-04 — Tunnel and Endpoint Identity Hardening

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP04-000 | ADR: SSH host-key identity policy (mandatory gate) | done | none | - |
| TASK-ARP04-001 | Identity input: pinned strict host-key checking | done | TASK-ARP04-000 | - |
| TASK-ARP04-002 | Lifecycle/race + fail-closed PID proof + spawned-argv strict pin | done | TASK-ARP04-000, TASK-ARP04-001 | - |
| TASK-ARP04-003 | Manager integration: intended-key stop + loopback retention | done | TASK-ARP04-001, TASK-ARP04-002 | - |
| TASK-ARP04-004 | Form wiring gate (verify-only, expected close not-needed) | done | TASK-ARP04-003 | - |

Graph: TASK-ARP04-000 → TASK-ARP04-001 → TASK-ARP04-002 → TASK-ARP04-003 → TASK-ARP04-004.

- Wave 0 (1): TASK-ARP04-000 (docs gate — no source change before it)
- Wave 1 (1): TASK-ARP04-001
- Wave 2 (1): TASK-ARP04-002 (spawn-path strict pin needs 001's builder change)
- Wave 3 (1): TASK-ARP04-003
- Wave 4 (1): TASK-ARP04-004

Chain (no same-wave file sharing): TASK-ARP04-001 owns `sshTunnel.ts`/its test; TASK-ARP04-002 owns `sshTunnelManager.ts`/its test + new fixture `fake-ssh-foreign.mjs`; TASK-ARP04-003 owns `connectionManager.ts`/its test; TASK-ARP04-004 is inspection-only (no files). The tests-map overlap (`sshTunnel.ts`/`sshTunnelManager.ts` → both unit files) is moot for wave disjointness now that 001 and 002 run in separate waves; each task still pins its OWN owned test file. Recorded policy: explicit `-o StrictHostKeyChecking=yes` (overrides `~/.ssh/config` relaxations — intended fail-closed change), no `UserKnownHostsFile`, no relaxing flags, no form input. Plan: docs/AI_HANDOFF/PLAN.md.

## Cycle ARP-07 — Successful-DDL cache/context invalidation

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-07 (lines 320-358). Dep: ARP-01 (shipped v1.37.0); preserve ARP-02 ownsRun/deactivate sentinel, ARP-03 row cap, ARP-04 tunnel identity, ARP-06 AI policy. Base: `main @ aa01a78` (v1.42.0). No lint script — static gate is `npm run typecheck`. No ADR (additive cache hygiene wiring existing invalidate() seams; `0004` free but unused).

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP07-001 | Schema-impact classifier (pure core, dialect-aware) | done | none | unic-smart (approved_minor r1; minors noted non-blocking) |
| TASK-ARP07-002 | Schema cache race: invalidate-during-fetch (verify-first) | done | none | unic-smart (approved r1) |
| TASK-ARP07-003 | AI schema cache: invalidate-during-hydration stale-commit fix | done | none | unic-smart (approved r1) |
| TASK-ARP07-004 | Execution wiring: successful-DDL invalidation via host seam | done | TASK-ARP07-001, TASK-ARP07-002, TASK-ARP07-003 | unic-smart (approved r1) |

Graph: TASK-ARP07-001 independent; TASK-ARP07-002 independent; TASK-ARP07-003 independent;
TASK-ARP07-001, 002, 003 → TASK-ARP07-004.

- Wave 1 (3): TASK-ARP07-001, TASK-ARP07-002, TASK-ARP07-003 (parallel — disjoint `src/` files)
- Wave 2 (1): TASK-ARP07-004 (wiring imports 001's classifier; 002/003 prove the invalidate() seams are safe before the host uses them)

No same-wave file sharing: 001 owns `src/core/schemaImpact.ts`(+new `schemaImpact.test.ts`) — new core file sanctioned by the roadmap; 002 owns `schemaCache.ts`(verify-only, expected no change) + `schemaCache.test.ts`; 003 owns `schemaContextCache.ts` + `schemaContextResolver.test.ts` (the tests-map entry for `schemaContextCache.ts` is stale — resolves to `formatSchemaContext` tests; pin the resolver file); 004 owns `extension.ts` + `extension.test.ts` in wave 2 only. Roadmap's `extension.ts:294-312,492-499,657-687,1433-1470` citations are stale — actual wiring: `schemaCache.invalidate()` at `331-333`, `vsdb.refreshSchema` at `521-526`, `acSchemaCache.invalidate()` at `718-721`, `runStatements` at `1705-1769`. Known gap (PLAN.md Self-Audit): form-view DDL (`tableCommands.ts` `runDdl`) and AI plan-apply (`aiChatPanel.ts`) run `adapter.runQuery` directly and are NOT wired this cycle (files outside the roadmap candidate set); the module-level seam is the designed follow-up consumption point. Plan: `docs/AI_HANDOFF/PLAN.md`.

## Cycle ARP-08 — Console draft recovery

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-08 (lines 361-393). Dep: ARP-03 (shipped v1.39.0); preserve ARP-02 ownsRun/deactivate sentinel + AIC-004 ghost-text seams byte-untouched. Base: `main @ 8dca6d2` (v1.43.0). Baseline: 3120 passed | 2 skipped. No lint script — static gate `npm run typecheck`; bundle gate `npm run compile`. Workspace-scoped (workspaceState) versioned bounded draft recovery; history stays globalState; corrupt→one empty tab; clear is durable; never runs SQL. Plan: `docs/AI_HANDOFF/PLAN.md`.

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP08-001 | Persisted draft model: snapshot codec + clearDrafts wire (pure) | done | none | unic-smart (approved_minor r1) |
| TASK-ARP08-002 | Host draft restore: hydrate, debounced flush, dispose flush, durable clear | done | TASK-ARP08-001 | unic-smart (approved r1) |
| TASK-ARP08-003 | Webview draft UX: debounced flush, flush-before-switch, Clear drafts, restore pre-input | done | TASK-ARP08-001 | unic-smart (approved r1) |
| TASK-ARP08-004 | Extension wiring: workspaceState as draftMemento + retained singleton/history guarantees | done | TASK-ARP08-001, TASK-ARP08-002 | unic-smart (approved r1) |

Graph: TASK-ARP08-001 → TASK-ARP08-002; TASK-ARP08-001 → TASK-ARP08-003; TASK-ARP08-001, TASK-ARP08-002 → TASK-ARP08-004.

- Wave 1 (1): TASK-ARP08-001 (pure codec + clearDrafts guard — nothing else can land before it)
- Wave 2 (2): TASK-ARP08-002, TASK-ARP08-003 (parallel — disjoint files)
- Wave 3 (1): TASK-ARP08-004 (consumes 001's constants + 002's `draftMemento` option)

No same-wave file sharing: 001 owns `consolePanelMessages.ts`(+`consolePanelMessages.test.ts`); 002 owns `consolePanel.ts`(+`consolePanel.test.ts`); 003 owns `webview/consolePanelMain.ts` + `consolePanelBundle.test.ts` + `consoleTabs.test.ts` (neighbor pin); 004 owns `extension.ts`(+`extension.test.ts`) in wave 3 only. Citation corrections (roadmap anchors stale): constructor seeds `Query 1` at `consolePanel.ts:143-144`, `hydrateHistory` at `310-318`; singleton `extension.ts:99`, `commandOpenConsole` at `1584-1633`, registration `753-754` passes `context.globalState`, deactivate dispose at `1067-1068`; webview NEVER posts updateBuffer (`consolePanelMain.ts:157-160`) — the debounced flush is both the draft-flush mechanism and the switch-clobber divergence fix. Known gap (PLAN.md Self-Audit): ~500ms debounce can lose the last keystrokes on abrupt webview death (flush-on-hidden/unload/dispose narrows it); jsdom `visibilityState` override may be needed for the hidden-flush pin (beforeunload covers the same flush function). Plan: `docs/AI_HANDOFF/PLAN.md`.

## Cycle ARP-09 — Redacted support diagnostics and release-confidence profiles

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-09 (lines ~399-431). Dep: ARP-02, ARP-05, ARP-06 (all shipped); preserve ARP-02 deactivate sentinel, ARP-06 AI policy, ARP-07 DDL-invalidation seam, ARP-08 draft wiring byte-untouched. Base: `main @ c2baff7` (v1.44.0). Baseline: 3160 passed | 2 skipped. No lint script — static gate `npm run typecheck`; bundle gate `npm run compile`. Release: v1.45.0. Verified: zero `createOutputChannel` in `src/`; `trace.ts` `redact()` (line 57) importable from `src/core/diagnostics.ts`; `verify:release`/baseline scripts pinned byte-identical by `releaseVerify.test.ts` (new profiles are NEW `profile:*` keys only). Plan: `docs/AI_HANDOFF/PLAN.md`.

| Task / Portfolio | Title | Status | Dependencies | Reviewer |
|---|---|---|---|---|
| TASK-ARP09-001 | Pure redacted diagnostics formatter (new `src/core/diagnostics.ts`) | pending_review | none | - |
| TASK-ARP09-002 | Release-confidence profiles: `profile:fast` / `profile:release` + hygiene pins | pending_review | none | - |
| TASK-ARP09-003 | Lazy redacted Output Channel wiring + reveal/clear commands | pending_review | TASK-ARP09-001 | - |
| TASK-ARP09-004 | Redaction-reuse gate (verify-first, expected not-needed) | pending_review | TASK-ARP09-001 | - |
| TASK-ARP09-005 | Runner gate (conditional, expected not-needed) | pending_review | TASK-ARP09-002 | - |
| PORT-ARP-09 | Redacted support diagnostics + release-confidence profiles | active — implementation done, pending review | ARP-02, ARP-05, ARP-06 | unic-smart |

Graph: TASK-ARP09-001 independent; TASK-ARP09-002 independent; TASK-ARP09-001 → TASK-ARP09-003; TASK-ARP09-001 → TASK-ARP09-004; TASK-ARP09-002 → TASK-ARP09-005.

- Wave 1 (2): TASK-ARP09-001, TASK-ARP09-002 (parallel — disjoint files)
- Wave 2 (2): TASK-ARP09-003, TASK-ARP09-004 (parallel — both consume 001; disjoint files)
- Wave 3 (1): TASK-ARP09-005 (conditional — expected NOT-NEEDED)

No same-wave file sharing: 001 owns `src/core/diagnostics.ts`(+new `diagnostics.test.ts`); 002 owns `package.json` (scripts section only) + `releaseHygiene.test.ts`; 003 owns `extension.ts` + `extension.test.ts` + `package.json` (commands + activationEvents) in wave 2; 004 owns `src/ai/__tests__/trace.test.ts` (read-only evidence append); 005 owns nothing if closed not-needed. `package.json` is edited in BOTH wave 1 (002 scripts) and wave 2 (003 commands/activationEvents) — serialized across waves, different sections. `releaseVerify.test.ts` and `scripts/verify-release.sh` are NOT modified by any task. Known gaps (PLAN.md Self-Audit): per-run AI completion summary not wired (seam in `aiChatPanel.ts`, outside 003's roadmap file set — `logDiagnostic` exported for a future cycle); if nothing meaningful happens no channel is ever created (pending lines dropped at deactivate — acceptable; reveal flushes buffered history).
