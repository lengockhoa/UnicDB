# TASK-RLX03-002 — Bound active tunnel reconnects and surface status

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_RLX03.md` §1–§3

## Goal

On an unexpected exit from the current active connection’s ready SSH tunnel, close the dead lazy adapter and make exactly two scheduler-controlled reconnect attempts through the existing `getAdapter()` path. Surface the bounded state through ConnectionManager and the existing status bar without retrying intentional, passive, stale, duplicate, or shutdown exits. If the recovering connection loses active/lifecycle ownership while recovery awaits, abort silently: make no later attempt, status write, or callback after disposal.

## Target Files

- `src/core/connectionManager.ts` — consume TASK-RLX03-001’s tunnel-exit contract; add the pinned injectable recovery options, one in-flight recovery per active id, active/lifecycle-generation cancellation guards around every recovery await, bounded reconnect/cleanup, and typed `"recovering"`/`"recovered"`/`"failed"` status emission.
- `src/core/__tests__/connectionManager.test.ts` — extend the existing mocked vscode/adapter/tunnel harness with deterministic tunnel-exit and injected-scheduler recovery tests.
- `src/ui/statusBar.ts` — subscribe to the new manager recovery-status event and render the pinned transition/success/failure text while retaining normal active text and disposal behavior.
- `src/ui/__tests__/statusBar.test.ts` — extend the existing status-bar mock harness with exact recovery-text and return-to-normal assertions.

## Approach

- Export `ConnectionRecoveryOptions` and add it as the fourth, optional constructor parameter after the existing optional `tunnels` parameter: `constructor(ctx: vscode.ExtensionContext, factory: AdapterFactory, tunnels?: SshTunnelManager, recoveryOptions: ConnectionRecoveryOptions = {})`. Set `DEFAULT_RECOVERY_DELAY_MS = 1_000`; use `recoveryOptions.delayMs ?? DEFAULT_RECOVERY_DELAY_MS` and `recoveryOptions.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))`. This preserves all existing three-argument construction and the source’s millisecond timer convention.
- At recovery start, capture `connectionId`, the current active-generation, and lifecycle-generation. Increment active generation synchronously before the first await in `setActive`, `editConnection`, and `deleteConnection` when they affect the active id; increment lifecycle generation synchronously before the first await in `dispose`. Re-check that the manager is not disposed, the captured generations still match, `currentActiveId === connectionId`, and `getActive()?.id === connectionId` both before and after every recovery `await` (old-adapter close, inter-attempt sleep, and `getAdapter()`/connection path).
- A failed guard silently ends the one recovery promise: it must not begin another attempt, write `"recovered"` or `"failed"`, or invoke later recovery-status listeners. If a guarded `getAdapter()` await returned an adapter after ownership changed, close/discard that candidate without assigning it to `currentAdapter`; recovery must never close or connect the new active connection.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | `unexpected active tunnel exit reconnects on first attempt` | The old active adapter closes once; factory creates/tests one replacement adapter; scheduler is not called before first attempt; emitted states are exactly `"recovering"`, then `"recovered"`, both with `maxAttempts: 2`. | Active saved tunnel config, fake TASK-RLX03-001 exit emitter, distinct adapter factory results, injected `sleep` spy. |
| 2 | edge — retry boundary | `second failure ends recovery after exactly two attempts` | Two replacement adapters each call `testConnection()` then `close()` after rejection; scheduler is called exactly once between attempts; final state is exactly `"failed"`; no third factory/test/sleep call occurs. | Fake exit emitter, factory returning two failing deferred/test adapters, deterministic scheduler. |
| 3 | edge — dispose during backoff | `dispose aborts a recovering connection while injected sleep is pending` | After attempt 1 fails and the recovery awaits its one injected `sleep(DEFAULT_RECOVERY_DELAY_MS)`, `dispose()` invalidates the captured lifecycle generation; resolving sleep produces no attempt 2, no `"failed"`/`"recovered"` status, no factory/test call, and no status-bar callback after disposal. | Deferred `sleep`, first failing adapter, recovery-status listener/status-bar subscription spies, then `await mgr.dispose()`. |
| 4 | edge — switch during connect | `active switch aborts an old recovery while its replacement connect is pending` | After old connection `c1` emits recovery and its `getAdapter()`/`testConnection()` await is pending, `setActive("c2")` invalidates c1’s captured active generation; settling c1’s connect closes/discards its candidate without installing it, emits no `"recovered"`/`"failed"` for c1, and starts no later c1 attempt or scheduler delay. | Two saved tunneled configs, deferred c1 replacement adapter connection/test path, then `await mgr.setActive("c2")`. |
| 5 | edge — duplicate/ownership | `duplicate, intentional, passive, and stale-key exits do not create extra recovery` | A duplicate unexpected active exit shares one recovery; `intentional: true`, a non-active key, and an old key after active switch make zero factory/scheduler/status calls. | Controllable fake tunnel exit emitter with active/passive/stale configs. |
| 6 | regression | `normal and recovery status-bar copy is exact` | Normal active render remains exactly `$(database) Local [postgres]`; received statuses render exactly `$(sync~spin) Local reconnecting (1/2)`, `$(check) Local reconnected`, and `$(error) Local reconnect failed`; a later active change renders its normal text. | Existing fake StatusBarItem and manager event harness. |

## Test Files

- `src/core/__tests__/connectionManager.test.ts` — manager recovery, adapter close/test, scheduler, and exit-event ownership assertions.
- `src/ui/__tests__/statusBar.test.ts` — exact status-bar literals and subscription disposal assertions.

## Verification Commands

```bash
npx vitest run src/core/__tests__/connectionManager.test.ts src/ui/__tests__/statusBar.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] Recovery reacts only to TASK-RLX03-001’s unexpected post-ready exit for the currently active connection whose `ConnectionConfig.tunnel` is present.
- [ ] Recovery closes/drops the old active adapter before it calls the existing `getAdapter(): Promise<DbAdapter>` lazy construction path, uses no server-specific reconnect API, and creates no passive-adapter recovery.
- [ ] `ConnectionRecoveryOptions` is pinned to `delayMs: 1_000` and `sleep(ms: number): Promise<void>` by default; `maxAttempts` is pinned to `2`; only the delay between failed attempts uses the scheduler; terminal failure never schedules or starts attempt three.
- [ ] Every recovery captures its connection id plus active/lifecycle generations, and re-checks both before and after every awaited close, delay, and `getAdapter()`/connect path: switch, edit, delete, or dispose invalidates the recovery so it emits no later status/callback and starts no later attempt; a post-await stale candidate is closed/discarded rather than installed.
- [ ] `ConnectionRecoveryStatus.state` is exactly one of `"recovering"`, `"recovered"`, or `"failed"`; duplicate exit events share one loop and intentional/shutdown/stale events are silent.
- [ ] Status-bar text matches all three pinned recovery literals exactly and its normal active-connection behavior/subscription cleanup remains intact.
- [ ] All listed tests pass and reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-RLX03-001

