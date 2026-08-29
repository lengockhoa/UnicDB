# VSDB Product Roadmap — PostgreSQL-first DB IDE + AI Workspace

> Durable portfolio roadmap, not an active handoff cycle. It does not create tasks or supersede the in-flight AHL cycle.

## Product outcome

VSDB lets a developer connect to and work safely with PostgreSQL directly in VS Code, with a trustworthy AI workspace that understands selected files and database context and can use an OMP-backed agent under explicit control. The experience should feel like a focused database IDE plus an inspectable coding agent—not a broad replacement for VS Code, DataGrip, or a cloud control plane.

## Product principles

1. **PostgreSQL depth before breadth.** Finish a coherent PostgreSQL workflow before parity work for MySQL/MariaDB and SQL Server.
2. **Preview before mutation.** SQL, database changes, file edits, and agent tool calls must show scope and require the appropriate confirmation.
3. **Context is bounded and attributable.** Users can see what files, objects, rows, and tools informed an AI answer.
4. **Reliable local-first operation.** Connection failures, missing OMP, partial schema metadata, cancellation, and restart must degrade safely.
5. **Native VS Code workflow.** Reuse commands, editor, tree, webview, SecretStorage, workspace trust, and platform conventions rather than building a competing shell.
6. **Small independently releasable cycles.** A later cycle may not presume an unshipped API or UI surface from a parallel cycle.

## Non-goals and safety boundaries

- No autonomous production database mutation, hidden file writes, credential export, or background network discovery.
- No promise of full DataGrip/PyCharm or generic IDE parity; the target is the highest-value database and AI workflows inside VS Code.
- No driver-parity claim until PostgreSQL acceptance scenarios pass and the target dialect has its own adapter tests.
- AI context excludes secrets and respects workspace trust, connection permissions, row/size limits, cancellation, and explicit approval boundaries.
- OMP is an optional local integration: missing, incompatible, or failing runtimes fall back without breaking built-in AI chat.

## Baseline and sequencing

| State | Capability | Evidence / boundary |
|---|---|---|
| Shipped | Catalog, DDL, console, formatter | Legacy AF outcome |
| Shipped | Server-side grid sort/filter, keyset paging, inline edit, paste, undo/redo, eight export formats | Existing results grid/panel |
| Shipped | Connection manager, SecretStorage, SSL, destructive-SQL confirmation, SQL completion/semantic tokens | Existing connection/core UI |
| Shipped | AI chat, DB-aware tools, permission cards, mentions/attachments, built-in and OMP engines | `src/ui/aiChatPanel.ts`, `src/ai/*`, `src/ai/omp/*` |
| In flight | Roles/grants and sessions/locks administration | AHL: TASK-AHL-001 pending review; AHL-002..004 ready |

**Gate:** AHL is the sole active handoff. Every DBX/AIX cycle below remains portfolio-queued until AHL is finished/cleared; it must not generate `PLAN.md`, `INDEX.md`, or task files while AHL remains active. DBX-01 specifically consumes its completed admin/read-only safety surface.

## Dependency waves

| Wave | Cycles | Reason for order |
|---|---|---|
| 0 — active gate | AHL | Complete and review PostgreSQL administration first. |
| 1 — PostgreSQL workbench | DBX-01, DBX-02 | Complete safe data-work and SQL navigation foundations after AHL. |
| 2 — change understanding | DBX-03, DBX-04, AIX-01 | Diff/ER build on catalog metadata; AI retrieval can mature independently once baseline is stable. |
| 3 — controlled actions | DBX-05, AIX-02, AIX-03 | Connection UX, file operations, and DB analysis require the wave-1/2 context and safety model. |
| 4 — assisted change | DBX-06, AIX-04, AIX-05 | Refactor and AI change workflows need reliable diff, context, and approval surfaces. |
| 5 — operational trust | DBX-07, AIX-06, AIX-07 | Reliability, OMP observability, and governance harden the completed workflows. |
| 6 — expansion | DBX-08, AIX-08 | Dialect parity and MCP extensibility come after stable contracts and policies. |

## Portfolio cycles

### DB IDE pillar

