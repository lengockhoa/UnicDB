# Cycle RLX-01 Plan — Operational Reliability Foundation

Base: `main` @ `97cf058` (release v1.21.0). Planning only: this cycle changes no product source, package, or test files.

## §1 Intent

User planning answers (verbatim):

> scope='Roadmap toàn hệ thống (Recommended)'
>
> plan granularity='Theo phases triển khai (Recommended)'

**Success definition:** VSDB progresses through small reviewed releases toward a safe, reliable PostgreSQL-first database extension and AI workspace. The active release removes three concrete integrity gaps: cancel a PostgreSQL non-cursor query through the existing command, coalesce duplicate schema-cache refreshes, and reject malformed import execution plans before database work. Later portfolio plans are queued only, not authorized or ready.

Scope complexity: HIGH
Detected systems: [query execution/adapters, schema metadata/cache, CSV/JSON import transactions, connections/SSH tunnels, results UI, SQL intelligence, PostgreSQL administration, AI tools/permissions, OMP, multi-dialect adapters]
Decomposition: 9 modules — module 1 (RLX-01) planned now; modules 2..9 queued in INDEX.md and §3.

### Source-evidence inventory

| Area | Finding | Evidence |
|---|---|---|
| Cancel path | `vsdb.cancelQuery` calls `runner.cancel()`, but the runner only cancels `currentBatched`; ordinary adapter work has no cancellation seam. | `src/extension.ts:440-446`; `src/core/queryRunner.ts:352-367`; `src/adapters/types.ts:104-112` |
| PostgreSQL | Non-cursor work holds a `PoolClient`; cursor cancellation already calls `pg_cancel_backend($1)` through a dedicated `Client`. | `src/adapters/postgres.ts:340-395, 1020-1095` |
| Schema cache | Stale reads call `fetchEntry()` independently; cache has no in-flight coalescing registry. | `src/ui/schemaCache.ts:57-76, 287-301` |
| Import boundary | `executeImport()` divides parameter sets by `batches` before validating statement/batch cardinality. | `src/core/importer/importExecute.ts:39-115` |
| Tests | Focused tests already cover runner, PostgreSQL adapter, cache, and importer. | `.cache/index/tests-map.json:30-36, 318-321, 346-350, 714-717` |
| Tooling | Defined npm scripts are test, test:integration, typecheck, compile, package; lint is absent. | `package.json:563-571` |

## §2 Scope

### In scope — active RLX-01

- Add an optional adapter cancellation seam and invoke it only for a QueryRunner-owned active non-batched run.
- Implement the seam in PostgreSQL by reusing the dedicated backend-cancel mechanism; retain cursor cancellation and release semantics.
- Coalesce simultaneous stale SchemaCache reads for one cache key while preserving TTL, stale-on-error, and invalidate semantics.
- Validate DryRunPlan structural cardinality before transaction or SQL effects, preserving the existing driver gate.
- Add deterministic TDD unit/contract tests and perform focused plus release-boundary verification.

### Out of scope

- MySQL/MariaDB or SQL Server cancellation, new commands/UI, telemetry, automatic retry, dashboards, migrations, driver rewrites, and dependencies.
- Import mapping/dry-run generation, row-size policy, connection secrets, SSH argument construction, and behavior for valid plans.
- Every portfolio plan below: all are non-active and **NOT READY** until separately re-grounded.

**Same-wave file exclusion:** Wave 1 contains three tasks. TASK-RLX-001 exclusively owns query-runner/PostgreSQL adapter files and tests; TASK-RLX-002 exclusively owns SchemaCache and its test; TASK-RLX-003 exclusively owns importer execution and its test. No same-wave target path overlaps.

## §3 Approach

### RLX-01 active implementation strategy

