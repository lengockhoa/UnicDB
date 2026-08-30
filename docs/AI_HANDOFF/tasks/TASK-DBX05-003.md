# TASK-DBX05-003 — Config fields + ConnectionManager wiring + form/tree

**Status:** pending
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

Wire the DBX05-001/002 modules into the product: additive `ConnectionConfig` fields, `ConnectionManager` read-only gate + tunnel lifecycle, connection form fields, schema-tree folder nodes.

## Target Files

- `src/config/types.ts` — ADDITIVE: `folder?: string; color?: string; readOnly?: boolean; tunnel?: { host: string; port?: number; user?: string; identityFile?: string; };` on `ConnectionConfig`.
- `src/core/connectionManager.ts` — ADDITIVE:
  - constructor accepts optional `tunnels?: SshTunnelManager` (default new instance).
  - `getAdapter` (active path) and `getAdapterFor` (passive path): when `cfg.readOnly`, wrap the returned adapter's `runQuery` with `readOnlyIntent.isMutationSql` check — mutation → throw `ReadOnlyViolation` BEFORE connect/IO; when `cfg.tunnel`, ensure tunnel started for `cfg.id` and build the adapter cfg with rewritten host/port (`127.0.0.1:<localPort>`); persisted metadata untouched.
  - `dispose()` → `tunnels.stopAll()`. `deleteConnection`/`editConnection` stop that connection's tunnel (edit may restart with new config).
- `src/ui/connectionForm.ts` + `src/ui/connectionFormMessages.ts` — ADDITIVE: folder (text), color (palette picker — send hex list to webview), read-only (checkbox), tunnel host/port/user/identityFile fields. Round-trip through existing save message.
- Tree provider (wherever `vsdb.schemaTree` connections are produced) — ADDITIVE: when any connection has a folder, group under folder nodes (label = folder name, collapsible, icon color = assignColor(folder)); ungrouped stay at root.
- Tests: extend `src/core/__tests__/connectionManager.test.ts` and `src/ui/__tests__/connectionForm.test.ts`.

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | unit | readOnly config: runQuery(SELECT) passes |
| 2 | unit | readOnly config: runQuery(DELETE) throws ReadOnlyViolation, adapter NOT connected |
| 3 | unit | tunnel config: adapter cfg host=127.0.0.1 port=localPort; persisted cfg unchanged |
| 4 | unit | edit/delete stops the connection's tunnel |
| 5 | unit | dispose stops all tunnels |
| 6 | unit | form round-trips folder/color/readOnly/tunnel fields |
| 7 | unit | tree groups folders; ungrouped at root |
| 8 | regression | existing connectionManager + form + extension tests stay green |

## Verification

```bash
npx vitest run src/core/__tests__/connectionManager.test.ts src/ui/__tests__/connectionForm.test.ts src/extension.test.ts
npm run typecheck
```

## Executor Report

(to be filled by executor with RED + GREEN evidence)
