# TASK-AIX05-103 — Production OMP engine lifecycle, fallback, and context continuity

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX05.md` §3

## Goal

Activate the existing `OmpChatEngine` for the real OMP route, translate the `AcpProcess` lifecycle into explicit panel/webview state, and fail over once to builtin without duplicate MCP tools, stale ACP IDs, or loss of completed panel history.

## Target Files

- `src/ai/omp/ompChatEngine.ts` — adapt the real ACP process/client lifecycle from TASK-AIX05-101 into the engine, use a runtime generation/disposed guard, expose lifecycle events to its consumer, make crash/cancel/shutdown terminal for retired sessions, and add a required bridge-owned `mcpServers` option consumed verbatim rather than manufacturing headers.
- `src/ui/aiChatPanel.ts` — make OMP engine routing use one bridge-owned descriptor/runtime, publish six engine lifecycle literals, clear retired ACP IDs, dispose the bridge/runtime exactly once on fallback/replacement/teardown, retain completed (not partial) panel history for builtin continuation, and own `MAX_ENGINE_RESTARTS = 2`, `DEFAULT_ENGINE_RESTART_DELAY_MS = 1000`, plus injectable `sleep(delayMs)`.
- `src/ui/aiChatPanelMessages.ts` — extend the real host-message contract for the six exact OMP lifecycle state literals.
- `webview/aiChatPanelMain.ts` — render the extended lifecycle state in the existing engine/session banner using textContent only.
- `src/extension.ts` — at the verified `buildAcpDeps()` / `commandOpenAiChat()` wiring (`:1072-1177` at planning), construct and pass the production OMP engine adapter only when `choice.engine === "omp"`; retain the builtin path when selection/detection fails.
- `src/ai/omp/hostMcp.ts` — retain `createHostMcp({ gatePost, tools, extensions? })` as the one authoritative standard/curated registry and standard-wins collision filter while OMP runs and after bridge/runtime exit.
- `src/ai/omp/mcpBridge.ts` — compose the bridge with the authoritative HostMcp registry for the production OMP runtime while preserving its existing bearer descriptor, `McpBridge` export surface, and TASK-AIX05-102 terminal disposal behavior.
- `src/ai/omp/__tests__/mcpBridge.test.ts` — regression-test that the production bridge composition preserves the HostMcp-selected standard descriptor/call path before and after bridge disposal.
- `src/ai/omp/__tests__/ompChatEngine.test.ts` — test engine adapter descriptor pass-through, generation guard, cancellation, crash, and bounded restart/fallback using the existing fake ACP session style.
- `src/ui/__tests__/aiChatPanelEngine.test.ts` — test panel lifecycle ordering, restart-limit fallback, Stop terminality, history continuity, and no stale runtime events.
- `src/ui/__tests__/aiChatPanelAcp.test.ts` — test bridge/session cleanup against its real `AcpClient` fake transport and retain AIX-03 recovery/cancel semantics.
- `src/ai/omp/__tests__/hostMcp.test.ts` — regression-test the curated-standard collision in the same runtime fixture before and after OMP bridge/runtime exit.
- `src/extension.test.ts` — assert live extension construction passes a production OMP engine only for the resolved OMP route and does not construct it for builtin fallback.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | resolved OMP route constructs one engine runtime | `commandOpenAiChat()` supplies panel `acp` plus an `ompChatEngine`; one bridge-owned bearer descriptor reaches `session/new` verbatim; startup posts `"starting"` then `"ready"`; a clean turn appends exactly one `[user, assistant]` pair; later shutdown posts `"stopped"`. | Existing extension/panel harness; fake process handle from TASK-AIX05-101 and fake MCP registry. |
| 2 | edge — missing binary | detection fallback remains builtin | Detection/choice indicates unavailable OMP; panel receives no OMP engine adapter, starts no ACP child/bridge, and the builtin agent path is selected. | Extension command harness with `detectOmp()` result `{ available:false, ok:false, reason:"not-installed" }`. |
| 3 | edge — cancellation from ready | repeated Stop has one terminal cancel path | Two Stop messages produce one `session/cancel`; lifecycle is exactly `"ready"`, `"cancelling"`, child-exit-observed `"stopped"` with no `"crashed"`/`"fallback-builtin"`; no partial assistant/user pair is appended and bridge/process cleanup occurs at runtime retirement. | Deferred OMP prompt with fake `AcpClient.notify` and process-exit spies. |
| 4 | edge — cancellation from starting | Stop aborts handshake without crash classification | Stop before ACP handshake resolves terminates/aborts the pending start, emits `"starting"` then `"stopped"`, starts no prompt, emits no crash/fallback event, and retains no bridge/session ID. exercised through the pinned cancellable seam: fixture captures the `AcpPanelDeps.create(...)` instance and asserts `process.cancel()` on that SAME instance (same generation) is the abort path — the deferred `start(): Promise<AcpProcessHandle>` shape must NOT be used. | Deferred handshake fake child + `create()`-capturing `buildAcpDeps()` fixture. |
| 5 | happy — restart under limit | first and second crashes restart the OMP runtime | Each ready-child crash emits `"crashed"`, schedules one replacement after exactly injected `sleep(1000)`, and the replacement reaching ready continues OMP without a fallback event; two restarts are permitted. | Fake sleep and three fake process/runtime generations. |
| 6 | edge — restart limit | crash at `MAX_ENGINE_RESTARTS = 2` falls back permanently | After two replacement attempts, the next ready-child crash makes no third start/sleep, posts exactly one `"fallback-builtin"`, disposes the exact bridge once, clears old session ID, persists builtin best-effort, and all later sends use builtin with completed history exactly once. | First clean OMP exchange followed by three controlled ready-child crashes. |
| 7 | edge — stale generation | old runtime cannot mutate replacement state | A late close/notification from the retired OMP runtime posts no delta/state and cannot cancel/reuse the replacement session. | Retire runtime A by crash/fallback or panel replacement, then feed its fake transport after runtime B/builtin is active. |
| 8 | regression — AIX-03 recovery | recovery keeps its existing fail-closed contract | During OMP turn, `recovering` invokes the one cancellation path and posts existing error state; `recovered` invokes neither cancel nor additional visible state. | Existing `onDidChangeRecoveryStatus` panel harness plus deferred OMP engine. |
| 9 | regression — AIX-08 collision | standard tool remains authoritative across OMP lifetime and exit | In `hostMcp.test.ts`, a standard and curated `catalog-probe` name collision produces exactly one standard descriptor and `"standard-wins"` result with curated calls `0` before runtime exit; in `mcpBridge.test.ts`, route the production bridge through that HostMcp-selected descriptor and after bridge/runtime disposal re-check that no curated descriptor/call is resurrected or shadows standard. | Existing `createHostMcp` collision fixture with standard/curated spies and OMP bridge/runtime teardown seam. |

## Test Files

- `src/ai/omp/__tests__/ompChatEngine.test.ts` — cases 3–6 at the engine boundary.
- `src/ai/omp/__tests__/mcpBridge.test.ts` — case 9 production bridge-composition regression.
- `src/ai/omp/__tests__/hostMcp.test.ts` — case 9 authoritative curated-vs-standard collision assertions.
- `src/ui/__tests__/aiChatPanelEngine.test.ts` — cases 1, 3–7 at the panel/webview-message boundary.
- `src/ui/__tests__/aiChatPanelAcp.test.ts` — case 8 and real fake-ACP bridge/session retirement assertions.
- `src/extension.test.ts` — cases 1–2 at current `commandOpenAiChat()` wiring.

## Verification Commands

```bash
npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts src/ai/omp/__tests__/mcpBridge.test.ts src/ai/omp/__tests__/hostMcp.test.ts src/ui/__tests__/aiChatPanelEngine.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/extension.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] The actual resolved-OMP construction path calls `createOmpChatEngine(opts: OmpChatEngineOptions): OmpChatEngine`; it does not run a parallel raw-ACP turn path for that same panel/runtime.
- [ ] All six exact `OmpEngineState` literals are represented in the host/webview lifecycle UI: `"stopped"`, `"starting"`, `"ready"`, `"cancelling"`, `"crashed"`, `"fallback-builtin"`.
- [ ] One OMP runtime generation has one bridge-owned `McpBridge.descriptor`, supplied through the engine's required descriptor option verbatim (including bearer headers) to ACP session creation and disposed exactly once on fallback/replacement/teardown; a retired descriptor cannot list/call tools (TASK-AIX05-102).
- [ ] Missing binary/start error/protocol mismatch route to `"fallback-builtin"`; a ready crash retries exactly through `MAX_ENGINE_RESTARTS = 2` with injected 1000-ms delay, while the crash at that limit emits exactly one `"fallback-builtin"`; config is best-effort persisted as `"builtin"`, and later turns use the existing builtin route without touching retired ACP state.
- [ ] Cancellation has one pinned terminal semantics: ready → cancelling → exit-observed → stopped; starting cancellation aborts handshake → stopped; neither route emits crashed/fallback. Repeated Stop remains idempotent.
- [ ] Panel history is the fallback source of truth: only clean completed OMP exchanges are retained; cancelled/crashed partial turns and cleared/retired ACP IDs are not replayed.
- [ ] Runtime generation/disposed guards make late notification/close events from an old child no-ops; recovery retains AIX-03’s `recovering`/`failed` stop and `recovered` no-op behavior.
- [ ] `src/ai/omp/__tests__/hostMcp.test.ts` proves the authoritative `createHostMcp({ gatePost, tools, extensions? })` registry retains standard-wins curated-name collision behavior while live and after OMP bridge/runtime exit: only the standard descriptor/result exists and the curated handler remains uncalled.
- [ ] UI rendering uses textContent only and retains AIX-07 redaction/policy behavior.
- [ ] All verification commands exit 0.

