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

### 2026-09-01 · executor · unic-code

Fixture-name deviation: Test Case #1 names the probe `catalog_probe` (underscore), but the binding v1 name grammar in PLAN_AIX08 §3 (`/^[a-z][a-z0-9-]{0,63}$/`, enforced with exact rejection literal N1–N3) forbids underscores, and the fixture must be registry-produced. The tests use grammar-valid `catalog-probe`; behavior under test is unchanged.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -

RED_OUTPUT:

```
npx vitest run src/ai/omp/__tests__/hostMcp.test.ts  (after adding the 4 new tests, before touching hostMcp.ts)

 ❯ src/ai/omp/__tests__/hostMcp.test.ts  (17 tests | 4 failed) 26ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL … > admitted curated tool appears in tools/list and returns MCP text content
AssertionError: expected undefined not to be undefined
 ❯ src/ai/omp/__tests__/hostMcp.test.ts:671:21
    669|     const listed = listBody.result?.tools ?? [];
    670|     const curated = listed.find((t) => t.name === "catalog-probe");
    671|     expect(curated).toBeDefined();

 FAIL … > curated exact invalid-argument literals return isError before handler
- Expected: "MCP extension invalid arguments: missing required property \"schema\""
+ Received: "Unknown tool: catalog-probe"
 ❯ src/ai/omp/__tests__/hostMcp.test.ts:730:35

 FAIL … > never-settling curated handler times out and host remains usable
- Expected: "MCP extension tool timed out after 100ms"
+ Received: "Unknown tool: catalog-probe"
 ❯ src/ai/omp/__tests__/hostMcp.test.ts:775:17

 FAIL … > curated crash is contained while standard host failure wording is unchanged
- Expected: "MCP extension tool failed: extension boom"
+ Received: "Unknown tool: catalog-probe"
 ❯ src/ai/omp/__tests__/hostMcp.test.ts:809:24

 Test Files  1 failed (1)
      Tests  4 failed | 13 passed (17)
```

All 4 failures are the genuine missing-feature failure (curated tools unknown to the host); all 13 pre-existing hostMcp assertions passed in the same RED run.

Verification Output:

```
# npm test -- src/ai/omp/__tests__/hostMcp.test.ts src/ai/omp/__tests__/mcpExtensionRegistry.test.ts
 ✓ src/ai/omp/__tests__/mcpExtensionRegistry.test.ts  (7 tests) 5ms
 ✓ src/ai/omp/__tests__/hostMcp.test.ts  (17 tests) 125ms
 Test Files  2 passed (2)
      Tests  24 passed (24)

# npm run typecheck
> tsc --noEmit
(no errors, exit 0)

# npm run compile
⚡ Done in 144ms
esbuild: build complete
(exit 0)

# Regression net: npx vitest run mcpExtensionRegistry aix03Scaffold aix04Scaffold capabilities aiChatPanelToolParity mcpBridge ompChatEngine
 Test Files  7 passed (7)
      Tests  56 passed (56)

# npm test (full suite, once)
 Test Files  214 passed | 1 skipped (215)
      Tests  2822 passed | 2 skipped (2824)
```

(The 1 skipped file / 2 skipped tests are pre-existing skips, unrelated to this task.)

Status: PASS
Note: none. Standard-tool semantics untouched (permission gate, `DB_TOOL_DENIED_MESSAGE`, `Tool failed: <msg>`, wire/lifecycle all covered by the 13 pre-existing assertions, still green). Curated lane is containment-only: `setTimeout` budget always cleared in `finally`, single-settle race promise so a late handler settlement is observed, never unhandled; curated outcomes classified via the registry's explicit `isErrorResult`/`timeoutError`/`formatError` metadata (no string-prefix guessing); a curated name colliding with a standard tool loses (fail closed). No git add/commit/push; no package.json/INDEX.md/RUN.md/STATUS.md/WORKLOG.md/CHANGELOG.md changes.


## Review — Round 1

REVIEWER_MODEL: unic-smart (configured and running)
EXECUTOR_MODEL: unic-code
VERDICT: CHANGES-REQUESTED

VERIFICATION:
- `npx vitest run src/ai/omp/__tests__/hostMcp.test.ts src/ai/omp/__tests__/mcpExtensionRegistry.test.ts` — PASS (2 files, 24 tests)
- `npm run typecheck` — PASS

FINDINGS:
- important — `src/ai/omp/__tests__/hostMcp.test.ts:645` — The curated integration suite never covers the required standard-name collision. `hostMcp.ts:241-250` is the only protection that removes a colliding curated entry; without a regression assertion, a precedence regression can route a standard-tool name through the curated path and bypass its existing permission gate. Add a standard tool and a same-name curated fixture, assert `tools/list` contains one standard descriptor, its `tools/call` invokes only the standard handler/gate, and the curated handler is never called.
- important — `src/ai/omp/__tests__/hostMcp.test.ts:753-787` — The timeout test uses a handler that never settles, so it does not exercise the acceptance requirement that a handler which settles after the timeout is observed and cannot cause an unhandled rejection or a second applied result. Add a controlled handler promise, let the 100ms timeout win, then reject (and separately resolve if practical) it after the response; assert no `unhandledRejection`, the MCP response remains the one timeout result, and a subsequent standard call still succeeds.

REQUIRED FIXES:
1. Add the standard-versus-curated name-collision regression test described above.
2. Add the late-settlement containment regression test described above, then rerun the focused tests and typecheck.

## Fix — Round 1 (orchestrator, findings applied)

FIXER_MODEL: unic-code
- `src/ai/omp/__tests__/hostMcp.test.ts` — new test `curated name colliding with a standard tool loses to the standard tool (review round 1)`: same-name standard + curated fixtures → `tools/list` shows exactly ONE descriptor with the standard tool's description; `tools/call` routes through the standard execute path (gate answered via postPermission), standard handler called exactly once, curated handler never called.
- `src/ai/omp/__tests__/hostMcp.test.ts` — new test `late-settling curated handler after timeout is observed, never unhandled, result applied once (review round 1)`: controlled handler promise, 100ms timeout wins and returns the pinned timeout literal; handler settles AFTER the response (resolve) with a sentinel that must not apply; `unhandledRejection` listener asserts zero unhandled rejections; subsequent standard call still succeeds.
- Verification: MCP focused net 27/27 (hostMcp 19 + registry 8); full regression net 41/41; typecheck + compile clean.
