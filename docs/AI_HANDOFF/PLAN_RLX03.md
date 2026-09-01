# PLAN_RLX03 — Connection, Tunnel, and Schema-Refresh Recovery

Cycle: RLX-03 · Base: main @ c6d6e360825d92dd29fb7ac29b3a7bbd13df55ba · Release baseline: v1.31.0  
Reviewer: `unic-smart` — MUST differ from executor `unic-code`

## §1 Intent

Ship **PORT-RLX-03 — Connection, tunnel, and schema-refresh recovery**. A lazy active connection whose SSH child exits after readiness must become visibly recovering, make at most two fresh reconnect attempts using an injectable delay seam, and either return to a usable adapter or visibly fail without looping. A `SchemaCache` must never serve entries from the previous adapter after an active reconnect or connection switch; it must retain its established stale-on-temporary-provider-error behavior.

Success means an unexpected post-ready tunnel exit deletes only its exact handle, concurrent same-key starts coalesce rather than competing for a local port, and the next fresh connection receives a fresh local tunnel port. `ConnectionManager` owns recovery: it closes the failed active adapter before retry, reports the pinned recovery status, and does not create a recovery when the exit was intentional, passive, stale, or already being recovered. `SchemaCache` detects a resolved `DbAdapter` identity transition before its TTL check and invalidates its whole generation, so pre-transition in-flight data cannot commit and the next caller fetches from the new adapter.

### User directive record

- Standing directive: continuous autonomous execution through the whole portfolio; roadmap-based planning is explicitly authorized.
- RLX-03 was selected automatically as the next dependency-satisfied portfolio row after shipped RLX-01 and RLX-02 decisions. This cycle is limited to the source-proven lazy adapter, SSH child, and schema-cache recovery paths—not a transport redesign or a new connection UI.

## §2 Scope

### In scope

- `SshTunnelManager.start(cfg: TunnelConfig, key: string): Promise<TunnelHandle>` gains same-key in-flight coalescing and emits a post-ready child-exit event after deleting its exact handle. Restart after that event must create a new handle rather than reuse a dead child; intentional `stop()`/`stopAll()` exits must be distinguishable from failures.
- `ConnectionManager.getAdapter(): Promise<DbAdapter>` handles an unexpected exit for the current active tunnel only: closes the cached adapter, uses an injected scheduler to make at most **2** reconnect attempts, and publishes `"recovering"`, `"recovered"`, or `"failed"` recovery status. `createStatusBar(mgr: ConnectionManager)` shows those states with pinned status-bar literals while keeping normal active-connection text unchanged.
- `SchemaCache` observes a changed non-null adapter identity returned by its existing `SchemaAdapterProvider`, calls its existing `invalidate(): void` before cache freshness is considered, and relies on the existing generation guard to prevent a pre-change response from committing. It continues to return stale data when its provider is temporarily null/throws rather than treating a transient unavailable adapter as a connection change.
- Focused Vitest coverage in the mapped neighboring tests, followed by typecheck/compile gates and the full `npm test` release net.

### Out of scope

- `AbortSignal`, a global reconnect daemon, unbounded retries, exponential-jitter policy, persisted retry state, automatic password prompts, adapter-protocol reconnect APIs, new dependencies, connection configuration changes, or a package/release-version change.
- Guessing a port is safe after release, reusing a dead `TunnelHandle`, tunnelling via shell commands, removing the existing listener-PID identity proof, or emitting recovery for `stop()`, `stopAll()`, edit/delete, dispose, a passive connection, or a non-current active id.
- Serving old cache entries from a different resolved adapter, changing the cache TTL/stale-on-error contract, cache partitioning per schema/object, cancelling in-flight adapter I/O, or changing RLX-02 query-cancellation behavior.
- Changes to `docs/AI_HANDOFF/RUN.md`, git history, tags, VSIX/package output, or any portfolio after PORT-RLX-03.

### Same-wave file exclusion

Wave 1 has TASK-RLX03-001 (only SSH-manager source/test files) and TASK-RLX03-003 (only SchemaCache source/test files); no target file overlaps. TASK-RLX03-002 begins in Wave 2 because it consumes TASK-RLX03-001’s tunnel-exit contract and alone owns ConnectionManager and status-bar source/tests. This dependency is real; the cache task is independent because it detects the adapter identity supplied by its existing provider.

