# TASK-DBX05-002 — sshTunnel argv/parse + SshTunnelManager lifecycle

**Status:** implemented — awaiting reviewer (unic-smart)
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

SSH tunnel plumbing: a pure argv builder/ps parser (`src/core/sshTunnel.ts`) and a runtime manager (`src/core/sshTunnelManager.ts`) that spawns `ssh` with EXACTLY the validated argv (no shell), tracks handles, and stops everything on dispose. No vscode import in either file.

## Target Files

- `src/core/sshTunnel.ts` — NEW pure:
  - `interface TunnelConfig { host: string; port?: number; user?: string; identityFile?: string; localPort?: number; }`
  - `buildTunnelArgs(cfg: TunnelConfig): string[]` — returns ssh argv (N, L forwarding). Validations (throw `TunnelError` typed codes): host non-empty; host/user restricted to `[A-Za-z0-9._-]` (user additionally allows nothing else; no `@` splitting — caller passes `user@host` only via user field); port 1..65535; identityFile absolute-looking path, no whitespace; localPort when provided 1024..65535, default 0 → ssh picks ephemeral.
  - `parseTunnelProcLine(line: string): TunnelProc | null` — parse a `ps -o pid=,args=` line carrying our `vsdb-tunnel` marker; returns `{ pid, localPort? }` or null.
- `src/core/sshTunnelManager.ts` — NEW runtime:
  - `class SshTunnelManager` — `start(cfg, key): Promise<TunnelHandle>` spawns ssh (NO shell), waits for `Local forwarding listening on 127.0.0.1:<port>` (10s timeout → kill + throw); `stop(key)`, `stopAll()`, `list()`, `dispose()`. Idempotent per key.
- Tests:
  - `src/core/__tests__/sshTunnel.test.ts` — argv shape, validation errors, parse accept/reject.
  - `src/core/__tests__/sshTunnelManager.test.ts` — FAKE ssh fixture (`src/core/__tests__/fixtures/fake-ssh.mjs`): prints listening line with a fixed port, stays alive, exits on SIGTERM. Cover: start resolves, list/stop/stopAll, idempotent start, child killed after stop.

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | unit | buildTunnelArgs default shape |
| 2 | unit | reject bad host chars / whitespace |
| 3 | unit | reject port out of range |
| 4 | unit | reject identityFile with whitespace |
| 5 | unit | parse proc line ok / foreign null |
| 6 | integration (fixture) | start resolves with fixture port |
| 7 | integration | stop kills child; stopAll drains list |
| 8 | integration | double start idempotent |

## Verification

```bash
npx vitest run src/core/__tests__/sshTunnel.test.ts src/core/__tests__/sshTunnelManager.test.ts
npm run typecheck
```

## Executor Report

### Executor (unic-code)

**RED evidence**: first run of `npx vitest run src/core/__tests__/sshTunnel.test.ts src/core/__tests__/sshTunnelManager.test.ts` failed at module load — `sshTunnelManager.ts` referenced `TunnelConfig`/fixtures before they existed (import-time RED, module not found). After wiring the fixture shim (`makeShim()` writes a temp `/bin/sh` wrapper exec'ing `node fixtures/fake-ssh.mjs`) both suites went green.

**GREEN evidence**: `npx vitest run src/core/__tests__/sshTunnel.test.ts src/core/__tests__/sshTunnelManager.test.ts` → all passed (14 total). `spawn` (no shell), validated argv via `buildTunnelArgs`, readiness parsed from `Local forwarding listening on 127.0.0.1 port (\d+)`, 10s timeout, `-o SetEnv=vsdb-tunnel:<key>` marker, `stop`/`stopAll`/`dispose`.