## Dependencies

- TASK-AIX05-101
- TASK-AIX05-102

## Interfaces

- Consumes:
  - TASK-AIX05-101’s `AcpStartHandlers.onStateChange?: (state: OmpEngineState) => void` and `AcpProcessHandle` members `acp: AcpClient`, `sessionId: string`, `version: string`, `state(): OmpEngineState`, `cancel(): void`, `dispose(): Promise<void>`, and optional `getStderrTail?: () => string` from `src/ai/omp/acpProcess.ts`.
  - `export interface McpBridge { descriptor: Record<string, unknown>; handleMcpRequest(req: { method: string; params?: unknown; id?: unknown }, token: string): Promise<{ result?: unknown; error?: { code: number; message: string } }>; dispose(): void; }` and the existing `createMcpBridge(registry: ToolRegistry): Promise<McpBridge>` from `src/ai/omp/mcpBridge.ts:38-48,152`, extended in this task with a concrete composition overload `createMcpBridge(hostMcp: HostMcp): Promise<McpBridge>` that forwards to HostMcp’s authoritative registry without changing exported `McpBridge` members. Bridge owns the descriptor; HostMcp owns the standard-plus-curated registry; TASK-AIX05-102 guarantees terminal disposal.
  - Current `export interface OmpChatEngineOptions { acp: AcpSession; hostMcp: HostMcp; cwd: string; trace?: TraceRecorder; enablePromptImage?: boolean; }`, extended in this task to `OmpChatEngineOptions & { mcpServers: ReadonlyArray<Record<string, unknown>> }`; `createOmpChatEngine(opts: OmpChatEngineOptions): OmpChatEngine`; and `OmpChatEngine.send(text: string, events: OmpChatEvents): Promise<void>; cancel(): void; shutdown(): Promise<void>` from `src/ai/omp/ompChatEngine.ts:118-147,328`. The production adapter must map the real `AcpClient` to `AcpSession` and supply the bridge descriptor verbatim through `mcpServers`—no `headers: []` reconstruction.
  - `export interface HostMcp { readonly port: number; readonly url: string; readonly sessionId: string; start(): Promise<void>; stop(): Promise<void>; call(name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }>; }` and `createHostMcp(opts: CreateHostMcpOptions): HostMcp`, where `CreateHostMcpOptions` is `{ gatePost: HostMcpPostPermission; tools: ReadonlyArray<HostMcpTool>; extensions?: ReadonlyArray<CuratedMcpTool>; unref?: boolean; }`, from `src/ai/omp/hostMcp.ts:31-88,151`. HostMcp owns standard plus curated descriptor lookup; the `curatedByName` filter excludes a curated name when `tools` already has it.
  - `AcpPanelDeps.start(ompPath: string, cwd: string, mcpServers?: ReadonlyArray<Record<string, unknown>>): Promise<AcpProcessHandle>` at `src/ui/aiChatPanel.ts:501-507`, plus current extension seam `buildAcpDeps(): AcpPanelDeps` and panel construction at `src/extension.ts:1072-1177`.
  - CANCELLABLE CONSTRUCTION SEAM (Round 2 finding 1): `AcpPanelDeps` is extended with `create(ompPath: string, cwd: string, mcpServers?: ReadonlyArray<Record<string, unknown>>): AcpProcess` — `create()` returns the UNSTARTED process synchronously; the panel then calls `process.start(...)` and, for a same-generation Stop during handshake, `process.cancel()` on that SAME instance. `buildAcpDeps()` implements `create()` via the pinned TASK-AIX05-101 constructor so the cancel path is reachable (the old `start(...): Promise<AcpProcessHandle>` shape made cancel unreachable because the process was created internally). `start()` remains for backward compatibility and MUST be implemented as `create(ompPath, cwd, mcpServers).start(...)` — one code path only.
  - HostMcp HANDLE MEMBER (Round 2 finding 2): the bridge composition overload `createMcpBridge(hostMcp: HostMcp)` requires `HostMcp.handle(req: { method: string; params?: unknown; id?: unknown }): Promise<{ result?: unknown; error?: { code: number; message: string } }>` — the existing member at `src/ai/omp/hostMcp.ts:74-76`. The authenticated bridge handler (`handleMcpRequest(req, token)`) delegates `tools/list` and `tools/call` to `hostMcp.handle(...)`, preserving the standard-wins list/call registry; `call(name, args)` alone cannot implement `tools/list` and MUST NOT be used for delegation.