1. **Scoped cancellation rather than connection teardown.** Add `cancelActiveQuery?(): Promise<void>` to `DbAdapter`. During `QueryRunner.run()` retain the resolved adapter only for that operation. `cancel()` sets the current flag and invokes the seam only when no `currentBatched` exists. Postgres records the active non-cursor backend PID only while its `runQuery()` client is checked out, calls its existing dedicated `pg_cancel_backend($1)` route, and lets the existing `finally` release the original client. The optional seam preserves other drivers unchanged.
2. **Single-flight cache fetch.** Add a private keyed in-flight registry. Concurrent expired/missing reads share one promise; successful work commits once; rejected work preserves the existing stale fallback for all callers. An invalidate generation guard prevents a pre-invalidation response from repopulating cache. `invalidate()` does not cancel adapter I/O and remains synchronous.
3. **Import plan validation.** After the existing driver gate but before transaction acquisition, validate that non-empty executable work has a positive safe-integer `batches`, `sqlStatements.length === batches`, and non-empty `parameterSets`. A malformed PostgreSQL plan returns `{ rowCount: 0, errors: [], error: { phase: "gate", message } }`, with no `beginTransaction()` or SQL call. Valid plans retain values/order/transaction behavior.
4. **TDD.** Write the focused regression/contract test first, observe its failure against current source, use deferred promises/fake adapters/injected clock instead of a live database, then make the smallest green implementation. PostgreSQL integration is supplemental only when its environment is provisioned.

### Trade-offs / rejected alternatives

- Reject closing the adapter to cancel: that destroys reusable state and may disrupt metadata work; PostgreSQL already has targeted backend cancellation.
- Reject an `AbortSignal` migration for every driver: it forces an unproven cross-driver signature rewrite. The optional seam is compatible and bounded.
- Reject indefinite caching/UI debounce: TTL and stale-on-error are intentional; single-flight only removes duplicate in-flight work.
- Reject repairing malformed plans: guessing batch/value alignment can issue wrong writes; fail closed before BEGIN.

### Portfolio plans — queued, non-active, NOT READY

| Portfolio ID | Objective, source anchors, tentative boundary/dependency | Risks and future acceptance/test/verification strategy |
|---|---|---|
| PORT-RLX-02 Cross-dialect lifecycle | Extend the RLX-01 operation identity/cancel contract to MySQL streaming/non-streaming (`src/adapters/mysql.ts:189-280,561-763`) and SQL Server Requests (`src/adapters/mssql.ts:83-91,623-835`), then integrate runner/panel state. Depends on RLX-01. | Target wrong/finished request or leak client. Fake deferred requests prove one targeted cancel/cleanup/no late UI error; existing adapter unit+integration layouts, focused Vitest, typecheck, release full test/compile. |
| PORT-RLX-03 Recovery controls | Bounded recovery/status for lazy adapters (`src/core/connectionManager.ts:299-355`), tunnel child exits (`src/core/sshTunnelManager.ts:108-257`), and stale cache (`src/ui/schemaCache.ts:248-320`). Depends on RLX-01 and RLX-02 decisions. | Reconnect loops, port races, stale cross-connection data. Fake SSH/injected clock/network tests prove bounded retries and disposal; focused Vitest/typecheck/full release gate. |
| PORT-DBX-06 Reviewed PG rename | Catalog usage analysis, rename-plan builder, and preview/confirmation integration based on `src/core/ddl/pgCatalog.ts`, `src/core/dangerousStatement.ts`, and `src/extension.ts:1231-1368`. Depends on stable metadata/recovery. | Quoting, dependencies, collision, partial failure. Pure plan tests plus rollback integration fixtures; focused Vitest/typecheck/full release gate. |
| PORT-DBX-08 Capability parity | Add tested, explicit adapter capability declarations and command gating around `DbAdapter.catalog/admin` (`src/adapters/types.ts:104-153,226-285`); PostgreSQL proof first, MySQL/MSSQL only where verified. Depends on RLX-02. | Empty data mistaken for support, dialect differences. Every surfaced feature has adapter proof or actionable unavailable outcome; adapter tests/typecheck/full release gate. |
| PORT-AIX-03 Read-only analysis copilot | Bounded attributable schema/error/result analysis through `src/ai/tools/readonlySqlParser.ts`, `sqlTool.ts`, `dbAwareTools.ts`, `src/ui/aiChatPanel.ts`. Depends on RLX-03 failure/cancel propagation. | Parser bypass, rows/secrets leakage, connection loss. Adversarial SQL, permission deny, row/token-cap and sentinel-redaction tests; focused tool/panel Vitest/typecheck/full release gate. |
| PORT-AIX-05 OMP resilience | Explicit OMP start/cancel/crash/fallback state around `src/ai/omp/acpProcess.ts`, `mcpBridge.ts`, `ompChatEngine.ts`, and `src/extension.ts:532-558,997-1070`. Depends on AIX-03 permission semantics. | Orphan processes, protocol drift, duplicate tools/context loss. Fake ACP tests for missing binary, handshake, cancellation/restart; focused Vitest/typecheck/full release gate. |
| PORT-AIX-06/07 Trace and governance | Redacted trace schema/panel plus centralized default-deny policy across `src/ai/agent.ts`, `provider.ts`, `tools/fileOpsTool.ts`, and workspace-trust wiring. Depends on AIX-03/AIX-05. | Credential/row persistence, ordering/retention, policy bypass. Sentinel redaction, corrupt/oversize, ordered concurrency, policy matrix tests; focused Vitest/typecheck/full release gate. |
| PORT-DX-01 Release confidence | Build deterministic activation/command contract and manual smoke coverage from existing extension wiring and scripts, without runtime feature scope. Depends on each relevant shipped contract. | Flaky service tests and mock-only confidence. Unit/contract default, environment-gated integration explicit; `npm test`, `npm run typecheck`, `npm run compile` gate. |

