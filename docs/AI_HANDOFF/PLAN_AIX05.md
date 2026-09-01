# PLAN_AIX05 — PORT-AIX-05 Optional OMP engine resilience

Cycle: AIX-05
Base: main @ 8639471 (v1.34.0)
User directive: continuous autonomous execution; PORT-AIX-05 is the next dependency-satisfied row.

## §1 Intent

Make the optional `omp acp` engine observable and safe across startup, cancellation, crash, fallback, and extension teardown. Success is a panel that explicitly reports the engine lifecycle, falls back to builtin after an unavailable/mismatched/crashed OMP runtime, preserves completed panel conversation history for that builtin continuation, and leaves neither an ACP child nor its loopback MCP bridge alive after cancellation, replacement, fallback, or dispose.

The public lifecycle literal union is:

```ts
export type OmpEngineState =
  | "stopped"
  | "starting"
  | "ready"
  | "cancelling"
  | "crashed"
  | "fallback-builtin";
```

Pinned failure text for an ACP initialize result whose `protocolVersion` is not numeric `1` is `OMP ACP protocol version mismatch: expected 1, received <received>`, where `<received>` is `String(result.protocolVersion)`.

## §2 Scope

### In scope

- `AcpProcess` owns the authoritative child lifecycle: `stopped → starting → ready`; an unexpected child exit during `starting` emits `crashed` then `fallback-builtin`, while an unexpected exit during `ready` emits `crashed` for the panel-owned bounded restart/fallback decision. Cancellation is terminal: cancel from `ready` emits `cancelling`, observes the cancel-initiated child exit, then emits `stopped`; cancel during `starting` aborts the handshake and emits `stopped`. Neither cancellation path emits `crashed` or `fallback-builtin`.
- A missing or unusable binary remains a builtin route through the existing `detectOmp()`/`resolveEngine()` gate; a spawn failure, initialize timeout/error, or protocol mismatch after selection moves the live panel to `fallback-builtin` and persists `vsdb.ai.engine = "builtin"` for later panels. Post-ready crashes use exactly `MAX_ENGINE_RESTARTS = 2` restart attempts, with `DEFAULT_ENGINE_RESTART_DELAY_MS = 1000` and injected `sleep(delayMs)` between attempts; a third crash (at the limit) emits `fallback-builtin` once and permanently selects builtin for that panel.
- `dispose()` terminates the spawned child, waits at most `OMP_ACP_DISPOSE_TIMEOUT_MS = 2000`, escalates once when it has not exited, and always releases client/listener bookkeeping. Cancellation is idempotent and cannot leave a child, listener, or pending handshake alive.
- `McpBridge` owns exactly one bearer-authenticated ACP descriptor per OMP runtime and composes it with the `HostMcp` registry; `OmpChatEngine` receives that descriptor array verbatim and only notifies/uses the adapter. The bridge is terminal after disposal and cannot invoke a tool. `HostMcp` owns the authoritative standard-plus-curated registry: a colliding curated name is excluded before list/call dispatch, both while live and after runtime disposal.
- Production OMP wiring is completed: the panel drives `OmpChatEngine` rather than leaving its existing `createOmpChatEngine()` path injection-only, receives lifecycle callbacks from the `AcpProcess` created in `src/extension.ts`, surfaces all six state literals to the existing engine-banner/session-state UI, and retains only completed `[user, assistant]` panel messages for builtin fallback.
- AIX-03 recovery semantics remain unchanged: `recovering`/`failed` call the existing stop path and post error; `recovered` is a no-op. AIX-03's cleared-session-id invariant remains true after cancellation, crash, and fallback.

### Out of scope

- Changing `MIN_OMP_VERSION`, installing/updating OMP, adding an npm dependency, changing ACP protocol version `1`, or adding a new external MCP transport.
- Replaying a crashed partial turn, restoring ACP persistence/session history, retrying indefinitely, or automatically switching builtin sessions back to OMP.
- Changing the AIX-07 policy/redaction rules, AIX-08 curated host-MCP collision containment, provider behavior, or database tool permissions.
- Historical `TASK-AIX05-001` through `TASK-AIX05-004` files: they contain executor/reviewer evidence and are immutable. This cycle uses `TASK-AIX05-101` through `TASK-AIX05-103`.

