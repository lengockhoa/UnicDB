# TASK-AIX05-102 — Terminal MCP bridge disposal guard

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX05.md` §3

## Goal

Make a disposed OMP MCP bridge terminal and idempotent so a retired OMP runtime cannot list, re-register, or invoke database tools through a stale descriptor/socket.

## Target Files

- `src/ai/omp/mcpBridge.ts` — make `McpBridge.dispose(): void` idempotent and make the pure request handler fail closed after disposal before any registry/tool access.
- `src/ai/omp/__tests__/mcpBridge.test.ts` — extend the existing direct-handler and real-loopback lifecycle tests for terminal disposal behavior.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | live bridge lists the supplied registry once | Authorized `tools/list` returns the exact registered names once each and calls `registry.list()` once. | Existing minimal registry and token extracted from the bridge descriptor. |
| 2 | edge — disposed registry | tools/list after dispose is fail-closed | After first `dispose()`, authorized `tools/list` returns `{ error: { code: -32000, message: "MCP bridge is disposed" } }`; `registry.list()` is not called. | Bridge with a `registry.list` spy. |
| 3 | edge — side-effect prevention | tools/call after dispose cannot execute | After disposal, authorized `tools/call` returns error `-32000` / `MCP bridge is disposed`; `tool.execute` is called zero times. | Registry exposes an executable fake tool. |
| 4 | regression — duplicate dispose | second disposal cannot reopen or throw | Calling `dispose()` twice does not throw; both an existing hanging HTTP socket and new connection attempts remain closed/refused. | Existing raw `http`/`net` hanging-connection fixture. |

## Test Files

- `src/ai/omp/__tests__/mcpBridge.test.ts` — all cases above; preserve its pure-handler-first and loopback-only socket pattern.

## Verification Commands

```bash
npx vitest run src/ai/omp/__tests__/mcpBridge.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `McpBridge.dispose(): void` is idempotent and permanently marks its bridge inactive before closing server resources.
- [ ] After disposal, `handleMcpRequest(...)` returns exactly `{ error: { code: -32000, message: "MCP bridge is disposed" } }` for both list and call paths before bearer-authenticated registry dispatch; no registry/tool spy is called.
- [ ] The bridge remains loopback-only, bearer-authenticated, and preserves all pre-disposal request semantics/error wording.
- [ ] Disposal closes active connections and does not permit a new connection to the released loopback port.
- [ ] All verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes:
  - `export interface McpBridge { descriptor: Record<string, unknown>; handleMcpRequest(req: { method: string; params?: unknown; id?: unknown }, token: string): Promise<{ result?: unknown; error?: { code: number; message: string } }>; dispose(): void; }` at `src/ai/omp/mcpBridge.ts:38-48`.
  - `createMcpBridge(registry: ToolRegistry): Promise<McpBridge>` at `src/ai/omp/mcpBridge.ts:152`.
  - `ToolRegistry.list(): AgentTool[]` and `ToolRegistry.get(name: string)` as used by `makeHandler()` at `src/ai/omp/mcpBridge.ts:99-125`.
- Produces:
  - Terminal disposal behavior: after `dispose()`, `McpBridge.handleMcpRequest(...)` returns `error.code === -32000` and `error.message === "MCP bridge is disposed"` without reaching its `ToolRegistry`.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Grounding: `mcpBridge.ts` already binds only `127.0.0.1`, calls `server.unref()`, and uses `closeAllConnections()` plus `server.close()` in `dispose()`. Its test file already verifies port release and a hung active connection, so terminal request guarding belongs in the existing pure handler rather than a new test server. TASK-AIX05-103 depends on this behavior before it can safely retire a bridge during engine fallback.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/ai/omp/__tests__/mcpBridge.test.ts (pre-implementation):
   FAIL … terminal disposal > after dispose, authorized tools/list returns …
  AssertionError: expected { result: { tools: [] } } to deeply equal { error: { code: -32000, …(1) } }
   ❯ src/ai/omp/__tests__/mcpBridge.test.ts:448:17
   FAIL … terminal disposal > after dispose, authorized tools/call returns -32000 …
  AssertionError: expected { result: { content: [ { text: "should never run" … } ] } } to deeply equal { error: { code: -32000, …(1) } }
   ❯ src/ai/omp/__tests__/mcpBridge.test.ts:471:17
   Test Files  1 failed (1)
        Tests  2 failed | 13 passed (15)
  (TC1 happy + TC4 double-dispose passed pre-impl as expected: TC1 asserts existing live behavior; TC4's throw/socket checks hold under the old safe path.)
Verification Output: |
  npx vitest run src/ai/omp/__tests__/mcpBridge.test.ts
   ✓ src/ai/omp/__tests__/mcpBridge.test.ts  (15 tests) 119ms
   Test Files  1 passed (1) | Tests 15 passed (15)
  npx vitest run src/ai/omp src/ai/tools  (touched modules + neighbors)
   Test Files  16 passed | 1 skipped (17) | Tests 269 passed | 2 skipped (271)
  npm run typecheck  → exit 0 (tsc --noEmit, no errors)
  npm run compile    → exit 0 (esbuild: build complete)
Status: PASS
Note: dispose() now sets a terminal `disposed` flag before closing server resources (idempotent, no re-open/throw); a wrapper around the pure handler returns exactly { error: { code: -32000, message: "MCP bridge is disposed" } } post-disposal before any bearer-auth registry/tool dispatch — TC1-4 all green, pre-disposal semantics untouched (loopback-only, bearer auth, error wording preserved).
