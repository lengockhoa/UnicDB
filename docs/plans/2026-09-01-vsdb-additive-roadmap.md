# VSDB Additive Roadmap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-09-01  
**Status:** Additive portfolio for future commissioning  
**Baseline examined:** `main` at `496c8b0`; released baseline `v1.30.0`  
**Immutability:** This is a new, standalone roadmap. It neither changes nor authorizes changes to `docs/AI_HANDOFF/PLAN_RLX02.md`, current `docs/AI_HANDOFF` state/tasks, or historical handoffs.

**BigQuery planning note:** The requested Google BigQuery expansion is being researched as a separate additive roadmap. Its future adapter must integrate through the existing `DbAdapter`/factory, `SchemaTreeProvider`, `QueryRunner`, and `ResultsPanel` seams (`src/adapters/types.ts`, `src/adapters/factory.ts`, `src/ui/schemaTree.ts`, `src/core/queryRunner.ts`) without changing the active RLX-02 plan.

## Executive recommendation

Recent releases completed connection workspace/tunnels/read-only intent (DBX-05), PostgreSQL reliability foundations (RLX-01), AI governance/contracts (AIX-07/08), Console v2, and dialect capability contracts. The best next investment is not feature breadth: it is closing operational boundaries that create expensive support failures—secondary mutation paths, ownership loss during shutdown, retained-result memory, stale metadata after DDL, driver resource behavior, and privacy-safe diagnostics.

Commission these independent cycles in risk-first order:

1. **ARP-01 — Read-only enforcement completeness** — P0
2. **ARP-02 — Shutdown-safe query ownership and provenance** — P0, after RLX-02
3. **ARP-03 — Retained-result memory budget** — P0, after RLX-02
4. **ARP-04 — Tunnel and endpoint identity hardening** — P1, investigation-gated
5. **ARP-05 — Cross-driver timeout/pool resilience contract** — P1
6. **ARP-06 — AI SQL policy unification and usage visibility** — P1
7. **ARP-07 — Successful-DDL cache/context invalidation** — P1
8. **ARP-08 — Console draft recovery** — P2
9. **ARP-09 — Support diagnostics and release-confidence profiles** — P2

Do not combine this into one mega-cycle. Each ID is a separately commissionable cycle and each task table keeps same-wave files disjoint.

## Confirmed gaps versus investigation hypotheses

| Class | Evidence-grounded observation | Additive response |
|---|---|---|
| Confirmed gap | Read-only wrapping replaces `DbAdapter.runQuery`, but `DbAdapter.beginTransaction?()` and returned `DbTransaction.runQuery()` are separate interfaces. `src/core/connectionManager.ts:394-410`; `src/adapters/types.ts:80-94,104-123`. | ARP-01 tests and closes the secondary execution boundary. |
| Confirmed gap | `SchemaCache`/AI schema context invalidate on connection change/manual refresh; `runStatements()` has no success-only schema-impact hook. `src/extension.ts:294-312,492-499,657-687,1433-1470`. | ARP-07. |
| Confirmed risk | Each Load More merges rows into retained host state with no row/byte budget. Virtual DOM does not cap extension-host memory. `src/core/resultBatcher.ts:14-20`; `src/core/queryRunner.ts:312-356`. | ARP-03. |
| Confirmed partial implementation | Console history is Memento-backed and capped, but construction seeds empty `Query 1`; tabs/buffers are not restored. `src/ui/consolePanel.ts:56-60,137-145`. | ARP-08. |
| Confirmed partial implementation | Tunnel readiness proves the local listener belongs to the spawned SSH child; this is not source proof of remote host/database identity. `src/core/sshTunnelManager.ts:40-105,176-205`. | ARP-04 decision gate; no vulnerability claim. |
| Confirmed partial implementation | PostgreSQL, MySQL, and MSSQL have intentionally divergent pool/timeout policies. `src/adapters/postgres.ts:281-306`; `src/adapters/mysql.ts:135-145`; `src/adapters/mssql.ts:515-525`. | ARP-05. |
| Confirmed partial implementation | Two AI read-only grammars exist, provider usage is parsed, but bounded user-visible usage/budget is absent. `src/ai/tools/readonlySqlParser.ts:1-9,176-210`; `src/ai/tools/sqlTool.ts:99-136`; `src/ai/provider.ts:51-54,209-214`. | ARP-06. |
| Investigation gate | Results, Console, AI panels have partial disposal/cancellation; remaining query ownership holes require post-RLX-02 fault-injection proof. `src/ui/resultsPanel.ts:277-284`; `src/ui/consolePanel.ts:178-186`; `src/ui/aiChatPanel.ts:1255-1290`. | ARP-02, after RLX-02. |
| Product-quality gap | Existing scripts are `test`, `test:integration`, `typecheck`, `compile`, `package`; source search found no extension-owned Output Channel. `package.json:607-615`. | ARP-09. |