Same-wave rule: TASK-AIX05-101 and TASK-AIX05-102 modify disjoint files. TASK-AIX05-103 depends on both and exclusively owns panel, engine, extension, webview, and their tests.

## §3 Approach

PORT-AIX-05 OMP resilience | Explicit OMP start/cancel/crash/fallback state around src/ai/omp/acpProcess.ts, mcpBridge.ts, ompChatEngine.ts, and src/extension.ts:532-558,997-1070. Depends on AIX-03 permission semantics. | Orphan processes, protocol drift, duplicate tools/context loss. Fake ACP tests for missing binary, handshake, cancellation/restart; focused Vitest/typecheck/full release gate.

The portfolio anchors are stale. Current OMP wiring is `src/extension.ts:51` (AcpProcess import), `:1072-1087` (`buildAcpDeps`), `:1089-1177` (`commandOpenAiChat`), and `src/ui/aiChatPanel.ts:2015-2127`/`:2389-2511`. `grep -n -E 'AcpProcess|OmpChatEngine|commandOpenAiChat|EngineKind|acp' src/extension.ts | head -30` confirms this. Although `createOmpChatEngine(opts)` exists at `src/ai/omp/ompChatEngine.ts:328`, no production caller creates it today; the current production panel therefore uses raw ACP in `runAcpTurn`.

1. TASK-AIX05-101 makes `AcpProcess` the single child owner. It exports `OmpEngineState`, extends `AcpStartHandlers` with `onStateChange?: (state: OmpEngineState) => void`, adds `AcpProcess.cancel(): void` so `buildAcpDeps()` can abort a handshake before `start()` resolves, validates the initialize reply before `initialized`/`session/new`, and returns `AcpProcessHandle` with `state(): OmpEngineState`, `cancel(): void`, and `dispose(): Promise<void>` alongside existing client/session metadata. It must classify child exit in every live state: startup exit → `crashed` then `fallback-builtin`; ready crash → `crashed`; cancel-initiated exit → `stopped` only. It bounds termination and retains mandatory `cwd`, conditional `--cwd`, and Windows-only quoting/shell behavior.
2. TASK-AIX05-102 makes `McpBridge.dispose()` idempotent and terminal. Its real `McpBridge` surface remains `descriptor: Record<string, unknown>`, `handleMcpRequest(req, token): Promise<{ result?: unknown; error?: { code: number; message: string } }>`, and `dispose(): void`; it owns its descriptor and `ToolRegistry` and rejects post-disposal traffic before registry lookup. This is the lower-level stale-descriptor guard.
3. TASK-AIX05-103 replaces the raw ACP production route with an adapter that implements the existing `OmpChatEngineOptions` plus required `mcpServers: ReadonlyArray<Record<string, unknown>>`: `{ acp: AcpSession; hostMcp: HostMcp; cwd: string; trace?: TraceRecorder; enablePromptImage?: boolean; mcpServers: ReadonlyArray<Record<string, unknown>> }`. The adapter maps `AcpClient` to `AcpSession`; `OmpChatEngine` passes `mcpServers` verbatim (including bearer headers) rather than calling `mcpServersDescriptor()` to manufacture `{ headers: [] }`. The bridge owns descriptor/registry lifetime; the engine only receives lifecycle notifications and invokes `shutdown(): Promise<void>` as the remote deregistration boundary. The panel owns history, runtime generation, restart scheduling, and fallback: `MAX_ENGINE_RESTARTS = 2`, `DEFAULT_ENGINE_RESTART_DELAY_MS = 1000`, and injectable `sleep(delayMs)` mirror RLX-03’s two-attempt/injected-delay convention. A generation/disposed guard makes late child/bridge events no-ops; old session IDs are cleared before any new session starts. On clean OMP completion the panel appends the completed exchange; cancellation/crash never append a partial exchange; builtin fallback receives retained completed history. The production bridge is composed with `createHostMcp({ gatePost, tools, extensions? })`, exposed through a `createMcpBridge(hostMcp: HostMcp): Promise<McpBridge>` overload while preserving current bridge exports; `tools` are the standard registry and `extensions` are curated output. `hostMcp.ts`’s `curatedByName` remains the authoritative standard-wins collision filter before both `tools/list` and `tools/call`, including after OMP runtime teardown.