## §4 Test Plan

| Type | Test Name | Expected | Task |
|---|---|---|---|
| happy / contract | cancel PostgreSQL non-cursor query | `QueryRunner.cancel()` calls active adapter seam once and statement ends `cancelled`, never `done`. | TASK-RLX-001 |
| edge — race | cancel before adapter acquisition | cancellation makes no late call against a subsequently completed/new operation. | TASK-RLX-001 |
| edge — ordering | cancel after statement settles and the PID window closes | cancellation is a no-op: no adapter seam call and no false error/cancelled result. | TASK-RLX-001 |
| edge — lifecycle | cancel failure and release | best-effort backend cancel failure does not mask query termination; client releases exactly once. | TASK-RLX-001 |
| regression | cursor cancellation remains exclusive | batched work calls `BatchedQuery.cancel()` and no duplicate adapter seam. | TASK-RLX-001 |
| happy / unit | stale table reads coalesce | two concurrent `getTables("public")` calls cause one adapter call and both return refreshed rows. | TASK-RLX-002 |
| edge — failure | coalesced failure keeps stale | concurrent callers both receive prior cache and no rejection escapes. | TASK-RLX-002 |
| edge — invalidation race | invalidate during deferred refresh | old response does not commit; next read returns post-invalidation data. | TASK-RLX-002 |
| happy / unit | valid import plan | matching batches/statements/values begins once, binds ordered values, commits. | TASK-RLX-003 |
| edge — malformed structure | missing statement for declared batch | gate result has rowCount 0; no transaction or SQL call. | TASK-RLX-003 |
| edge — malformed values | executable batch without parameter sets | gate result occurs before transaction, never an empty/misaligned commit. | TASK-RLX-003 |
| regression | valid mid-batch failure | rollback occurs once and later batches do not execute. | TASK-RLX-003 |
| manual / smoke | cancel and cache behavior in VS Code | Cancel a deliberately slow PostgreSQL ordinary statement, then refresh schema while completion/tree consumers are active; UI remains responsive and the next query/schema refresh works. | Cycle boundary |
| manual / safety | malformed importer plan is not user-executable | Normal CSV/JSON import still shows its dry-run/confirmation and a valid small fixture imports once; no new bypass or automatic repair path appears. | Cycle boundary |

Fixtures are deterministic fake adapters, deferred promises, and injected clocks. Live PostgreSQL integration is supplemental only where configured services are available.

## §5 Verification