## Portfolio constraints

- RLX-02 is active planning work and historical artifacts remain immutable. ARP-02/03 must use the released RLX-02 source, not duplicate its MySQL/MSSQL cancellation implementation. `docs/AI_HANDOFF/PLAN_RLX02.md:5-114`.
- Preserve VS Code `^1.75.0`, TypeScript 5.4 compatibility, and dependencies unless a future approved plan proves an exception. `package.json:4-8,616-630`.
- Preserve default-deny AI policy/redaction and explicit capability admission; do not infer capability from driver name. `src/adapters/types.ts:175-212`.
- User-visible behavior requires a GitHub release, not merely merged source. `docs/MEMORY.md:27-42`.
- No `lint` script exists. Every cycle runs focused Vitest, `npm run typecheck`, `npm run compile`; release review also runs `npm test`. `package.json:607-615`.

```bash
# Per implementation task
npx vitest run <verified-focused-test-files>
npm run typecheck
npm run compile

# Release review
npm test
npm run typecheck
npm run compile

# Only cycles with controlled database/SSH fixtures
npm run test:integration
```

`npm run package` is a packaging/release gate, not a default edit-loop command.

---

## ARP-01 — Read-only enforcement completeness

**Priority:** P0  
**Dependencies:** none

### Problem / value

The read-only promise currently wraps `adapter.runQuery` only. A caller can obtain an optional transaction and its `runQuery` is not wrapped by `guardAdapter()` (`src/core/connectionManager.ts:394-410`; `src/adapters/types.ts:80-94`). This is a concrete policy boundary, regardless of whether a current UI exposes it. Existing classification blocks key DML/DDL/permission forms, writable CTEs, EXPLAIN-wrapped mutation, and PostgreSQL backend admin calls (`src/core/readOnlyIntent.ts:25-107`); it is not a full SQL parser.

### Scope / out of scope