Rejected alternatives:
- Do not retain the raw ACP production path alongside an independently wired engine: two owners would create two bridges/session registries and make cancellation attribution ambiguous.
- Do not restart OMP automatically without a strict bound: only two restart attempts, injected 1000-ms backoff, and one terminal builtin fallback are permitted; no user context is replayed into a restarted ACP session.
- Do not treat unknown protocol versions as compatible: protocol drift is an explicit fallback condition, not an ignored field.
- Do not kill the child immediately on user cancel: notify cancellation first so the active request can settle; forced termination is reserved for dispose/reap timeout or unexpected exit handling.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | AcpProcess complete ACP handshake reports ready | Fake child replies `initialize` with `protocolVersion: 1`, then `session/new`; observed sequence is `"starting"`, `"ready"`; handle has the returned session ID and no kill is called. |
| edge — startup child exit | child exits while starting before handshake | Fake child exits cleanly (`0`) before initialize resolves; `start()` rejects rather than waiting for timeout; state events are exactly `"starting"`, `"crashed"`, `"fallback-builtin"`, and the child is reaped. |
| edge — ready crash | child exits after ready | Fake handshake reaches ready, then child exits nonzero; state events append exactly `"crashed"`; the engine emits one crash event and begins its first bounded restart attempt. |
| edge — cancelling exit | cancel-initiated child exit is not a crash | Ready handle cancel emits `"cancelling"`, sends one cancellation notification/termination, and fake child exit emits exactly `"stopped"`; it emits neither `"crashed"` nor fallback event. |
| edge — unavailable binary | spawn error becomes fallback | Fake child emits `Error("spawn omp ENOENT")`; `start()` rejects, reports `"starting"` then `"fallback-builtin"`, and does not leave a live child handle. |
| edge — protocol boundary | initialize protocol mismatch | Fake initialize result has `protocolVersion: 2`; `start()` rejects with exactly `OMP ACP protocol version mismatch: expected 1, received 2`, reports `"fallback-builtin"`, and reaps the child. |
| edge — teardown timeout | dispose reaps a non-exiting child | Fake ready child ignores the first terminate signal; disposal waits 2000 ms under fake timers, escalates once, resolves stopped, and later exit cannot emit a second state/kill. |
| happy — bounded restart | crashes below the limit restart successfully | Two ready-child crashes schedule exactly two replacement starts, each after injected `sleep(1000)`; replacement reaches `"ready"` and no fallback event occurs. |
| edge — restart limit | third crash falls back permanently | After `MAX_ENGINE_RESTARTS = 2` replacement attempts have been consumed, a further ready-child crash schedules no third start or sleep, emits exactly one `"fallback-builtin"`, and all later sends use builtin. |
| happy | disposed bridge cannot double-register tools | Before dispose, `tools/list` returns each supplied registry tool once; after the first `dispose()`, a second `dispose()` is harmless and `tools/list` returns JSON-RPC error `-32000` with message `MCP bridge is disposed` without calling `registry.list()`. |
| regression — AIX-08 | curated-standard collision stays standard-wins while live and after OMP exit | In `src/ai/omp/__tests__/hostMcp.test.ts`, start `createHostMcp({ tools:[standard "catalog-probe"], extensions:[curated "catalog-probe"] })`; before OMP exit and after bridge/runtime disposal, assert `tools/list` has one `catalog-probe` with the standard description, `tools/call` returns `"standard-wins"`, and curated handler calls remain `0`—no bridge deregistration can resurrect/shadow it. |
| edge — stale bridge | post-disposal tool call | `tools/call` after disposal returns `-32000` / `MCP bridge is disposed`; the injected tool execute spy remains at zero calls. |
| edge — resource cleanup | bridge disposal closes active socket | A hanging HTTP tool request is force-closed by `dispose()` and the loopback port no longer accepts a connection. |
| happy | production panel OMP turn uses one runtime and preserves completed context | Real panel harness selects OMP; it creates one process/bridge descriptor, posts `"starting"` then `"ready"`, and after a clean response its next builtin fallback request contains the completed prior `[user, assistant]` exchange exactly once; shutdown posts `"stopped"`. |
| edge — cancellation | Stop during an OMP prompt is idempotent and terminal | Two Stop messages cause one `session/cancel` notification for the live session and visible `"cancelling"`; cancel-initiated child exit produces `"stopped"` (never `"crashed"`), no partial history append, bridge/process are disposed at runtime retirement, and no stale ID can be cancelled afterward. |
| edge — crash/fallback | ready child exits during prompt | The panel reports `"crashed"`; two crashes may restart after injected 1000-ms delays, but the crash at `MAX_ENGINE_RESTARTS = 2` reports exactly one `"fallback-builtin"`, posts one error/fallback UI state, disposes the exact bridge once, clears the old session ID, and a subsequent turn uses builtin rather than touching the old ACP client. |
| regression — AIX-03 | recovery event while OMP is active | `recovering` invokes the same stop/cancel path and emits the established error session state; `recovered` adds no cancellation or UI mutation. |

