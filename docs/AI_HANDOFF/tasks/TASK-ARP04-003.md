# TASK-ARP04-003 — Manager integration: intended-key stop + loopback routing retention

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1–§4 (ARP-04.3)

## Goal

Pin the connectionManager↔tunnel contract: edit/delete/add-probe stop **only the intended tunnel key** (`probe-<id>` / `<id>`, never a sibling connection's key), and loopback routing hands the adapter `127.0.0.1:<handle.localPort>` while the persisted `ConnectionConfig` host/port stay unchanged. No behavioral change is expected unless a test proves a real gap — the tests lock the existing per-key stop semantics and routing contract.

## Target Files

- `src/core/connectionManager.ts` — change ONLY if a test reveals a real gap; expected: no production change (the per-key stop wiring already exists: `addConnection` probe cleanup `:181`, `editConnection` `stopTunnel('probe-'+id)` `:245` + `stopTunnel(id)` `:263`, `deleteConnection` `stopTunnel(id)` `:302`, `resolveAdapter` key = `keyOverride ?? cfg.id` `:692-701`, `stopTunnel` = `tunnels.stop(id)` `:751-754`).
- `src/core/__tests__/connectionManager.test.ts` — add the new cases below to the existing `makeFakeTunnels()` harness (which records `startCalls: {key,port}[]` and `stopCalls: string[]`, `:540-566`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | loopback routing retains persisted host/port | tunneled cfg (host `bastion`, port `5432`) → the adapter `factory` receives `{...cfg, host: "127.0.0.1", port: <handle.localPort>}` while `state.connections` still holds host `bastion` / port `5432` unchanged (persisted metadata never rewritten to the loopback form) | `makeFakeTunnels()` harness (existing pattern, `connectionManager.test.ts:574-606`) |
| 2 | edge: intended key (edit) | edit stops only its own probe + old tunnel | `editConnection("c1")` on a tunneled id → `stopCalls` contains `probe-c1` then `c1`, does NOT contain `c2`; a live tunnel for `c2` is untouched (`stopCalls` exact-set assertion) | two seeded tunneled connections |
| 3 | edge: intended key (delete) | delete stops only the deleted id | `deleteConnection("c1")` → `stopCalls` contains `c1`, not `c2` | two seeded tunneled connections |
| 4 | edge: intended key (add-probe failure) | failed add cleans its own probe only | `addConnection(c1)` whose `testConnection()` rejects → `stopCalls` contains `c1`, not `c2` (cleanup path `connectionManager.ts:181`) | `makeFakeTunnels()` harness + failing adapter |
| 5 | edge: probe key isolation | probe uses `probe-<id>` so it never reuses a live `<id>` tunnel | a probe/`editConnection` calls `start(..., "probe-c1")` and never `"c1"` (`startCalls` keys); a same-id re-probe while a live `c1` tunnel exists does not reuse or stop `c1` | `makeFakeTunnels()` harness |
| 6 | regression | recovery gate unchanged | an **intentional** tunnel exit for the active key does NOT enter recovery (`handleTunnelExit` `exit.intentional` short-circuit, `connectionManager.ts:482-498`); no recovery status emitted | `makeFakeTunnels().emitExitFor(key, { intentional: true })` |

## Test Files

- `src/core/__tests__/connectionManager.test.ts` — new cases above (extend the RLX-03/ARP-02 harness; do NOT touch `src/core/__tests__/sshTunnel.test.ts` or `sshTunnelManager.test.ts`).

## Verification Commands

```bash
# connectionManager.ts → tests-map [connectionManager.test.ts]
npx vitest run src/core/__tests__/connectionManager.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in this repo — `typecheck` + `compile` are the static gates.

## Acceptance Criteria

- [ ] `editConnection`/`deleteConnection`/`addConnection`-probe stop calls target ONLY the intended key(s) (`probe-<id>`/`<id>`), and never a sibling connection's key — asserted via `makeFakeTunnels().stopCalls` exact-set checks.
- [ ] `resolveAdapter`'s probe key is `probe-<id>` (never `id`), so a same-id re-probe cannot reuse a live tunnel.
- [ ] Loopback routing delivers `127.0.0.1:<handle.localPort>` to the adapter while persisted `ConnectionConfig` host/port remain unchanged.
- [ ] The recovery gate still ignores intentional exits (regression pin).
- [ ] `src/core/connectionManager.ts` is unchanged UNLESS a test proved a real gap (record the gap + fix in the Executor Report); all new + existing `connectionManager.test.ts` cases pass; typecheck + compile green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP04-000 (policy gate), TASK-ARP04-001 (strict flag in `buildTunnelArgs`), TASK-ARP04-002 (manager lifecycle evidence). Wave 3.

## Interfaces

- Consumes: `SshTunnelManager.start(cfg, key)`, `SshTunnelManager.stop(key)`, `TunnelHandle` (`{key, localPort, child}`) — consumed by `resolveAdapter` (`connectionManager.ts:692-700`); `TunnelExit` — consumed by `handleTunnelExit` (`:482-498`); the existing `ConnectionManager` constructor injection `tunnels?: SshTunnelManager` (`:136-141`).
- Produces: (none — test-only task; no new public API). Evidence that the `SshTunnelManager` per-key contract (TASK-ARP04-002) is honored at the connectionManager boundary.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
