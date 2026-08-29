# Portfolio Plan — VSDB Product Vision

> Planning artifact only. This is not `PLAN.md`, creates no tasks, and must not change the active AHL state.

## §1 Intent

Deliver the two-part VSDB product vision in sequenced, reviewable cycles: (1) a PostgreSQL-first database IDE inside VS Code and (2) a safe, grounded AI workspace for file and database work, with optional OMP-agent integration. Success means each released cycle gives a user a complete, safe workflow and preserves the existing live AI chat, DB-aware permission model, OMP engine, results grid, console, and connection manager.

## §2 Scope

**In scope:** the 16 queued DBX/AIX cycles defined in `PRODUCT_ROADMAP.md`, including database data work, administration-adjacent reliability, navigation, diff/refactor, ER, SSH/connection UX, dialect contracts, workspace context, safe file/DB actions, OMP runtime UX, traces, governance, and MCP extensions.

**Out of scope for this portfolio:** implementing any cycle now; replacing VS Code/DataGrip/PyCharm; autonomous destructive changes; credential syncing; mandatory OMP; cloud governance backend; unrestricted repository ingestion or arbitrary remote tool access.

**Active-cycle constraint:** AHL is sole in-flight work (AHL-001 pending independent review; AHL-002..004 ready). Do not create a normal PLAN/INDEX/TASK batch for any queued cycle until AHL is finished/cleared. DBX-01 waits for AHL; the portfolio queue does not alter it.

## §3 Approach

Use two pillars sharing a safety-and-context spine rather than building separate products:

- **DB pillar:** retain adapter/core boundaries and VS Code webviews; deepen PostgreSQL data work and metadata first, then compare/ER/refactor/connection reliability, then define dialect capabilities.
- **AI pillar:** retain `src/ui/aiChatPanel.ts` as host surface; evolve `src/ai/agent.ts`, `src/ai/tools/*`, and `src/ai/omp/{acp,acpProcess,mcpBridge,ompChatEngine,hostMcp}.ts` behind explicit context, authorization, and trace contracts.
- **Change safety:** file and database mutations pass a preview → user approval → execution → attributable outcome path. Reuse the existing `dangerousStatement` / `confirmDangerousStatements` and AI permission gates; do not create a second consent model.
- **Portfolio sequencing:** parallel cycles share a wave only when their future normal task batches can own separate files/contracts. A cycle plan will re-check current source, public interfaces, test mappings, and actual scripts before task splitting. AIX-01 must establish host-surface/file-lock boundaries before later AIX cycles touch shared `aiChatPanel*` or tool-registry seams.

Rejected alternatives: broad parity checklist (unreleasable and hides dependency gaps); AI built as an opaque chat prompt (not attributable or safe); OMP-only agent runtime (breaks users without the CLI); cross-dialect-first implementation (dilutes PostgreSQL depth).

## §4 Portfolio Test/Quality Plan

Every cycle must write focused Vitest coverage first, then run `npm run typecheck` and a targeted `npm test -- <test paths>` selected from the fresh test map. Its normal handoff cycle will additionally run `npm test` at a wave/cycle boundary. Integration tests are added only when a test database/runtime fixture exists; no external research or implementation verification is claimed here.

| Cycle | Happy path | Edge/risk A | Edge/risk B | Candidate test targets |
|---|---|---|---|---|
| DBX-01 | Valid CSV/JSON mapping dry-runs then imports batched rows | Invalid mapping/type conversion shows row-level error without writes | Large JSON/null/blob-like values retain display/edit fidelity | `resultsGridModel*`, `resultsPanel*`, `queryRunner*`, new import tests |
| DBX-02 | Qualified symbol resolves completion/hover/definition | Stale or missing schema yields bounded fallback | Quoted/ambiguous identifiers resolve for selected connection only | `schemaCache.test.ts`, `sqlCompletionProvider.test.ts`, new navigation tests |
| DBX-03 | Same-shape tables yield ordered schema/data diff and previewed direction | Missing primary key disables unsafe row diff | Incompatible columns produce actionable non-executable plan | new compare service/panel tests, catalog tests |
| DBX-04 | FK graph renders and exports deterministic diagram | Cyclic graph does not loop or duplicate edges | Large/no-FK graph remains navigable with empty-state | new diagram/introspection tests, schema cache tests |
| DBX-05 | Read-only grouped connection opens tunnel then cleans up | Invalid SSH credential/key is redacted and leaves no process | Read-only connection blocks edit/import/mutation paths | `connectionManager.test.ts`, `connectionForm.test.ts`, new tunnel tests |
| DBX-06 | Rename preview lists dependent objects then applies approved plan | Existing target name blocks plan | View/FK/routine dependency or cancellation leaves no silent partial state | DDL/catalog tests, new refactor tests |
| DBX-07 | User cancels a long query/import and receives final state | Reconnect after transport loss does not replay a write | Late async response cannot overwrite newer result/session | `queryRunner.test.ts`, `resultBatcher` tests, new lifecycle tests |
| DBX-08 | Adapter capability chooses supported dialect implementation | Unsupported capability explains rather than throws generic error | Dialect quoting/type differences retain PostgreSQL behavior | adapter unit/integration tests, capability tests |
| AIX-01 | Selected files plus schema yield attributed answer | Empty/oversize/binary context is bounded with notice | Secret-like content is excluded/redacted | `aiChatPanel*`, attachments/mentions tests, `schemaContext.test.ts` |
| AIX-02 | Proposed in-root edit displays diff and applies after approval | Denied approval performs no write | Traversal/outside-root or conflict is rejected atomically | new file-tool tests, AI registry/panel tests |
| AIX-03 | Read-only schema/query analysis displays tool call and result | Write-like SQL/parser bypass is denied | Lost connection or row cap yields recoverable explanation | `dbAwareTools.test.ts`, `readonlySqlParser.test.ts`, `sqlTool.test.ts` |
| AIX-04 | AI migration proposal opens DB preview and applies only after approval | Dangerous statement requires existing confirmation path | Schema changes after proposal invalidate/rebuild plan | new change-workflow tests plus DBX compare/refactor tests |
| AIX-05 | Available OMP session streams/cancels and exposes allowed tools | Missing/old OMP falls back to built-in chat | ACP protocol/process failure cleans state and reports cause | `ompChatEngine.test.ts`, `acp*.test.ts`, `mcpBridge.test.ts`, `hostMcp.test.ts` |
| AIX-06 | Trace records ordered context/tools/approvals and replays read-only step | Secret/redacted field never appears in trace/export | Corrupt/concurrent trace is rejected without replaying action | new trace/replay tests, panel/agent tool tests |
| AIX-07 | Policy shows effective provider/context/tool permissions | Untrusted workspace defaults to no sensitive context | Conflicting or migrated setting resolves default-deny with notice | `extensionConfigExport.test.ts`, AI settings/config tests, new policy tests |
| AIX-08 | Curated MCP tool with valid schema receives allowed context | Invalid schema/version is refused before invocation | Timeout/crash/capability escalation leaves host and DB safe | `hostMcp.test.ts`, `mcpBridge.test.ts`, registry tests, new capability tests |