**In:** wrap transaction execution without signature changes; formalize classifier behavior by dialect; retain safe read query and rollback behavior.  
**Out:** server-side read-only roles/sessions, a parser dependency, confirmation-based exceptions, changing commit/rollback semantics without an explicit decision.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/core/readOnlyIntent.ts` | `src/core/__tests__/readOnlyIntent.test.ts` |
| `src/core/connectionManager.ts` | `src/core/__tests__/connectionManager.test.ts` |
| `src/adapters/types.ts` only if a helper type is required | `src/adapters/__tests__/adapterQueryShape.test.ts` only if fixture changes |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-01.1 classifier matrix | `readOnlyIntent.ts`; `readOnlyIntent.test.ts` | Safe SELECT happy path; comments/literals; writable CTE/EXPLAIN ANALYZE; transaction-control decision; documented dialect candidates. |
| 1 | ARP-01.2 transaction guard | `connectionManager.ts`; `connectionManager.test.ts` | Fake transaction mutation never calls underlying driver; SELECT calls once; rollback remains usable. |
| 2 | ARP-01.3 interface regression | `types.ts` only if needed; `adapterQueryShape.test.ts` | Compile/runtime fixture proves no optional API bypass. Otherwise close as not-needed. |

### Acceptance / review / release

- [ ] Mutations are blocked before driver invocation through both adapter and transaction execution handles.
- [ ] Safe queries and cleanup still work; tests cover happy + comment/literal + writable-CTE/EXPLAIN + transaction boundary cases.
- [ ] Security review checks every optional execution API for bypass.
- [ ] Run `npx vitest run src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/connectionManager.test.ts`, `npm run typecheck`, `npm run compile`; release review runs `npm test`.
- [ ] Manual: configured read-only connection rejects normal and transaction-scoped mutation before DB effect, but allows SELECT.

---

## ARP-02 — Shutdown-safe query ownership and connection provenance

**Priority:** P0  
**Dependencies:** released/reviewed RLX-02; ARP-01

### Problem / value

Current disposal is intentionally uneven: ResultsPanel rolls back manual transactions on close (`src/ui/resultsPanel.ts:277-284`); Console aborts autocomplete (`src/ui/consolePanel.ts:178-186`); extension deactivation disposes panels/resources (`src/extension.ts:990-1005`). These prove lifecycle seams exist, not that a query leak exists. RLX-02 is specifically planning cancellation and command/panel ordering; its source must be the baseline before investigating close/deactivate/connection-change races. Current command code is non-awaited (`src/extension.ts:464-470`), but RLX-02 already owns that change.

### Scope / out of scope

**In:** one idempotent live-work ownership model during panel close/deactivate; prove late completion cannot render as the new connection; fault-injection tests.  
**Out:** reimplement RLX-02 adapters/seam, server kill SQL, pool closure to cancel, public operation IDs unless audit proves no smaller design works.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/core/queryRunner.ts` | `src/core/__tests__/queryRunner.test.ts` |
| `src/ui/resultsPanel.ts` | `src/ui/__tests__/resultsPanel.test.ts` |
| `src/core/connectionManager.ts` | `src/core/__tests__/connectionManager.test.ts` |
| `src/extension.ts` only if needed | `src/extension.test.ts` |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-02.1 runner ownership | `queryRunner.ts`; `queryRunner.test.ts` | Cancel idempotency; late settle cannot turn cancelled to done; close-origin cancellation cannot target later run. |
| 1 | ARP-02.2 panel-close race | `resultsPanel.ts`; `resultsPanel.test.ts` | Close during deferred run/cancel: one cleanup, no post-dispose message/error/busy change. |
| 1 | ARP-02.3 connection provenance | `connectionManager.ts`; `connectionManager.test.ts` | A runs while switch/edit/delete makes B active: no A resource/result attribution to B. |
| 2 | ARP-02.4 host integration | `extension.ts`; `extension.test.ts` | Only if Wave 1 reveals a host gap; test post-RLX-02 deactivate/command ordering. |

### Acceptance / review / release

- [ ] Close/deactivate requests exactly-once best-effort cleanup without using shared adapter/pool close as cancellation.
- [ ] Late work cannot render, clear busy, or emit error to disposed/different-connection UI.
- [ ] Concurrency review maps all deferred settlement timelines; no unhandled promise path.
- [ ] Focused runner/panel/manager tests + typecheck/compile; `npm test` release review.
- [ ] Manual: slow query on all three drivers; close Results, switch connection, reload VS Code; no stale UI and next query succeeds.

---

## ARP-03 — Retained-result memory budget

**Priority:** P0  
**Dependencies:** released RLX-02

### Problem / value

`loadMore()` repeatedly appends every batch to `result.rows` (`src/core/queryRunner.ts:341-349`), and `appendBatch()` allocates a new larger array (`src/core/resultBatcher.ts:14-20`). This has no retained-row/byte limit. Cursor streaming protects initial retrieval and webview virtualization protects DOM, neither bounds host retention.

### Scope / out of scope