| ID / name | Goal and user outcome | Scope boundary and prerequisites | Quality theme |
|---|---|---|---|
| DBX-01 **Data Workbench Completion** | Import CSV/JSON with mapping/dry-run/batched insert; use pagination, form view, and large-value/JSON editing to repair data without leaving VS Code. | PostgreSQL only; builds on existing `resultsGridModel`, `resultsPanel`, `queryRunner`; waits for AHL. No cross-connection copy yet. | Mapping validation, transaction/error reporting, row limits, null/large-value fidelity. |
| DBX-02 **SQL Intelligence Navigation** | Resolve completion, hover/quick documentation, go-to-definition, and find usages against live schema so SQL code is navigable. | Extend `schemaCache`, `sqlCompletionProvider`, semantic-token/catalog seams; waits for AHL. No language-server replacement. | Stale/missing metadata, quoted identifiers, cancellation, multiple connections. |
| DBX-03 **Schema & Data Compare** | Compare PostgreSQL schemas/tables and same-shape table data; inspect a generated, directional sync plan before any execution. | Catalog/diff service plus compare webview; depends DBX-01 and DBX-02. No automatic sync or heterogeneous dialect compare. | Deterministic ordering, absent PK, incompatible shapes, plan preview safety. |
| DBX-04 **Relationship Explorer** | Explore FK relationships as a pan/zoom ER diagram and export a static diagram for documentation. | PostgreSQL FK introspection and a dedicated diagram webview; depends DBX-02. No editable physical modeling. | Cyclic graphs, no-FK tables, large graphs, layout/export stability. |
| DBX-05 **Connection Workspace** | Organize connections with folders/colors, read-only intent, and lifecycle-managed SSH tunnels. | `connectionManager`, connection form/config export, SecretStorage; depends DBX-01 and AHL. No shared/team credential sync. | Tunnel cleanup/reconnect, invalid key/auth, read-only mutation blocks, secret redaction. |
| DBX-06 **Safe Rename Refactor** | Rename PostgreSQL tables/columns with catalog usage analysis and a reviewable ALTER/update plan. | DDL/catalog/refactor service and preview UI; depends DBX-02 and DBX-03. No unreviewed bulk rewrite. | Quoted names, dependent views/FKs/routines, name collision, cancellation/partial failure. |
| DBX-07 **Database Reliability Controls** | Make long-running query, import, tunnel, and schema-refresh behavior observable, cancellable, and recoverable. | Query runner, result batching, connection/tunnel lifecycle and status UI; depends DBX-01, DBX-05. No server-side monitoring product. | Timeout/cancel races, reconnect, bounded memory, stale async response suppression. |
| DBX-08 **Dialect Parity Contract** | Close the catalog/DDL/navigation and connection-workspace gaps for the already-shipped MySQL/MariaDB and SQL Server adapters behind tested capabilities, while retaining PostgreSQL-first defaults. | Adapter capability matrix and per-dialect catalog/DDL paths; depends DBX-02, DBX-03, DBX-05, DBX-07. It extends proven DBX workflows rather than adding unrelated DBMS products; no feature is advertised without adapter proof. | Dialect quoting/types, unsupported capability messaging, integration isolation, PostgreSQL regression. |

### AI workspace pillar

| ID / name | Goal and user outcome | Scope boundary and prerequisites | Quality theme |
|---|---|---|---|
| AIX-01 **Grounded Workspace Context** | Ask questions over selected/open workspace files plus attributed schema context, with bounded retrieval rather than opaque prompt stuffing. | Build on `aiChatPanel`, attachments/mentions, `agent.ts`, `schemaContext.ts`; every attached fact is inspectable as a file path + line range or schema connection + object reference. Waits for AHL gate only; no repository-wide unrestricted indexing. | Empty/oversize context, binary/secret exclusion, stale schema, source attribution. |
| AIX-02 **Safe File Operations** | Let AI propose workspace file patches with diff preview, explicit approval, workspace-trust checks, and atomic failure reporting. | New file-operation tool boundary registered through AI tool registry; depends AIX-01. No silent edits, shell execution, or edits outside workspace roots. | Denied approval, outside-root path traversal, conflicting edit, rejected/failed write rollback. |
| AIX-03 **Database Analysis Copilot** | Explain schema, query plans, errors, and sampled query results using DB-aware tools with visible tool calls and permission decisions. | Evolve `dbAwareTools`, `sqlTool`, schema tools, panel messages; depends AIX-01 and DBX-02. No automatic data-changing SQL. | Read-only parser bypass attempts, permission deny, row/token caps, connection loss. |
| AIX-04 **Database Change Workflow** | Turn an AI suggestion into a reviewed migration/change plan that opens the existing DB preview/confirmation path. | Compose AI tools with DBX-03 compare plans and DBX-06 refactor safeguards; all proposed SQL funnels through the existing `dangerousStatement` / `confirmDangerousStatements` consent path. Depends AIX-02, AIX-03, DBX-03, DBX-06. No direct agent execution of destructive SQL. | Dangerous DDL/DML, stale plan/schema drift, user rejection, transaction/partial-apply reporting. |
| AIX-05 **OMP Agent Workbench** | Use OMP as an optional agent engine with clear session state, cancellation, fallback to built-in chat, and VSDB MCP tools. | Harden `ompChatEngine`, ACP process/bridge and host MCP; depends AIX-02 and AIX-03. No required OMP installation or hidden subprocess capability. | Missing/old binary, protocol error, cancellation/restart, tool permission parity. |
| AIX-06 **Agent Trace & Replay** | Inspect an ordered, redactable record of prompts, retrieved context, tool requests/results, approvals, and failures; consider read-only replay only if the detailed cycle validates a concrete debugging/support user story. | Trace contract around agent/tool/OMP boundaries and panel UI; depends AIX-03 and AIX-05. No replay of writes or credentials. | Redaction, corrupted/incomplete trace, ordering/concurrency, retention-size limits. |
| AIX-07 **Trust, Privacy & Governance** | Give users policies and clear state for provider routing, context classes, tool permissions, retention, and audit export. | Config export/settings and one centralized authorization/redaction policy, with tested credential/secret signatures and excluded paths rather than independent per-tool filtering; depends AIX-02, AIX-05, AIX-06. No cloud account or enterprise admin backend. | Workspace-untrusted mode, policy conflict/default deny, secret detection, migration of existing settings. |
| AIX-08 **Extensible MCP Tool Contracts** | Enable curated, policy-governed MCP extensions that declare schemas/capabilities and receive least-privilege context. | Stable host-MCP/tool registry contract and AIX-07 policy layer; depends AIX-05, AIX-07, DBX-08. No arbitrary remote tools with implicit database/file access. | Invalid tool schema, capability escalation, tool timeout/crash, version compatibility. |

## Release rule

Each cycle becomes a normal implementation handoff only after the active AHL cycle is finished/cleared and a new, source-grounded `PLAN_<cycle>.md`, `INDEX_<cycle>.md`, and task batch identify exact paths, interfaces, focused tests, commands, and reviewer gates. This roadmap is intentionally a queue, not authorization to execute all cycles at once.

## Planner Report
PLANNER_MODEL: unic-smart