### Global constraints

- Preserve v1.31.0 baseline, `engines.vscode: ^1.75.0`, TypeScript 5.4 compatibility, and existing dependencies; add none.
- Retain `ConnectionManager.getAdapter(): Promise<DbAdapter>`, `SshTunnelManager.start(cfg: TunnelConfig, key: string): Promise<TunnelHandle>`, `SchemaAdapterProvider`, and `SchemaCache.invalidate(): void`; additions must be backward-compatible and test-injectable.
- Recovery is bounded and best-effort: exactly two attempts per unexpected active-tunnel exit, no unbounded timer/Promise loop, no overlapping recovery for the same exit, and all close/stop failures remain contained.
- Preserve the existing `spawn()`-only SSH launch, listener-PID ownership proof, fresh-port allocation, idle timeout, read-only wrapper, stale-on-error cache contract, single-flight registry, and generation guard.
- Pin the emitted state literals `"recovering"`, `"recovered"`, and `"failed"`; pin the status-bar render literals in TASK-RLX03-002. Do not add user-visible notifications or unpinned prose.
- Do not modify `docs/AI_HANDOFF/RUN.md`; do not run git add, commit, tag, package, or push. All TASK-RLX03 files inherit these constraints by reference.

## §3 Approach

1. **Make tunnel death an observable lifecycle transition, not an implicit Map deletion.** Today `SshTunnelManager` records a `TunnelHandle` only after readiness and removes it in `child.once("exit", ...)`, but exposes neither an event nor an in-flight start registry. TASK-RLX03-001 adds a typed post-ready exit listener and one `Map<string, Promise<TunnelHandle>>` for starts. The promise is registered before readiness work can settle and is removed in `finally`; all concurrent `start(..., key)` callers receive the same result or rejection. Each returned handle’s exit listener removes only if it is still the map value, emits exactly once, and records whether `stop`/`stopAll` marked that child intentional. A later start therefore allocates/proves a fresh port and cannot claim an obsolete handle.

2. **Recover only the affected lazy active adapter, with a deterministic finite scheduler.** TASK-RLX03-002 subscribes in the `ConnectionManager` constructor to the new tunnel event. The backward-compatible fourth constructor parameter is `recoveryOptions: ConnectionRecoveryOptions = {}`, where `ConnectionRecoveryOptions { readonly delayMs?: number; readonly sleep?: (ms: number) => Promise<void>; }`; its fixed `DEFAULT_RECOVERY_DELAY_MS` is `1_000`. On an unexpected event whose key still equals the active tunneled connection id, it clears/closes `currentAdapter`, reports `{ state: "recovering", attempt: 1, maxAttempts: 2 }`, then calls the existing `getAdapter()` path. A single per-id recovery promise coalesces duplicate exit events. Recovery captures active and lifecycle generations at start, and verifies after/before every awaited close, sleep, and connection call that it is not disposed and still owns the same active id. `setActive`, active `editConnection`/`deleteConnection`, and `dispose` synchronously invalidate those captures before their own awaits. A failed guard silently aborts: no later attempt, status emission, or callback; any post-await stale candidate is closed/discarded without installation. Success emits `"recovered"`; terminal failure emits `"failed"` after exactly two calls to the existing adapter test path. It does not retry passive adapters or intentionally stopped tunnels. The status bar subscribes to this source of truth and renders the exact transitional/success/failure copy while retaining the normal `$(database) <name> [<driver>]` render once recovery is settled.

3. **Invalidate cache on real adapter ownership change, not merely TTL expiry.** `SchemaCache` already calls `resolveAdapter()` before each fetch-or-cache decision and its `invalidate()` increments `generation`, preventing a pre-invalidate response from committing. TASK-RLX03-003 retains the public provider signature and observes its returned `DbAdapter` reference. The first non-null adapter establishes identity; each different later adapter calls `invalidate()` before **any** lookup reads a cache slot or evaluates freshness. This ordering covers the actual cached families: schemas, all-tables, tables-by-schema, columns, views, routines, sequences, constraints, and object DDL; `hasCatalog()` has no cache entry. Thus a reconnect (or active-switch provider change) cannot return fresh-but-old data, while a provider null/throw continues to return stale results because no replacement adapter was resolved. No cross-module event wiring is needed for cache correctness: the manager’s successful reconnect creates a fresh adapter through the existing factory, and the cache independently sees that identity.