## §5 Per-cycle Verification Baseline

Each future cycle must use commands verified against the current `package.json` at planning time:

```sh
npm run typecheck
# Future normal plan: npm test -- <exact-focused-test-paths>
npm test
```

`npm run typecheck` and `npm test` exist today. `<exact-focused-test-paths>` is deliberately non-runnable until the future normal plan maps concrete target files to existing/new tests; no portfolio cycle owns those paths yet. Do not default individual tasks to the full suite; `npm test` is the wave/cycle regression net. Add `npm run test:integration` only for a cycle whose planned test fixture genuinely requires it.

## §6 Portfolio Acceptance

- [ ] AHL is independently reviewed and finished/cleared before any DBX/AIX cycle becomes active.
- [ ] DBX-01..08 provide the queued PostgreSQL-first IDE outcomes in `PRODUCT_ROADMAP.md`. (DBX cycles)
- [ ] AIX-01..08 provide grounded, approved, attributable file/database/OMP agent workflows. (AIX cycles)
- [ ] Every mutation has preview, approval, clear outcome, and no credential leakage. (DBX-01/03/05/06; AIX-02/03/04/05/06/07/08)
- [ ] Each normal execution cycle has exact source/test paths, real interfaces, focused RED→GREEN tests, `npm run typecheck`, focused `npm test`, and boundary `npm test`. (all future cycle plans)
- [ ] PostgreSQL regressions remain covered before any adapter capability is advertised. (DBX-08)
- [ ] The user can inspect relevant AI context, tool actions, approvals, and redacted traces. (AIX-01/03/05/06/07)

## §7 Execution Queue

| Wave | Queue | Dependency and planning handoff |
|---|---|---|
| 0 | AHL (active, not changed here) | Finish/review AHL-001..004 first. |
| 1 | DBX-01, DBX-02 | Both wait for AHL; later detailed plans decide whether file ownership permits parallel tasks. |
| 2 | DBX-03 ← DBX-01/02; DBX-04 ← DBX-02; AIX-01 ← AHL | Compare and ER consume reliable metadata; grounded context is independently queued after the AHL gate. |
| 3 | DBX-05 ← DBX-01/AHL; AIX-02 ← AIX-01; AIX-03 ← AIX-01/DBX-02 | Controlled connection, file, and database-analysis actions. |
| 4 | DBX-06 ← DBX-02/03; AIX-04 ← AIX-02/03/DBX-03/06; AIX-05 ← AIX-02/03 | Assisted database change and OMP agent workbench. |
| 5 | DBX-07 ← DBX-01/05; AIX-06 ← AIX-03/05; AIX-07 ← AIX-02/05/06 | Reliability, observability, and governance. |
| 6 | DBX-08 ← DBX-02/03/05/07; AIX-08 ← AIX-05/07/DBX-08 | Expand only from proven capability and policy contracts. |

For each row, create a separate normal `PLAN_<cycle>.md` / `INDEX_<cycle>.md` / task batch only after AHL is cleared/finished. That normal cycle must confirm exact source seams, interfaces, test files, and commands from the then-current repository; it must not treat these portfolio candidates as implementation instructions.

## Planner Self-Audit
Checklist: 12/12 pass

Known gaps: exact new module and test file names are intentionally deferred to each future source-grounded cycle plan; this portfolio plan does not claim implementation or external-runtime verification.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved with minor refinements by unic-code (Round 1, 2026-08-29)

## Plan Review Log

### Round 1 — Approved with minor refinements (reviewer model: unic-code)
- Verified the source seams, candidate test files, scripts, AHL status, DBX/AIX dependency graph, and non-active handoff status.
- Applied: the focused-test placeholder is now a comment rather than a runnable command; AIX-04 explicitly reuses the existing dangerous-statement confirmation path; AIX-01 defines inspectable attribution; DBX-08 narrows parity to gaps in existing adapters; AIX-06 makes replay conditional on a concrete user story; AIX-07 requires one centralized tested redaction policy; AIX-01 must establish shared-host file locks before later AI cycles.
- No blocking findings. Optional ongoing maintenance/upgrade work remains intentionally outside this two-pillar feature portfolio and can be scheduled separately when it becomes concrete.
