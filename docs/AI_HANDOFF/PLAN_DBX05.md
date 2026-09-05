# PLAN_DBX05 — Connection Workspace

**Date:** 2026-08-30 · **Base:** main @ 23e17df · **Wave:** 3 (controlled actions)
**Roadmap anchor:** `docs/AI_HANDOFF/PRODUCT_ROADMAP.md` → DBX-05 Connection Workspace

## Goal and user outcome

Organize connections with **folders/colors**, enforce a per-connection **read-only intent**, and manage **SSH tunnels** with a lifecycle that never leaks processes. A developer with 20+ connections can group them (prod/staging/dev), visually flag production as read-only so mutating SQL is blocked before it reaches the server, and connect through a bastion without hand-managing `ssh -L` processes.

## Scope boundary (from roadmap)

- PostgreSQL only for tunnel-based flows; mysql/mssql connections continue to work ungrouped/untunneled (they simply ignore the new optional fields).
- **No** shared/team credential sync; no cloud account; tunnel keys come from the user's ssh-agent or an explicit identity file path.
- Read-only intent is a **client-side guard** (statement analysis + adapter gate), not a server `READ ONLY` role replacement — documented in UI copy.

## Existing surfaces consumed

- `src/core/connectionManager.ts` — `ConnectionManager` CRUD, SecretStorage keys `UnicDB.pass.<id>`, active-connection events, passive adapter cache.
- `src/config/types.ts` — `ConnectionConfig` (additive optional fields only).
- `src/core/dangerousStatement.ts` + `src/extension.ts#confirmDangerousStatements` — tier classification reused for the read-only guard.
- `src/ui/connectionForm.ts` — form webview (additive fields).
- `src/extension.ts#UnicDB.schemaTree` — tree provider renders connections (folders become virtual nodes).

## New modules

| File | Kind | Exports (contract) |
|---|---|---|
| `src/core/connectionGroups.ts` | NEW pure | `assignGroup(cfg, folder)`, `groupColor(folder)`, `listGroups(conns): string[]`, `GROUP_COLOR_PALETTE` (8 fixed hex colors), pure stdlib only |
| `src/core/readOnlyIntent.ts` | NEW pure | `isMutationSql(text, dialect): boolean` (reuses dangerousStatement's statement analysis; treats GRANT/REVOKE/KILL as mutations too), `ReadOnlyViolation` error type; NO vscode import |
| `src/core/sshTunnel.ts` | NEW pure-ish | `buildTunnelArgs(cfg): string[]` (validated ssh argv), `parseTunnelProcLine(line): TunnelProc | null` (ps output parser), `TunnelConfig` type; spawns NOTHING itself — pure argv/parse only; NO vscode import |
| `src/core/sshTunnelManager.ts` | NEW runtime | `SshTunnelManager.start(cfg): Promise<{localPort}>`, `.stop(id)`, `.stopAll()`, `.list(): TunnelHandle[]`; child_process spawn of the validated argv, cleanup on dispose; survives only in-memory |

## Behavior contracts

1. **Folders/colors** — `folder?: string`, `color?: string` (one of the fixed palette) on `ConnectionConfig`. Schema tree shows collapsible folder nodes when ≥1 connection has a folder; ungrouped connections stay at root. Folder color drives the tree icon color.
2. **Read-only intent** — `readOnly?: boolean` on `ConnectionConfig`. When set, every `runQuery` path funnels through `readOnlyIntent.isMutationSql` FIRST; a mutation throws `ReadOnlyViolation` BEFORE any network I/O. The prompt-level dangerous confirmation still runs afterward for non-readonly connections (no behavior change).
3. **SSH tunnels** — `tunnel?: { host: string; port?: number; user?: string; identityFile?: string; }` on `ConnectionConfig`. When present, `ConnectionManager.getAdapter` starts a tunnel (idempotent per connection id), rewrites `host`/`port` to `127.0.0.1:<localPort>` for the adapter config ONLY (persisted metadata untouched), and `stopAll()` runs on extension dispose. Invalid tunnel args (metacharacters in host/user, missing host) are rejected by `buildTunnelArgs` with a typed error — no shell interpolation ever.

## Tasks (TDD; every task quotes RED output in its report)

| ID | Title | Owns |
|---|---|---|
| TASK-DBX05-001 | connectionGroups + readOnlyIntent pure modules + tests | `src/core/connectionGroups.ts`, `src/core/readOnlyIntent.ts` + tests |
| TASK-DBX05-002 | sshTunnel argv/parse + SshTunnelManager lifecycle + tests | `src/core/sshTunnel.ts`, `src/core/sshTunnelManager.ts` + tests |
| TASK-DBX05-003 | ConnectionConfig fields + ConnectionManager tunnel/read-only wiring + form/tree | `src/config/types.ts`, `src/core/connectionManager.ts`, `src/ui/connectionForm*.ts`, tree provider, `src/extension.ts` dispose wiring |
| TASK-DBX05-004 | scaffold hygiene + extension regression + docs | `src/__tests__/dbx05Scaffold.test.ts`, `package.json` (no new commands needed), CHANGELOG entries |

## Verification commands (mandated)

```bash
npm run typecheck
npx vitest run src/core/__tests__/connectionGroups.test.ts src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/sshTunnel.test.ts src/core/__tests__/sshTunnelManager.test.ts src/core/__tests__/connectionManager.test.ts src/ui/__tests__/connectionForm.test.ts src/__tests__/dbx05Scaffold.test.ts src/extension.test.ts
npm test
npm run compile
```

## Reviewer gate

unic-smart reviewer (different model from executor) re-runs the mandated commands fresh and audits: injection surface of tunnel argv, read-only bypass attempts (multi-statement, comments, CTE-wrapped mutations), tunnel process leak on dispose, and SecretStorage non-interference. Verdicts appended to TASK-DBX05-001.md and TASK-DBX05-004.md; fix rounds until APPROVED.

## Release

Ships as **v1.20.0** (tag + vsix + GitHub Release) after APPROVED + docs closure.