### Trade-offs and rejected alternatives

- Rejected retrying in `SshTunnelManager`: that class has no active-connection/password/adapter ownership and cannot safely decide which DB adapter to close or report.
- Rejected a background infinite reconnect loop or retrying from every `getAdapter()`: both can hammer unavailable hosts and conceal terminal failure. Two scheduled attempts after one unexpected active child exit is observable and bounded.
- Rejected reusing the current `TunnelHandle`/port after child exit: source proves its child is dead and the port may be lost; fresh `start()` retains current pre-allocation plus PID ownership proof.
- Rejected cache keys based on guessed connection IDs or changing `SchemaAdapterProvider`: adapter identity is already real, resolved before each cached access, and covers both switch and reconnect without leaking UI state into the cache.
- Rejected treating provider null/throw as a new adapter: that would discard useful stale completion data during a transient missing password or recovery window, contrary to the checked-in stale-on-error contract.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | `SshTunnelManager coalesces concurrent same-key starts and restarts after an unexpected child exit` | Two concurrent `start(cfg, "c1")` calls resolve to the same live handle; after its child exits, `list()` is empty, one exit event reports `intentional: false`, and a new `start` returns a distinct child/handle. |
| edge — intentional lifecycle | `SshTunnelManager stop/stopAll exit is intentional and cannot leave a reusable handle` | `stop("c1")` or `stopAll()` empties the map before termination; emitted exit data has `intentional: true`, and a later same-key start creates a new handle. |
| edge — failure/concurrency | `SshTunnelManager shares a same-key readiness rejection and clears the in-flight registry` | Concurrent starts against a missing SSH binary reject with the existing clear spawn/start error; a later start is a new attempted spawn rather than a permanently rejected promise. |
| happy | `ConnectionManager recovers the active tunneled adapter on the first scheduled attempt` | A fake unexpected exit closes the old active adapter, runs the injected scheduler zero times when attempt 1 succeeds, creates/tests one replacement adapter, and emits `"recovering"` then `"recovered"` with `maxAttempts: 2`. |
| edge — bounded retry | `ConnectionManager fails after exactly two recovery attempts` | First and second replacement `testConnection()` failures close their adapters; injected sleep runs only between attempts; status ends `"failed"` and no third factory/test call occurs. |
| edge — cancellation/disposal | `ConnectionManager dispose during recovery backoff aborts without a callback` | Dispose while injected retry sleep is pending invalidates recovery; resolving sleep starts no second attempt and emits no later recovery status or status-bar callback. |
| edge — cancellation/active switch | `ConnectionManager active switch during recovery connect aborts old recovery` | Switching from c1 while c1’s replacement connection awaits invalidates c1 recovery; settlement closes/discards its candidate and causes no old-id status, retry, or scheduler call. |
| edge — ordering/ownership | `ConnectionManager coalesces duplicate active-exit events and ignores intentional or non-active exits` | Duplicate unexpected event causes one recovery loop; intentional, passive-key, and stale-key exits cause no factory call, scheduler call, or status transition. |
| regression | `Status bar preserves normal active copy and pins recovery copy` | Normal text remains exactly `$(database) Local [postgres]`; recovery renders exactly `$(sync~spin) Local reconnecting (1/2)`, `$(check) Local reconnected`, and terminal `$(error) Local reconnect failed`. |
| happy | `SchemaCache adapter transition refreshes schemas and both table entry families` | After A caches schemas, all-tables, and schema-scoped tables, provider B within TTL makes each lookup call B and return B’s distinct value, never A’s fresh entry. |
| edge — cache-ordering/catalog | `SchemaCache adapter transition refreshes every pre-resolve column and catalog/DDL family` | After A caches columns, views, routines, sequences, constraints, and object DDL, provider B makes each next lookup call B and return B’s distinct value; no family reads A’s fresh local entry before identity invalidation. |
| edge — in-flight ordering | `SchemaCache adapter transition invalidates a pre-transition in-flight response` | A deferred A response begun before provider changes returns to its own waiting caller but does not commit; B’s next call fetches and remains the cache state. |
| edge — unavailable provider | `SchemaCache retains stale data when provider becomes null or throws without a replacement adapter` | After A cached a table list, null and throwing providers return that exact stale list and do not invoke an alternate adapter or erase the identity prematurely. |
| regression | `SchemaCache existing same-adapter single-flight remains one call` | Two concurrent stale reads with the same adapter identity continue to make exactly one `listTables("public")` request and both resolve to its data. |