**In:** explicit conservative retained-row and/or estimated-byte cap; deterministic prefix; close cursor/no more fetching; distinct “limited” UX.  
**Out:** server-side pagination redesign, exact JavaScript heap accounting, full-result auto-export, default batch-size change.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/core/resultBatcher.ts` | `src/core/__tests__/resultBatcher.test.ts` |
| `src/core/queryRunner.ts` | `src/core/__tests__/queryRunner.test.ts` |
| `src/ui/resultsPanel.ts` | `src/ui/__tests__/resultsPanel.test.ts` |
| `webview/main.ts` | verify neighboring webview suite at commissioning; create `webview/__tests__/resultLimit.test.ts` only if established convention permits |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-03.1 pure budget | `resultBatcher.ts`; `resultBatcher.test.ts` | Under-budget append; exact boundary; oversized next batch retains deterministic prefix without mutating input. |
| 1 | ARP-03.2 runner enforcement | `queryRunner.ts`; `queryRunner.test.ts` | Limit closes cursor once, no later fetch, concurrent cancel wins, smaller result unchanged. |
| 2 | ARP-03.3 panel state | `resultsPanel.ts`; `resultsPanel.test.ts` | Limited state/message disables Load More without error notification. |
| 3 | ARP-03.4 webview | `webview/main.ts`; verified test | Accessible explanation distinct from empty/EOF/cancel; run bundle check if existing convention requires it. |

### Acceptance / review / release

- [ ] Defined budget prevents unbounded host retention and yields deterministic visible rows.
- [ ] Limit closes cursor once, performs no future fetch, and is neither an error nor false EOF.
- [ ] Performance review checks copy/allocation trade-off; focused tests + typecheck/compile + full suite release review.
- [ ] Manual: load substantially beyond cap on each driver; panel stays responsive and subsequent query succeeds.

---

## ARP-04 — Tunnel and endpoint identity hardening

**Priority:** P1  
**Dependencies:** ARP-01  
**Mandatory gate:** architecture/security decision before source changes

### Problem / value

The tunnel manager safely uses validated argv and local listener PID proof (`src/core/sshTunnelManager.ts:1-5,40-105,176-253`). That mitigates local-port races, but does not by itself prove a policy for SSH host keys or remote database identity. Determine required assurance before adding configuration or making security claims.

### Scope / out of scope

**In:** threat model/ADR; decide known_hosts versus explicit fingerprint policy; if approved, strict validation before spawn; per-key lifecycle tests.  
**Out:** SSH client implementation, secret/private-key persistence, disabling host checking, cross-connection tunnel reuse, claims of remote DB TLS identity without source evidence.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/core/sshTunnel.ts` | `src/core/__tests__/sshTunnel.test.ts` |
| `src/core/sshTunnelManager.ts` | `src/core/__tests__/sshTunnelManager.test.ts` |
| `src/core/connectionManager.ts` | `src/core/__tests__/connectionManager.test.ts` |
| `src/config/types.ts`, `src/ui/connectionForm.ts` only if decision requires input | verify an existing form test before assigning |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 0 | ARP-04.0 threat model | `docs/decisions/` (new only after parent exists) | Document supported platforms, current OpenSSH trust behavior, chosen identity policy, downgrade/no-go criteria. |
| 1 | ARP-04.1 identity input | `sshTunnel.ts`; `sshTunnel.test.ts` | If pinning approved: malformed/missing required identity rejects; generated argv cannot relax host-key checks. |
| 1 | ARP-04.2 lifecycle/race | `sshTunnelManager.ts`; `sshTunnelManager.test.ts` | Same-key reuse; different-key isolation; late exit removes own handle; PID mismatch fails closed; stop idempotent. |
| 2 | ARP-04.3 manager integration | `connectionManager.ts`; `connectionManager.test.ts` | Edit/delete/probe stops only intended key; effective loopback routing retains persisted host/port. |
| 3 | ARP-04.4 form wiring | verified files only | Only if policy requires it; strict webview validation and secret-free persistence. |

### Acceptance / review / release

- [ ] No source implementation before a recorded host-identity decision.
- [ ] Existing local listener provenance remains fail-closed.
- [ ] Security review mandatory; manual OpenSSH validation on macOS/Linux/Windows; focused tunnel tests/typecheck/compile/full suite, integration only with controlled fixture.

---

## ARP-05 — Cross-driver timeout, pool, and resilience contract

**Priority:** P1  
**Dependencies:** ARP-02, ARP-03

### Problem / value

PostgreSQL chose `PG_POOL_MAX` to isolate metadata from pinned cursor/transaction work (`src/adapters/postgres.ts:281-306`). MySQL uses `connectionLimit: 1`, infinite queue, 10s connect (`src/adapters/mysql.ts:135-145`). MSSQL uses 10s connect, unlimited request time for streaming and 5s cancel timeout (`src/adapters/mssql.ts:515-525`). These may be correct, but they are not a common support contract.