## §5 Verification

Targeted test commands use the indexed adjacent suites and the project-defined Vitest runner:

```bash
npx vitest run src/ai/omp/__tests__/acpProcess.test.ts
npx vitest run src/ai/omp/__tests__/mcpBridge.test.ts
npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts src/ai/omp/__tests__/mcpBridge.test.ts src/ai/omp/__tests__/hostMcp.test.ts src/ui/__tests__/aiChatPanelEngine.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/extension.test.ts
npm run typecheck
npm run compile
```

`package.json` defines `test`, `test:integration`, `typecheck`, and `compile`; it defines no lint script, so no lint command exists to run. `npm run compile` is the available release-build gate. Do not default to the full `npm test` suite.

## §6 Acceptance

- [ ] TASK-AIX05-101: only `src/ai/omp/acpProcess.ts` spawns `omp acp`; it implements the six exact `OmpEngineState` literals, rejects ACP protocol versions other than numeric `1` with the pinned error, and bounds/reaps teardown. Child exits during starting/ready/cancelling have the pinned state/event outcomes.
- [ ] TASK-AIX05-102: a disposed bridge cannot list or execute any tool, disposal is idempotent, and its loopback listener/connections close.
- [ ] TASK-AIX05-103: actual production construction goes through `createOmpChatEngine`; exactly one bridge-owned bearer descriptor feeds that runtime verbatim; no raw-ACP parallel engine remains for that route.
- [ ] TASK-AIX05-103: all OMP lifecycle states are visible to the panel/webview; missing binary and startup/protocol failure end at `"fallback-builtin"`; post-ready crashes restart at most `MAX_ENGINE_RESTARTS = 2` after injected 1000-ms delays, then emit one `"fallback-builtin"`; later turns use builtin.
- [ ] TASK-AIX05-103: cancellation is idempotent and terminal: ready → cancelling → exit-observed → stopped; starting cancellation aborts handshake → stopped; neither emits crash/fallback. Old process/session/bridge events cannot update a newer generation; dispose/replacement leaves no child or loopback listener alive.
- [ ] TASK-AIX05-103: the authoritative `src/ai/omp/__tests__/hostMcp.test.ts` collision regression proves a curated `catalog-probe` cannot replace/resurrect over the standard one while the OMP runtime is live or after its bridge/runtime exit.
- [ ] TASK-AIX05-103: completed conversation history survives fallback; cancelled/crashed partial turns and stale ACP IDs do not enter/replay it.
- [ ] Targeted Vitest commands, `npm run typecheck`, and `npm run compile` exit successfully.

## §7 Global Constraints