TDD rule: each executor adds the focused test first and records the observed RED failure against the pre-task code in its Executor Report before implementing the smallest green change.

## §5 Verification

No `lint` script exists in `package.json`; it must not be invented. The defined validation scripts are `test`, `typecheck`, and `compile`.

```bash
# TASK-RLX03-001 — tunnel lifecycle and fresh-start safety
npx vitest run src/core/__tests__/sshTunnelManager.test.ts src/core/__tests__/sshTunnel.test.ts
npm run typecheck
npm run compile

# TASK-RLX03-003 — adapter-identity cache invalidation
npx vitest run src/ui/__tests__/schemaCache.test.ts
npm run typecheck
npm run compile

# TASK-RLX03-002 — bounded manager recovery and user-visible status
npx vitest run src/core/__tests__/connectionManager.test.ts src/ui/__tests__/statusBar.test.ts
npm run typecheck
npm run compile

# Mandatory release net after Wave 2 and at independent review
npm test
npm run typecheck
npm run compile
```

`.cache/index/tests-map.json` maps `src/core/sshTunnelManager.ts` to `src/core/__tests__/sshTunnelManager.test.ts` and `src/core/__tests__/sshTunnel.test.ts`, `src/core/connectionManager.ts` to `src/core/__tests__/connectionManager.test.ts`, and `src/ui/schemaCache.ts` to `src/ui/__tests__/schemaCache.test.ts`. `statusBar.test.ts` is the source-proven neighboring unit layout for `createStatusBar` and is required because status presentation changes there.

## §6 Acceptance

- [ ] TASK-RLX03-001: A post-ready SSH child exit deletes only its matching tunnel handle, reports one typed exit with its intentional flag, coalesces same-key starts including rejection cleanup, and a later start proves a fresh listener/handle rather than reusing a dead port owner.
- [ ] TASK-RLX03-002: An unexpected active tunnel exit closes the active adapter and makes at most two injected-scheduler reconnect attempts with `DEFAULT_RECOVERY_DELAY_MS = 1_000`; duplicate, intentional, passive, stale, edit/delete, and dispose paths do not cause a recovery loop. Captured active/lifecycle generation guards abort recovery after ownership changes, with no later attempt, status write, or callback; a stale post-await candidate is closed/discarded. The event/status literals are exactly `"recovering"`, `"recovered"`, and `"failed"`. 
- [ ] TASK-RLX03-002: Status-bar normal text remains exactly `$(database) <name> [<driver>]`; recovery text is pinned to `$(sync~spin) <name> reconnecting (<attempt>/2)`, `$(check) <name> reconnected`, and `$(error) <name> reconnect failed` by tests.
- [ ] TASK-RLX03-003: A different resolved non-null adapter invalidates SchemaCache before every cached family reads its entry or evaluates fresh TTL: schemas, all/schema tables, columns, views, routines, sequences, constraints, and object DDL. Stale data from that old adapter cannot commit after the transition, while a null/throwing provider keeps the existing stale-on-error result.
- [ ] TASK-RLX03-001, TASK-RLX03-002, and TASK-RLX03-003: focused Vitest commands plus `npm run typecheck` and `npm run compile` pass; after Wave 2, `npm test`, `npm run typecheck`, and `npm run compile` pass with unic-smart review approval.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
PLAN_REVIEW: Approved by unic-smart
Checklist: 12/12 pass
Fixed during audit: split SSH lifecycle and SchemaCache identity invalidation into disjoint Wave 1 tasks; retained only the real tunnel-event dependency for ConnectionManager; pinned two attempts, recovery-state literals, and every changed status-bar literal; added intentional-exit, duplicate-event, in-flight-generation, and temporary-provider boundaries.
Known gaps: the current tunnel fixture is a live local Node child rather than a controllable fake ChildProcess, so the executor must use its existing child kill/exit behavior or minimally extend the checked-in fixture to make unexpected versus intentional exits deterministic. No source-proven server-side tunnel health signal exists; recovery begins only after the child process exit event, not a silent TCP-path failure.