### Scope / out of scope

**In:** documented per-driver matrix for connect/query/stream/cancel/pool/broken socket; measured finite failure behavior; normalize host message only if evidence requires it.  
**Out:** automatic mutation retry, reconnect during transaction/cursor, blanket pool resizing, dependency-heavy circuit breakers.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/adapters/postgres.ts` | `src/adapters/__tests__/postgres.test.ts`; `postgres.integration.test.ts` |
| `src/adapters/mysql.ts` | `src/adapters/__tests__/mysql.integration.test.ts`; `adapterQueryShape.test.ts` |
| `src/adapters/mssql.ts` | `src/adapters/__tests__/mssql.integration.test.ts`; `mssql.parameterized.test.ts` |
| `src/core/connectionManager.ts` only if measured error UX needs it | `src/core/__tests__/connectionManager.test.ts` |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 0 | ARP-05.0 measured contract | `docs/decisions/` (new) | Reproduce slow connect, occupied pool, cancelled stream, broken socket per driver; record SLO/no-retry decision. |
| 1 | ARP-05.1 PostgreSQL | `postgres.ts`; `postgres.test.ts` | Metadata/pinned work, failed connect/close release, cancel recovery. |
| 1 | ARP-05.2 MySQL | `mysql.ts`; `adapterQueryShape.test.ts` | Held connection/queue and terminal error path preserve streaming but bound source-proven wait failure. |
| 1 | ARP-05.3 MSSQL | `mssql.ts`; `mssql.parameterized.test.ts` | Paused stream not timed out; cancellation and late request cannot wedge queue. |
| 2 | ARP-05.4 host message | `connectionManager.ts`; `connectionManager.test.ts` | Only if needed: actionable non-secret error without erasing diagnostic detail. |

### Acceptance / review / release

- [ ] Matrix explains intentional adapter differences; no mutation/transaction/cursor automatic replay.
- [ ] Happy, resource/timeout, and late error/cancel tests per driver.
- [ ] Adapter-library review, focused tests/typecheck/compile/full suite, and controlled `npm run test:integration` where fixtures exist.

---

## ARP-06 — AI SQL policy unification and usage visibility

**Priority:** P1  
**Dependencies:** ARP-01; preserve AIX-07/AIX-08 unchanged

### Problem / value

`run_sql` accepts SELECT/SHOW/EXPLAIN/WITH with bespoke checks (`src/ai/tools/sqlTool.ts:99-136`); `parseReadonly` accepts only SELECT/WITH and deliberately over-rejects (`src/ai/tools/readonlySqlParser.ts:1-9,176-210`). Provider replies already normalize token usage and agent has a max-step budget (`src/ai/provider.ts:51-54,209-214`; `src/ai/agent.ts:264-266`), but no clear per-turn/bounded-session user view exists.

### Scope / out of scope

**In:** one fail-closed policy decision API with documented tool profiles if necessary; side-effect tests; privacy-safe usage/budget display.  
**Out:** AI DML/DDL, raw prompt/SQL display, cost estimates without pricing, weakening policy/redaction/MCP contracts.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/ai/tools/readonlySqlParser.ts` | `src/ai/tools/__tests__/readonlySqlParser.test.ts` |
| `src/ai/tools/sqlTool.ts` | `src/ai/tools/__tests__/sqlTool.test.ts` |
| `src/ai/provider.ts` | verify provider test path at commissioning |
| `src/ai/agent.ts` | verify agent test path at commissioning |
| `src/ui/aiChatPanel.ts` | `src/ui/__tests__/aiChatPanelPolicy.test.ts`; `aiChatPanel.test.ts` |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-06.1 policy matrix | `readonlySqlParser.ts`; test | SELECT happy; writable CTE; EXPLAIN ANALYZE mutation; SELECT INTO; multi-statement; malformed parens; comment/literal policy. |
| 1 | ARP-06.2 tool adoption | `sqlTool.ts`; test | Only approved SQL executes; cursor closes success/error; stable non-secret denial; row cap retained. |
| 1 | ARP-06.3 usage transport | `provider.ts`; verified test | Missing/malformed usage safe; streaming final usage once; no response body retained for accounting. |
| 2 | ARP-06.4 accounting | `agent.ts`; verified test | Exact cap, unknown usage, aborted turn; hard stop only if approved policy requires it. |
| 2 | ARP-06.5 panel | `aiChatPanel.ts`; tests | Policy/usage displayed with no prompt, SQL, secret, trace, or tool arguments. |