- Node/VS Code floor: retain `package.json` Node-compatible APIs and `engines.vscode: ^1.75.0`; no npm dependency additions.
- Spawn: `src/ai/omp/acpProcess.ts` remains the only `src/ai/omp/` spawn site; mandatory spawn `cwd`, conditional `--cwd`, and existing Windows cmd.exe quoting/shell containment stay intact.
- Protocol: ACP initialize request stays `protocolVersion: 1`; any non-`1` initialize result is fallback, never best-effort compatibility.
- Lifecycle: use only the six pinned `OmpEngineState` literals; cancellation is ready → cancelling → exit-observed → stopped or starting → stopped, never crash; `MAX_ENGINE_RESTARTS = 2`, `DEFAULT_ENGINE_RESTART_DELAY_MS = 1000`, and injected `sleep(delayMs)` are the only restart policy—no unbounded retries.
- Security: MCP remains loopback-only and bearer-authenticated; never expose API keys, DB credentials, or bridge tokens to ACP frames, webview, errors, or logs.
- Tool parity: bridge owns one descriptor per live OMP generation and hands it verbatim to the engine; `createHostMcp({ gatePost, tools, extensions? })` owns the authoritative standard-plus-curated registry and standard-wins collision filtering before list/call and after teardown.
- UI/history: webview rendering remains textContent-based; panel history is the source of truth, and cleared/retired ACP session IDs never replay into a new engine.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: replaced stale extension anchors with current grep-confirmed anchors; separated bridge terminality from the dependent engine/panel integration; retained historic AIX05 task evidence by allocating 101–103 IDs.
Known gaps: no live installed-OMP integration test is planned because the optional local binary is not guaranteed in CI; fake ACP child/HTTP fixtures cover the contract deterministically.

## Planner Report
PLANNER_MODEL: unic-smart


## Plan Review Log

### Round 1 — 2026-09-01 · unic-smart
Status: Issues Found

COMPLETENESS:
  1. `PLAN_AIX05.md:29` requires an unexpected child exit from `starting`, `ready`, or `cancelling` to enter `crashed`, but `TASK-AIX05-101.md:20-25` tests only spawn error, protocol mismatch, cancellation, and an exit after disposal. `acpProcess.ts:197-201` currently rejects only a nonzero pre-handshake exit, so a clean exit during `starting` can instead leave `initialize` pending until timeout. Add fake-child tests for clean/nonzero exits during startup and exits while ready/cancelling, each asserting the pinned state sequence and one terminal fallback/reap.
  2. `PLAN_AIX05.md:53,106` invokes RLX-03 bounded-retry discipline but does not pin a numeric OMP restart limit; `TASK-AIX05-103.md:19,31` still describes “restart/fallback” behavior. Pin `OMP_MAX_RESTART_ATTEMPTS = 0` (the stated no-automatic-restart policy) or a positive literal, and add a test proving no attempt beyond that limit.
  3. `PLAN_AIX05.md:108` says AIX-08 curated-vs-standard collision behavior is preserved, but `TASK-AIX05-103.md:12-22,35-40` neither targets `hostMcp.ts` nor includes its collision fixture. This matters because `hostMcp.ts:237-250` owns the standard-wins collision rule while `mcpBridge.ts:75-137` receives only `ToolRegistry`; the plan must explicitly choose the authoritative registry for the new runtime and test standard-wins parity, or explicitly scope curated tools out rather than claiming preservation.

CONSISTENCY:
  4. The lifecycle conflicts: `PLAN_AIX05.md:29` says cancellation returns `ready → cancelling → ready` once the prompt settles and does not kill the child, but `TASK-AIX05-103.md:30` requires cancellation to settle at `"stopped"`. Choose one ownership rule and align the state-machine table, panel test, acceptance criteria, and recovery path; AIX-03’s `handleStop()` (`src/ui/aiChatPanel.ts:2727-2766`) currently cancels the engine without disposing it.

CLARITY:
  5. `TASK-AIX05-103.md:68-76` does not provide the required real integration signature: it defers the lifecycle callback/type to the Executor Report even though the existing `OmpChatEngineOptions` requires `hostMcp: HostMcp` (`src/ai/omp/ompChatEngine.ts:139-147`) and builds a fresh descriptor with `headers: []` (`:180-190`). `McpBridge` only exposes `descriptor`, `handleMcpRequest`, and `dispose` (`src/ai/omp/mcpBridge.ts:39-49`); it has no deregistration API. Pin the adapter/engine options and ownership teardown signature now, including use of the bridge descriptor verbatim with its bearer header and ACP-runtime disposal as the only available remote deregistration boundary.

SCOPE:
  - none
YAGNI:
  - none