Per task, run the exact focused command in its task file plus static checking:

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/postgres.test.ts
npx vitest run src/ui/__tests__/schemaCache.test.ts
npx vitest run src/core/importer/__tests__/importExecute.test.ts
npm run typecheck
```

Wave/cycle boundary:

```bash
npm test
npm run typecheck
npm run compile
```

`package.json` has no lint script, so `npm run typecheck` is the required static check. `npm run test:integration` exists but is not a default gate because its services are external; run it only in a provisioned environment and record the result. There is no `test:release-core` npm script.

## §6 Acceptance

- [ ] Existing `vsdb.cancelQuery` cancels a PostgreSQL ordinary QueryRunner operation without closing the adapter or changing valid results. (TASK-RLX-001)
- [ ] Cursor cancellation stays on `BatchedQuery.cancel()` and PostgreSQL client release is correct after success, cancellation, and error. (TASK-RLX-001)
- [ ] After a non-cursor statement settles and its PID-recording window closes, `cancel()` is a no-op: it does not invoke the adapter cancellation seam or produce a false error/cancelled result. (TASK-RLX-001)
- [ ] Same-key stale SchemaCache reads share one introspection; failed refresh retains stale data; invalidation defeats an old response. (TASK-RLX-002)
- [ ] Invalid import-plan structure has no transaction/SQL effect; valid ordering, commit, and rollback behavior stays unchanged. (TASK-RLX-003)
- [ ] Each task records deterministic RED→GREEN happy plus distinct edge tests and passes focused Vitest plus `npm run typecheck`. (TASK-RLX-001–003)
- [ ] Release boundary passes `npm test`, `npm run typecheck`, and `npm run compile`; all portfolio plans remain non-ready. (TASK-RLX-001–003)

## §7 Global Constraints

- Keep `engines.vscode` at `^1.75.0`; add no dependency or package contribution.
- PostgreSQL is first-class; do not claim new MySQL/MariaDB/SQL Server cancellation in RLX-01.
- Preserve `DbAdapter.runQuery(sql: string): Promise<RunResult>`, `BatchedQuery.cancel(): Promise<void>`, parameterized imports, and destructive-SQL confirmation.
- Never log/serialize/expose passwords, API keys, SQL parameter values, query rows, or SSH identities in lifecycle diagnostics/tests.
- Cancellation must be operation-scoped: do not close a shared adapter, destroy unrelated work, or turn a completed result into a false error.
- Preserve SchemaCache TTL and stale-on-error API; invalidation prevents an old response becoming fresh cache state.
- Import validation fails closed before `beginTransaction()` and never repairs/reorders values.
- Follow TDD RED→GREEN, existing test layout/import style, focused tests plus typecheck, and the same-wave file exclusion.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: narrowed the first release to three independent source-backed domains; added invalidation-race coverage to prevent cache coalescing from reintroducing stale data; specified malformed import validation as pre-transaction.
Known gaps: real PostgreSQL cancellation is not a default mandatory test because integration services are external. RLX-001 contract/unit tests prove order and cleanup; record a provisioned integration run when available.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-code

## Plan Review Log

### Round 1 — 2026-08-31 · unic-code
Status: Approved

COMPLETENESS:
  - none — all sections present (intent, scope, approach, test plan, verification, acceptance, constraints, self-audit); no TODO/placeholder; each active task carries happy plus ≥2 distinct edge tests and a RED→GREEN requirement; the one known gap (live PostgreSQL integration not a default gate) is explicitly disclosed with a mitigation, not silently dropped.
CONSISTENCY:
  - none material. Fact-checked §5 against the repo: `package.json` scripts block (actual lines 563-571) contains test/test:integration/typecheck/compile/package with no `lint` and no `test:release-core` script, so `npm run typecheck` as the required static check and that disclosure are factually correct. Test-plan rows map 1:1 onto the three tasks' focused vitest commands, the same-wave file exclusion, and the acceptance checklist. Nit: evidence anchor cites `package.json:562-570`; actual block is 563-571 (off-by-one, cosmetic).
CLARITY:
  - Minor: §3.1 and §4 cover cancel-before-acquisition but do not spell out the narrow window where cancel arrives after the backend PID is recorded yet the statement has already finished. §7's operation-scoped invariant ("never turn a completed result into a false error") implies the correct behavior — make TASK-RLX-001 state the ordering explicitly (once the PID window is closed, cancel is a no-op: no seam call, no false error).
SCOPE:
  - none — single cycle, three independent file-disjoint tasks; the requested whole-system roadmap is present but correctly quarantined as queued NOT-READY portfolio plans, honoring the roadmap request without authorizing un-grounded work.
YAGNI:
  - none — no new dependencies/commands/UI/telemetry; rejected alternatives (adapter teardown, AbortSignal rewrite, plan auto-repair) are documented with reasons.

NOTES: Approved. The plan satisfies the user's explicit request for a comprehensive detailed VSDB roadmap with rigorous testing/review planning: source-anchored evidence inventory, deterministic TDD plan with race/invalidation/failure edges, verified verification commands, fail-closed import semantics, and explicit out-of-scope boundaries. Findings are minor, non-blocking refinements to carry into the task files, not plan defects.