### Acceptance / review / release

- [ ] All AI SQL routes use documented fail-closed policy decision(s); parser uncertainty never admits mutation-capable SQL.
- [ ] Usage is reported/unknown, never invented cost; UI is privacy safe.
- [ ] Mandatory security parser corpus + redaction review; focused tests/typecheck/compile/full suite.
- [ ] Manual: builtin/OMP where available, prohibited SQL, normal read-only turn with missing and present usage.

---

## ARP-07 — Successful-DDL cache/context invalidation

**Priority:** P1  
**Dependencies:** ARP-01

### Problem / value

SchemaCache invalidation handles generation and stale in-flight results (`src/ui/schemaCache.ts:277-324`); AI schema cache has explicit invalidation (`src/ai/schemaContextCache.ts:116-127,217-219`). Wiring is on connection change and manual refresh, but not after shared successful DDL (`src/extension.ts:294-312,492-499,657-687,1433-1470`).

### Scope / out of scope

**In:** pure schema-impact classifier fed statements that actually completed; invalidate only after success; refresh schema completion/tree/AI context from an explicit host seam.  
**Out:** universal SQL semantics, server event subscriptions, DML invalidation absent evidence, automatic tree expansion.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/core/schemaImpact.ts` (new) | `src/core/__tests__/schemaImpact.test.ts` (new) |
| `src/extension.ts` | `src/extension.test.ts` |
| `src/ui/schemaCache.ts` only if seam needed | `src/ui/__tests__/schemaCache.test.ts` |
| `src/ai/schemaContextCache.ts` only if seam needed | `src/ai/__tests__/schemaContextResolver.test.ts` |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-07.1 classifier | new core file/test | SELECT/DML false; successful CREATE/ALTER/DROP/RENAME true; comments/literals false; batch result semantics. |
| 1 | ARP-07.2 schema cache race | `schemaCache.ts`; test | Invalidate during fetch prevents stale commit; modify only if observability requires it. |
| 1 | ARP-07.3 AI cache regression | `schemaContextCache.ts`; test | Explicit invalidation forces fresh hydrate and preserves identity/race guard. |
| 2 | ARP-07.4 execution wiring | `extension.ts`; `extension.test.ts` | Successful schema impact invalidates; failed/cancelled/rejected confirmation does not. |

### Acceptance / review / release

- [ ] Next metadata/completion/AI lookup cannot use stale locally changed schema after success.
- [ ] Failed/cancelled/rejected DDL does not invalidate.
- [ ] Reviewer reconciles semantics with dangerous/read-only classification; focused tests/typecheck/compile/full suite.
- [ ] Manual: create/rename/drop using each execution surface, then completion/tree/AI context reflects fresh names.

---

## ARP-08 — Console draft recovery

**Priority:** P2  
**Dependencies:** ARP-03

### Problem / value

History is persistent but a new panel intentionally starts empty and singleton close creates fresh state (`src/ui/consolePanel.ts:137-145`; `src/extension.ts:1274-1278,1325-1330`). Local bounded draft recovery protects multi-tab scratch work without turning it into sync or automatic execution.

### Scope / out of scope

**In:** versioned, bounded, workspace-scoped tab/buffer/active-tab state; validation, debounce/flush, explicit clear/restore UX.  
**Out:** results, passwords, transaction state, cross-machine sync, unlimited persistence, file writes, automatic replay.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/ui/consolePanelMessages.ts` | `src/ui/__tests__/consolePanelMessages.test.ts` |
| `src/ui/consolePanel.ts` | `src/ui/__tests__/consolePanel.test.ts` |
| `webview/consolePanelMain.ts` | `src/ui/__tests__/consolePanelBundle.test.ts` plus verified neighboring webview test |
| `src/extension.ts` only if scope/options change | `src/extension.test.ts` |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-08.1 persisted model | messages file/test | Valid bounded snapshot; malformed/oversize rejection. |
| 1 | ARP-08.2 host restore | console file/test | One/two-tab restore; corrupt fallback; deterministic cap; flush once on dispose; no secret/result persistence. |
| 2 | ARP-08.3 webview UX | webview/bundle tests | Restore pre-input; clear cannot resurrect old draft. |
| 3 | ARP-08.4 extension | extension/test only if needed | Memento scope and singleton behavior retain current guarantees. |

