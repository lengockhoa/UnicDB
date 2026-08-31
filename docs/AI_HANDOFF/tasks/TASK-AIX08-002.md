# TASK-AIX08-002 — Contain curated extensions in host MCP calls

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX08.md` §3

## Goal

Integrate the curated registry output into the existing loopback host MCP server and contain extension invalid-input, capability, timeout, and crash outcomes as deterministic MCP `isError` results. Preserve existing `HostMcpTool` listing, permission-gate, deny, error, HTTP, and lifecycle behavior.

## Target Files

- `src/ai/omp/hostMcp.ts` — accept policy-admitted `CuratedMcpTool[]` with existing standard `HostMcpTool[]`; use their exported metadata to validate/contain calls without changing standard-tool semantics.
- `src/ai/omp/__tests__/hostMcp.test.ts` — extend the verified host MCP test suite with curated list/call, timeout, crash, and standard-tool regression cases.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `admitted curated tool appears in tools/list and returns MCP text content` | `tools/list` includes `catalog_probe` with its declared `inputSchema`; a valid `tools/call` returns `content[0].text === "catalog ok"` and no `isError: true`. | `createHostMcp({ gatePost, tools: [], extensions: [curatedTool] })` where the registry-produced tool accepts `{ schema: "public" }`. |
| 2 | edge — argument validation | `curated exact invalid-argument literals return isError before handler` | Calling `catalog_probe` with `{}` returns exactly `MCP extension invalid arguments: missing required property "schema"`; `{ schema: "public", extra: true }` returns exactly `MCP extension invalid arguments: unexpected property "extra"`; `{ schema: 1 }`, `{ schema: "public", limit: "1" }`, and `{ schema: "public", verbose: "true" }` return respectively exactly `MCP extension invalid arguments: property "schema" must be string`, `MCP extension invalid arguments: property "limit" must be number`, and `MCP extension invalid arguments: property "verbose" must be boolean`; every response has `isError: true` and handler call count stays zero. | Registry-produced tool with required `schema: string`, optional `limit: number`/`verbose: boolean`, and `additionalProperties: false`. |
| 3 | edge — timeout/lifecycle | `never-settling curated handler times out and host remains usable` | A `timeoutMs: 100` handler returns exactly `MCP extension tool timed out after 100ms` with `isError: true`; a subsequent call to a normal known tool returns its normal result; `stop()` completes. | Fake timers or deterministic timer fixture; curated handler returns a never-settling promise plus one standard fake tool. |
| 4 | edge — crash/error parity | `curated crash is contained while standard host failure wording is unchanged` | A curated throw `new Error("extension boom")` returns exactly `MCP extension tool failed: extension boom` and `isError: true`; a standard `HostMcpTool` throw `new Error("standard boom")` returns exactly `Tool failed: standard boom` and `isError: true`. | One curated registry-produced tool and one existing fake host tool, each with a throwing execute. |
| 5 | regression | `existing permission, loopback, HTTP, and restart host contracts remain green` | All pre-existing `hostMcp.test.ts` assertions for standard five-tool list, allow/deny, no-secret wire scan, GET/POST, idempotent stop, restart, and `call()` behavior still pass. | Existing test fixtures unchanged except adding the new describes. |

Write the tests first and record the actual failing RED command output in the Executor Report before implementation; then make the same tests GREEN.

## Test Files

- `src/ai/omp/__tests__/hostMcp.test.ts` — existing mapped test for `src/ai/omp/hostMcp.ts`, extended with the cases above.
- `src/ai/omp/__tests__/mcpExtensionRegistry.test.ts` — mapped adjacent registry regression test produced by TASK-AIX08-001.

## Verification Commands

```bash
npm test -- src/ai/omp/__tests__/hostMcp.test.ts src/ai/omp/__tests__/mcpExtensionRegistry.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`. At Wave 2 completion, also run:

```bash
npm test
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `createHostMcp` accepts the current `CreateHostMcpOptions.tools: ReadonlyArray<HostMcpTool>` plus optional curated registry output without changing current callers that provide only standard tools.
- [ ] Admitted curated tools are discoverable only through the existing `tools/list` MCP envelope and invoke through the existing `tools/call` envelope.
- [ ] Curated invalid arguments, capability-denied results, timeouts, and handler crashes return MCP `isError: true`; their literal timeout/crash strings match Test Cases #3 and #4.
- [ ] Curated timeouts clear their timer and return without crashing/hanging the host; a late handler settlement cannot produce an unhandled rejection or new privileged operation because the registry context is structurally read-only.
- [ ] Standard `HostMcpTool` deny (`DB_TOOL_DENIED_MESSAGE`) and standard thrown-handler wording (`Tool failed: <message>`) remain unchanged.
- [ ] Loopback binding remains `127.0.0.1`; no tool descriptor/error/wire output gains a credential, adapter, connection-string, remote URL, or arbitrary filesystem authority.
- [ ] Focused tests, Wave-2 regression net, `npm run typecheck`, and `npm run compile` pass.
- [ ] Executor report declares `EXECUTOR_MODEL: unic-code`; reviewer is `unic-smart`.

## Dependencies

- TASK-AIX08-001

## Interfaces

- Consumes: Current `createHostMcp(opts: CreateHostMcpOptions): HostMcp`; `HostMcpTool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Record<string, unknown>): Promise<string> }`; and `HostMcp.handle(req: { method: string; params?: unknown; id?: unknown }): Promise<{ result?: unknown; error?: { code: number; message: string }>` from `src/ai/omp/hostMcp.ts`.
- Consumes: TASK-AIX08-001 `CuratedMcpTool`, including compatible `name`, `description`, `parameters`, and `execute(args)` fields plus `timeoutMs: number`, `timeoutError(timeoutMs: number): string`, `formatError(error: unknown): string`, and `isErrorResult(text: string): boolean` metadata.
- Produces: Extended `CreateHostMcpOptions` that can accept optional curated extension tools; the existing `HostMcp.call(name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }>` continues to normalize curated errors and standard errors without a signature change.

---

## Discussion

### 2026-09-01 · planner · unic-smart

Do not implement a second MCP transport, bridge, registry, permission system, or arbitrary cancellation mechanism. The host is responsible only for invoking the registry-produced tool under its validated time bound and mapping its explicit failure classification to MCP. The registry’s read-only context is the safety boundary after a timed-out promise cannot be forcibly preempted.

---

## Executor Report

(not started)