## Plan Review Log

### Round 1 — 2026-09-01 · unic-smart
Status: Issues Found

COMPLETENESS:
  - 1. `docs/AI_HANDOFF/tasks/TASK-RLX03-003.md` §Test Cases #1–#4 — the only adapter-transition assertions exercise `getTables()`, but `getColumns()` (source `src/ui/schemaCache.ts:133-136`), `getViews()` (:158-160), `getRoutines()` (:175-178), `getConstraints()` (:201-204), `getSequences()` (:223-227), and `getObjectDdl()` (:253-259) capture their cached entry before `resolveAdapter()`. If resolving adapter B invalidates there, those local pre-invalidation entries can still pass the fresh-TTL check and return adapter A data. Add transition coverage for every affected lookup family (including catalog and DDL) and require implementations to resolve/observe identity before reading its cache slot.
  - 2. `docs/AI_HANDOFF/tasks/TASK-RLX03-002.md` §Approach/Test Cases — recovery does not define or test cancellation when the active connection changes, is edited/deleted, or the manager is disposed after an unexpected exit has already entered its retry sleep. A later `getAdapter()` would use the new active connection while the loop reports the old `connectionId`, creating the wrong adapter/status transition. Capture an active/lifecycle generation at recovery start, re-check it before and after every await, and add this race as an edge test.
CONSISTENCY:
  - none
CLARITY:
  - 3. `docs/AI_HANDOFF/tasks/TASK-RLX03-002.md` §Interfaces — the new recovery constructor contract is not a real signature: it omits the exact constructor parameter position/type, exported options type, default delay, and delay field(s). Specify the concrete backward-compatible signature and pin the default delay so implementation and tests do not invent incompatible options.
SCOPE:
  - none
YAGNI:
  - none

NOTES: Retaining stale cache data for a null/throwing provider is the current source-defined temporary-unavailability contract (`src/ui/schemaCache.ts:295-302`) and is appropriate here: `src/extension.ts:309-312` already invalidates on active-connection changes, while a later resolved adapter B must invalidate the retained A identity. The plan should preserve that behavior while closing the lookup-ordering hole above.

### Round 1 Revision — 2026-09-01 · planner · unic-smart
Status: Revised for resubmission

- Finding 1: TASK-RLX03-003 now assigns transition coverage across all nine source-proven cached families—schemas, all/schema tables, columns, views, routines, sequences, constraints, and object DDL—and explicitly exempts uncached `hasCatalog()`/coordination-only `inflight`; PLAN §3/§4/§6 reflect the ordering requirement.
- Finding 2: TASK-RLX03-002 now pins captured active/lifecycle-generation checks before and after every recovery await, invalidation points for switch/edit/delete/dispose, silent abort semantics, stale-candidate cleanup, and distinct dispose-during-backoff plus switch-during-connect tests; PLAN §3/§4/§6 reflect them.
- Finding 3: TASK-RLX03-002 now pins `ConnectionRecoveryOptions`, the backward-compatible fourth constructor parameter, default scheduler, and `DEFAULT_RECOVERY_DELAY_MS = 1_000`; PLAN §3/§6 reflect the concrete contract.

Planner self-audit after revision: 12/12 pass. Known gaps unchanged.

### Round 2 — 2026-09-01 · unic-smart
Status: Approved

COMPLETENESS:
  - none
CONSISTENCY:
  - none
CLARITY:
  - none
SCOPE:
  - none
YAGNI:
  - none

NOTES: Round 1 cache-family coverage, recovery cancellation guards, and the injected recovery-options/default-delay contract are all now concrete and testable. All three task gates are complete; Wave 1 target files are disjoint, and the declared npm scripts match package.json.