### Acceptance / review / release

- [ ] Close/reopen/reload restores bounded drafts but never runs SQL.
- [ ] Corrupt state safely becomes one empty tab; clear is durable.
- [ ] Privacy review; focused console tests/typecheck/compile/full suite; bundle compilation verified.
- [ ] Manual: write multi-tab drafts, close/reload/reopen/clear; verify no execution and capped history.

---

## ARP-09 — Redacted support diagnostics and release-confidence profiles

**Priority:** P2  
**Dependencies:** ARP-02, ARP-05, ARP-06

### Problem / value

AI trace/audit redaction already exists (`src/ai/trace.ts:118+`; `src/ai/auditExport.ts:1-5`), but no extension-wide Output Channel was found. Scripts expose full and integration suites but no named fast/release confidence profile (`package.json:607-615`). A local redacted channel and thin real-script profiles improve support without telemetry or blanket full-suite local loops.

### Scope / out of scope

**In:** lazy local output channel with redacted lifecycle/connection/AI summaries, opt-in verbosity, clear/reveal; named profiles made only from real existing scripts/tests.  
**Out:** telemetry/upload, raw SQL/prompts/passwords/tokens, changing assertions to pass, mandatory integration per edit.

### Exact candidate files / tests

| Files | Tests |
|---|---|
| `src/core/diagnostics.ts` (new) | `src/core/__tests__/diagnostics.test.ts` (new) |
| `src/extension.ts` | `src/extension.test.ts` |
| `src/ai/trace.ts` or `src/ai/auditExport.ts` only if redaction seam required | `src/ai/__tests__/trace.test.ts` |
| `package.json` | `src/__tests__/releaseHygiene.test.ts` |
| `scripts/verify-release.sh` (new) only if scripts cannot express sequence | verify script test convention before assigning |

### Task breakdown (test first)

| Wave | Task | Owned files | RED-first proof |
|---|---|---|---|
| 1 | ARP-09.1 pure formatter | new diagnostics file/test | Password/token/auth/host-user/raw SQL are excluded/scrubbed while category/severity/correlation remain useful. |
| 1 | ARP-09.2 profile design | `package.json`; `releaseHygiene.test.ts` | New names reference real commands and preserve `test`, `typecheck`, `compile`, `test:integration`. |
| 2 | ARP-09.3 channel wiring | `extension.ts`; `extension.test.ts` | Lazy create, exactly-once dispose, reveal/clear, expected categories, no raw secret/SQL. |
| 2 | ARP-09.4 reuse redaction | trace/audit file only if needed | Diagnostics cannot bypass existing trace/export redaction. |
| 3 | ARP-09.5 runner | new script only if approved | Portable deterministic ordered checks and non-zero propagation. |

### Acceptance / review / release

- [ ] Local channel is redacted by construction and disposable; never records credential/auth/raw SQL/raw prompts/tool args.
- [ ] Fast and release profiles are documented; release includes `npm test`, `npm run typecheck`, `npm run compile`; integration/package remain explicit.
- [ ] Mandatory privacy/security review and cross-platform release-profile review.
- [ ] Run diagnostics/release-hygiene tests, typecheck, compile, full suite, then new profile commands only after they exist.
- [ ] Manual: connection failure and AI denial reveal/clear channel with no secret/raw SQL; release profile passes from clean shell.

## Dependency graph

```text
ARP-01 ─┬─> ARP-02 (also requires RLX-02) ─> ARP-05 ─> ARP-09
        ├─> ARP-04
        ├─> ARP-06 ────────────────────────────> ARP-09
        └─> ARP-07
RLX-02 ───> ARP-03 ───> ARP-08
```