## Interfaces

- Consumes: `SshTunnelManager.onDidExit(listener: (exit: TunnelExit) => void): { dispose(): void }` and `TunnelExit { readonly key: string; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly intentional: boolean; }` produced by TASK-RLX03-001; current `ConnectionManager.getAdapter(): Promise<DbAdapter>`, `private closeCurrentAdapter(): Promise<void>`, `private resolveAdapter(cfg: ConnectionConfig, password: string, keyOverride?: string): Promise<DbAdapter>`, and `ConnectionConfig.tunnel` from `src/core/connectionManager.ts`.
- Produces: exported `ConnectionRecoveryOptions { readonly delayMs?: number; readonly sleep?: (ms: number) => Promise<void>; }` and `export const DEFAULT_RECOVERY_DELAY_MS = 1_000`; the backward-compatible constructor becomes `constructor(ctx: vscode.ExtensionContext, factory: AdapterFactory, tunnels?: SshTunnelManager, recoveryOptions: ConnectionRecoveryOptions = {})`. Its effective delay is `recoveryOptions.delayMs ?? DEFAULT_RECOVERY_DELAY_MS`; its scheduler is `recoveryOptions.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))`. Exported `ConnectionRecoveryStatus { readonly connectionId: string; readonly state: "recovering" | "recovered" | "failed"; readonly attempt: number; readonly maxAttempts: number; }` and `readonly onDidChangeRecoveryStatus: vscode.Event<ConnectionRecoveryStatus>`; private active/lifecycle-generation guards re-check ownership before and after every recovery await and silently abort stale work. `ConnectionManager.getAdapter(): Promise<DbAdapter>` and `createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem` retain their existing signatures.

---

## Discussion

### 2026-09-01 · planner · unic-smart
The existing manager owns the tunnel (`private readonly tunnels`), starts it only inside `private resolveAdapter(...)`, and already has a safe `private closeCurrentAdapter(): Promise<void>` cleanup path. Do not retry inside `SshTunnelManager`; it has no password or active-adapter ownership. The planned event begins after a returned ready handle only, so no recovery is expected for initial start failure. Keep all retry timing injected; tests must not wait on real time.

---

## Executor Report