NOTES: All three task files otherwise meet the basic test-count, disjoint-target, typecheck, and compile-command gates. Existing PassThrough ACP and loopback bridge fixtures can implement the requested missing-binary, handshake, crash, cancellation, and bounded-disposal tests once the state and adapter contracts are made unambiguous.

### Round 1 Revision — 2026-09-01 · unic-smart
Status: Resubmitted

- Added explicit fake-child state/event assertions for clean startup exit, ready crash, and cancel-initiated exit; cancellation is now consistently `ready → cancelling → exit-observed → stopped` or `starting → stopped`, never crash/fallback.
- Pinned `MAX_ENGINE_RESTARTS = 2`, `DEFAULT_ENGINE_RESTART_DELAY_MS = 1000`, injected `sleep(delayMs)`, and one terminal `fallback-builtin` event at the limit, with under-limit and at-limit regression cases.
- Named `src/ai/omp/__tests__/hostMcp.test.ts` as the authoritative AIX-08 collision regression, composed the runtime bridge through `HostMcp`, and pinned standard descriptor/result plus curated-call-zero assertions while live and after runtime exit.
- Replaced deferred adapter wording with exact existing `AcpClient`, `AcpSession`, `McpBridge`, `OmpChatEngineOptions`, `HostMcp`, and `CreateHostMcpOptions` signatures, plus required verbatim `mcpServers` and the concrete `createMcpBridge(hostMcp: HostMcp): Promise<McpBridge>` composition overload; descriptor/registry ownership and bridge-disposal deregistration boundary are explicit.


### Round 2 — 2026-09-01 · unic-smart
Status: Issues Found

### Round 2 — findings applied without re-review (cap reached)
- Finding 1 (COMPLETENESS): pinned cancellable construction seam — `AcpPanelDeps.create(ompPath, cwd, mcpServers?): AcpProcess` returns the UNSTARTED process; panel calls `process.start(...)`/`process.cancel()` on the SAME instance for same-generation Stop; legacy `start()` redefined as `create().start()` (one code path). TASK-AIX05-103 Interfaces + Test Case 4 updated to exercise cancel through the captured instance.
- Finding 2 (CLARITY): bridge composition pinned to `HostMcp.handle(req)` (existing member, hostMcp.ts:74-76) for `tools/list` + `tools/call` delegation — `call(name, args)` cannot implement `tools/list` and is excluded from delegation; standard-wins registry preserved. TASK-AIX05-103 Interfaces updated.

COMPLETENESS:
  - `docs/AI_HANDOFF/tasks/TASK-AIX05-103.md:35,84` requires Stop to cancel an ACP handshake before `AcpPanelDeps.start()` resolves, but the declared seam exposes only `start(...): Promise<AcpProcessHandle>`. `AcpProcess.cancel()` in TASK-AIX05-101 is unreachable because `buildAcpDeps()` creates the process internally. Pin a cancellable construction seam, e.g. `AcpPanelDeps.create(ompPath: string, cwd: string, mcpServers?: ReadonlyArray<Record<string, unknown>>): AcpProcess`, and state that the panel calls `process.start(...)` and `process.cancel()` for the same generation; update PLAN_AIX05.md §3 and the TASK-AIX05-103 interface/tests to use that exact contract.
CONSISTENCY:
  - none
CLARITY:
  - `docs/AI_HANDOFF/tasks/TASK-AIX05-103.md:81,83` adds `createMcpBridge(hostMcp: HostMcp)` but its quoted `HostMcp` signature omits the existing `handle(req: { method: string; params?: unknown; id?: unknown }): Promise<{ result?: unknown; error?: { code: number; message: string }>` member at `src/ai/omp/hostMcp.ts:74-76`. The listed `call(name, args)` cannot implement `tools/list`, so the bridge composition remains underspecified. Add that exact member and require the authenticated bridge handler to delegate the MCP methods to `hostMcp.handle(...)`, preserving the standard-wins list/call registry.
SCOPE:
  - none
YAGNI:
  - none

NOTES: The five Round 1 findings are now consistently addressed: exit-state coverage, two-attempt/injected-delay restart policy, the AIX-08 live-and-post-exit regression, unified cancellation semantics, and explicit additive descriptor ownership. Package scripts verify that the targeted Vitest, `npm run typecheck`, and `npm run compile` commands are real; no lint script exists.