The first non-duplicative planning candidates after RLX-02 are ARP-01, ARP-03, and ARP-04’s decision gate. Do not schedule tasks touching the same file in one executor wave.

## Deferred speculative ideas

| Idea | Why deferred |
|---|---|
| New DB drivers | Existing three-driver reliability must be bounded first. |
| Full SQL parser dependency | Current guards are tested/conservative; introduce only if ARP-01/06 corpus proves a harmful gap unsolved by a shared tokenizer. |
| Public per-operation cancellation IDs | RLX-02 correctly records no current tokenized adapter seam; needs approved cross-dialect migration. |
| Automatic query retry/reconnect | Unsafe for mutation, transaction, cursor and admin operations. |
| Remote telemetry/upload | Conflicts with local-first privacy; ARP-09 is local/redacted. |
| DB schema change subscriptions | No cross-dialect infrastructure exists; ARP-07 uses successful local DDL signal. |
| Unlimited console sync | Privacy/scope expansion; ARP-08 is bounded local recovery. |
| AI currency/cost estimates | Token counts do not establish model price; ARP-06 reports usage only. |

## How future executor should commission one cycle

1. This file is additive guidance, not an executable `docs/AI_HANDOFF` task. RLX-02 and historical handoffs remain immutable.
2. Select the highest-priority cycle with released dependencies. For ARP-02, inspect final RLX-02 source/review before writing a plan.
3. Refresh/query the source index; revalidate every cited path, line, test layout, and package script. Candidate files can move.
4. Complete Wave 0 decision/measurement gates first. If evidence invalidates a premise, close/re-scope rather than force implementation.
5. Only then create a new handoff cycle with fresh PLAN/INDEX/ACTIVE/task artifacts under the normal workflow; never overwrite this roadmap, RLX-02, or executor/reviewer reports.
6. Split by disjoint file ownership, add RED tests first, run actual commands, obtain specified security/concurrency/release gates, and publish a release for user-visible changes.

## Compact source-evidence table

| Theme | Current anchors | Confidence |
|---|---|---|
| Read-only | `connectionManager.ts:394-410`; `types.ts:80-94,104-123`; `readOnlyIntent.ts:25-107` | High |
| Lifecycle | `queryRunner.ts:61-401`; `resultsPanel.ts:277-284,722-726`; `PLAN_RLX02.md:5-114` | High dependency; medium remaining-gap claim |
| Memory | `resultBatcher.ts:14-20,49-60`; `queryRunner.ts:312-356` | High |
| Tunnel | `sshTunnelManager.ts:40-105,176-253`; `connectionManager.ts:359-391` | High |
| Resilience | `postgres.ts:281-306`; `mysql.ts:135-163`; `mssql.ts:515-525` | High |
| AI | `readonlySqlParser.ts:1-9,176-210`; `sqlTool.ts:99-260`; `provider.ts:51-54,209-214`; `agent.ts:264-266` | High |
| DDL invalidation | `schemaCache.ts:277-324`; `schemaContextCache.ts:116-127,217-219`; `extension.ts:1433-1470` | High |
| Console | `consolePanel.ts:137-145,148-204`; `extension.ts:1274-1278,1325-1330` | High |
| Diagnostics/profiles | `auditExport.ts:1-5`; `trace.ts:118+`; `package.json:607-615` | Medium-high |

## Planning self-review

- [x] New standalone additive roadmap only; historical/current handoff artifacts are not amended.
- [x] Nine independently commissionable cycles, risk-first and dependency ordered.
- [x] RLX-02 is neither replicated nor altered; it is an explicit prerequisite where relevant.
- [x] Every requested theme is covered; uncertain observations are investigation gates rather than asserted defects.
- [x] Each cycle names priority, value, source anchors, dependencies, scope/out-of-scope, candidate files/tests, 2–4 granular test-first tasks, same-wave file separation, acceptance, verification, review/security, and manual/release needs.
- [x] Commands use real current package scripts; no lint command is invented.
- [x] Deferred speculative ideas have explicit reasons.

**Known limitation:** future executors must revalidate line anchors, tests, and commands when commissioning because RLX-02 and subsequent releases can move them. This roadmap is evidence-grounded planning, not a frozen implementation contract.