- Produces:
  - A concrete production adapter that satisfies the real `OmpChatEngineOptions` surface and routes `AcpClient.request<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>`, `notify(method: string, params: unknown): void`, `onNotification(handler: AcpNotificationHandler): void`, `onClose(listener: AcpCloseListener): void`, and `dispose(): void` through the engine; bridge disposal is the only remote descriptor deregistration boundary.
  - Panel-owned restart policy constants `MAX_ENGINE_RESTARTS = 2` and `DEFAULT_ENGINE_RESTART_DELAY_MS = 1000`, with an injectable `sleep(delayMs: number): Promise<void>` seam, and the terminal event/state `"fallback-builtin"` when the limit is reached.
  - Extended host/webview message state whose lifecycle values are exactly the six `OmpEngineState` literals; no additional synonymous state literals.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Grounding: `src/ai/omp/ompChatEngine.ts:328` exports the engine factory, but `grep -R -n --include='*.ts' 'createOmpChatEngine' src` found no production construction; `AiChatPanel.runOmpEngineTurn()` at `src/ui/aiChatPanel.ts:2015-2127` is currently reachable only with an injected engine. `ensureAcpSession()` at `:2389-2511` owns a bridge for the raw ACP path, so do not leave it active in parallel with the new engine route. Implement the pinned TASK-AIX05-101 handle contract and this task’s `mcpServers`/`createMcpBridge(hostMcp)` contracts exactly; do not substitute a headerless descriptor or invent a deregistration API.

---

## Executor Report

(to be filled by executor with RED + GREEN evidence)
