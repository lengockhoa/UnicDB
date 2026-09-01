# TASK-RLX03-001 — Make SSH child exit observable and restart-safe

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_RLX03.md` §1–§3

## Goal

Make a post-ready SSH child exit an explicit, one-time tunnel lifecycle event and eliminate same-key `start()` races. A new start after that exit must receive a fresh handle/port proof, while intentional manager stops remain distinguishable so consumers do not mistake shutdown for failure.

## Target Files

- `src/core/sshTunnelManager.ts` — add typed post-ready child-exit observation, intentional-stop bookkeeping, and same-key in-flight `start()` coalescing with settlement cleanup while preserving spawn/PID-proof behavior.
- `src/core/__tests__/sshTunnelManager.test.ts` — extend the existing fake-SSH lifecycle suite with exit-event, same-key concurrency, rejection-cleanup, and restart assertions.
- `src/core/__tests__/fixtures/fake-ssh.mjs` — make only the existing local fake-SSH child’s exit control deterministic if its current SIGTERM-only behavior cannot distinguish the planned unexpected-exit fixture; do not add network access or a shell execution path.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | `coalesces concurrent same-key starts then returns a fresh handle after unexpected exit` | Two pending `start(cfg, "c1")` calls resolve to the exact same `TunnelHandle`; after the child’s unmarked exit, `list()` is `[]`, exactly one event has `{ key: "c1", intentional: false }`, and the next start returns a different handle/child with `localPort > 0`. | Existing shim plus fake SSH fixture; concurrent calls before first readiness and direct child termination after readiness. |
| 2 | edge — intentional lifecycle | `stop and stopAll mark child exits intentional before deleting handles` | `stop("c2")` returns `true`, removes its handle immediately, and its event has `intentional: true`; `stopAll()` does the same for every tracked key, and a later start does not reuse the stopped handle. | Two ready fixture tunnels, one stopped individually and one by `stopAll()`. |
| 3 | edge — failure/concurrency | `coalesces a same-key missing-binary rejection and clears its in-flight record` | Two concurrent `start(cfg, "bad")` promises reject with the existing `/failed to start ssh|exited before becoming ready/` error; a subsequent start is a fresh spawn attempt rather than receiving the prior settled rejection. | `new SshTunnelManager("/nonexistent/vsdb-missing-ssh")`. |
| 4 | regression | `different keys retain independent live handles` | `start(cfg, "c4a")` and `start(cfg, "c4b")` produce two listed handles; stopping one leaves the other live until its own terminal path. | Existing two-key `stopAll` fixture pattern. |

## Test Files

- `src/core/__tests__/sshTunnelManager.test.ts` — all test cases above using the existing fake-SSH shim.
- `src/core/__tests__/fixtures/fake-ssh.mjs` — fixture support only if required to drive the test child’s unexpected exit deterministically.

## Verification Commands

```bash
npx vitest run src/core/__tests__/sshTunnelManager.test.ts src/core/__tests__/sshTunnel.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] Concurrent `start(cfg, key)` calls share one pending promise and the in-flight entry is cleared after both success and rejection.
- [ ] A ready child’s terminal event first deletes only its own current map entry and then emits exactly one typed event containing its key, exit code/signal, and `intentional` state.
- [ ] `stop()`/`stopAll()` mark expected exits before `SIGTERM`; an intentional exit never leaves a reusable handle.
- [ ] A restart after any prior terminal event uses the existing fresh-port allocation and listener PID ownership proof; the task does not weaken `spawn()`-only execution or readiness failure literals.
- [ ] All listed tests pass and reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: `SshTunnelManager.start(cfg: TunnelConfig, key: string): Promise<TunnelHandle>`, `SshTunnelManager.stop(key: string): boolean`, `SshTunnelManager.stopAll(): void`, `SshTunnelManager.list(): TunnelHandle[]`, and `TunnelHandle { readonly key: string; readonly localPort: number; readonly child: ChildProcess; }` from `src/core/sshTunnelManager.ts`; `buildTunnelArgs(cfg: TunnelConfig): string[]` from `src/core/sshTunnel.ts`.
- Produces: exported `TunnelExit` with `readonly key: string`, `readonly code: number | null`, `readonly signal: NodeJS.Signals | null`, and `readonly intentional: boolean`; `SshTunnelManager.onDidExit(listener: (exit: TunnelExit) => void): { dispose(): void }`, emitted exactly once only for a child that reached a returned `TunnelHandle` state. `SshTunnelManager.start(cfg: TunnelConfig, key: string): Promise<TunnelHandle>` remains its existing signature.

---

## Discussion

### 2026-09-01 · planner · unic-smart
`child.once("exit", () => { if (this.tunnels.get(key) === h) this.tunnels.delete(key); })` is the current post-ready cleanup seam. Preserve the existing pre-ready rejection literal and listener-PID ownership proof. The new event must not fire for a child that never reached the returned-handle lifecycle because ConnectionManager only owns recovered active tunnels after successful `start()`.

---

## Executor Report
