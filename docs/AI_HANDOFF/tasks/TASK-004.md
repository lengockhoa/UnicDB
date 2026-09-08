# TASK-004 — omp audit: code quality, coverage gaps, error paths, performance (READ-ONLY)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1 (P0.2), §2, §4 (audit row)

## Goal

Review the seven `src/ai/omp/` modules and produce a findings report appended to THIS task file — code quality, test-coverage gaps, error paths, performance. Findings are the deliverable; they queue next cycle's work. NO production code changes.

## Target Files

- `docs/AI_HANDOFF/tasks/TASK-004.md` — the report is appended under `## Audit Report` below.
- READ-ONLY inputs: `src/ai/omp/detect.ts`, `acp.ts`, `acpProcess.ts`, `hostMcp.ts`, `mcpBridge.ts`, `ompChatEngine.ts`, `mcpExtensionRegistry.ts`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| N/A | — | audit-only task, no production code | See justification | — |

Justification: this task intentionally ships zero code, so there is no test cycle. The verifiable deliverable is the report, gated by the acceptance checklist below (report completeness + `git diff --stat src/ai/omp` empty + suite still green).

## Test Files

- (none — no code produced; existing suites must stay green untouched)

## Verification Commands

```bash
git diff --stat -- src/ai/omp   # must print NOTHING — TASK-004 is read-only against src/ai/omp
# (broader `-- src/ai src/ui` diffs are wave-unsafe: wave-mates TASK-001/013 edit tracked files there)
npx vitest run src/ai/omp/__tests__/detect.test.ts src/ai/omp/__tests__/acpProcess.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] `## Audit Report` section exists in this file with one subsection per audited module (all 7).
- [ ] ≥ 1 finding per module; every finding has: file:line, severity (`critical | important | minor`), category (`quality | coverage | error-path | performance`), and a concrete next-cycle action.
- [ ] At least 2 findings are test-coverage gaps naming the exact missing test file/case.
- [ ] At least 1 finding proposes a concrete refactor candidate (e.g. "extract shared AgentChatEngine interface from ompChatEngine") — the natural home for the duplication this cycle's mirroring creates.
- [ ] `src/ai/omp/` untouched: `git diff --stat -- src/ai/omp` prints nothing (paste proof in Executor Report). Entries under other `src/ai`/`src/ui` paths in the shared-tree diff belong to wave-mates (TASK-001/013) and are NOT this task's responsibility.

## Dependencies

- (none) — runs parallel with wave 1; findings may reference TASK-005..011 designs.

## Interfaces

- Consumes: (none — read-only)
- Produces: `## Audit Report` in this file — TASK-014 appends a follow-up note marking which findings this cycle already addressed; next cycle's planner consumes the queue.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Deliberately read-only per user P0.2 ("NO rewrite this cycle"). If you find a critical_block-severity issue, do NOT fix it — record it with severity `critical` and a next-cycle action, and flag it in your Executor Report summary.

## Audit Report

### src/ai/omp/detect.ts
- [important] [coverage] — `src/ai/omp/detect.ts:104-111` — `reason: "spawn-failed"` (the `which`/`where` path resolved but `--version` execution threw) has zero direct test coverage; `detect.test.ts` only exercises not-installed, version-too-old, and version-unknown. — next-cycle action: add `it("reason: 'spawn-failed' when binary exists but --version exits non-zero; path is preserved on the result")` in `src/ai/omp/__tests__/detect.test.ts`.
- [minor] [error-path] — `src/ai/omp/detect.ts:47` — `parseVersion` regex `/omp\/(\d+(?:\.\d+)*)/` requires the literal `omp/` token immediately; omp's stdout could legitimately include ANSI escapes, locale-formatted banner text, or a leading blank line on some shells and produce a parse miss that the caller reports as `version-unknown` even though the install is healthy. — next-cycle action: tighten the regex (strip ANSI, tolerate whitespace, accept banner shapes probed live) and add an `it("parses 'omp/18.0.1' through ANSI-color + leading newline noise")` regression test.
- [minor] [quality] — `src/ai/omp/detect.ts:73-76` — `quoteForShell` only escapes whitespace; on win32 it does not escape cmd.exe metacharacters (`& | < > ^`), which `acpProcess.ts:724 quoteForCmdExe` already calls out as a real risk. The function is currently only used for the `--version` child probe where the impact is small, but reusing the pattern for a future path-quoting helper would silently re-introduce the same bug. — next-cycle action: when extracting the shared shell-quote helper (cross-module refactor candidate below), use `quoteForCmdExe` semantics in both call sites and document the platform difference inline.
- [minor] [performance] — `src/ai/omp/detect.ts:52-56` — `defaultExecFn` uses `promisify(exec)` per call, allocating a fresh closure each invocation. The function is invoked twice per `detectOmp` (locate + version); for callers that retry, the allocation adds up negligibly but the indirect indirection through `util.promisify` and the unconsumed `stderr` makes a single shell exit on the version probe harder to diagnose (the version probe's stderr — where omp dumps its model/auth errors — is silently discarded). — next-cycle action: capture stderr from the version probe, attach it to a `reason: "spawn-failed"` rejection like `acpProcess.attachStderrTail` already does.

### src/ai/omp/acp.ts
- [minor] [error-path] — `src/ai/omp/acp.ts:362-372` — `handleLine` silently drops every malformed JSON line and every frame whose `jsonrpc` field is not `"2.0"`; if the server ever emits a frame with `id` AND `params` but no `result`/`error` (i.e., a request-looking notification), it falls through to `dispatchNotification`, which then drives an `onNotification` callback expecting `{method, params}` — but the consumer may already be treating the synthetic notification as a request because of the `id` field. — next-cycle action: add a `it("malformed frame with id but no result/error is treated as a notification, not dropped or routed to onServerRequest")` test in `src/ai/omp/__tests__/acp.test.ts`.
- [minor] [quality] — `src/ai/omp/acp.ts:306-308` — `respond()` does not check `this.disposed`; only `writeResponse` (line 444) drops silently when disposed. The asymmetry means a caller that awaits `respond()` can never tell whether the frame reached the transport, so a permission-coordinator writing a final answer after a crash will believe it succeeded even though the wire write was dropped. — next-cycle action: have `respond()` either throw or return a boolean (true = frame sent) and add a `it("respond() returns false / throws after dispose")` test.
- [minor] [coverage] — `src/ai/omp/acp.ts:213-236` — `sessionList` has tests for non-string `sessionId`, junk title, and missing `_meta`, but no test for `_meta` being non-object (e.g. `_meta: "string"` or `_meta: 42`), where the code path `metaRaw !== null && typeof metaRaw === "object"` is the only gate — a regression there would silently swallow wrong counts. — next-cycle action: add `it("sessionList treats _meta of wrong shape as no _meta (messageCount/size default to 0)")`.
- [minor] [performance] — `src/ai/omp/acp.ts:113-130` — `requestRaw`'s per-call `setTimeout` allocation runs even when the caller passes `timeoutMsOverride: 0` (the timeout branch correctly skips the `setTimeout`); however, the `Promise` constructor still allocates two closures per request. Combined with the `JSON.stringify` per call, a busy session pumps ~1KB+ of GC pressure per request. — next-cycle action: no immediate fix — flag for next-cycle profiling once session/prompt loops are wired to multi-turn benchmark.

### src/ai/omp/acpProcess.ts
- [important] [error-path] — `src/ai/omp/acpProcess.ts:608-621` — `requestCancel` during `starting` calls `reapChild()` but never transitions to `"cancelling"` (the `if (!this.readyReached) return;` early-exits before `setState("cancelling")`), so the observer sees only `starting → stopped` rather than the documented `starting → cancelling → stopped` triplet. Existing test "cancel() on a ready handle" only covers the post-ready path. — next-cycle action: add `it("cancel() during starting emits [starting, cancelling, stopped]")` to `src/ai/omp/__tests__/acpProcess.test.ts` and either fire `setState('cancelling')` before the early return OR document the asymmetry as deliberate.
- [important] [error-path] — `src/ai/omp/acpProcess.ts:680-697` — the legacy `disposeClient()` helper still exists, sends SIGTERM with no escalation timer, and is reachable from the `start()` catch block (line 422). If the start() catch fires after the handshake (e.g. unexpected `session/new` shape), the child gets SIGTERM and is never SIGKILL'd — a stuck child could pin the host. — next-cycle action: route the `start()` catch through the bounded `dispose()` instead of `disposeClient()` and add `it("mid-handshake crash still bounds teardown via OMP_ACP_DISPOSE_TIMEOUT_MS")`.
- [minor] [quality] — `src/ai/omp/acpProcess.ts:463-466` — `setOnStateChange(cb)` is documented as a "cancellable construction seam" but a later `start({ onStateChange })` SHOULD clobber it per the comment at line 211-217 — the documentation is internally inconsistent (says "idempotent rebind by design" but the early-return on `handlers.onStateChange !== undefined` replaces whatever `setOnStateChange` set). The two paths are NOT equivalent and the seam is the only reason TASK-AIX05-103 has to exist. — next-cycle action: unify on a single registration path (drop the `start()` handler override, force callers to use `setOnStateChange`) and document the contract as "set once before start()".
- [minor] [error-path] — `src/ai/omp/acpProcess.ts:264-280` — the `ChildLike.on(ev, cb)` adapter invokes the `cb` with positional `...a` casts, but `child.on('error', ...)` in real Node emits `(err: Error)`, `child.on('exit', ...)` emits `(code, signal)` — the adapter swallows the `signal` argument entirely; if omp exits via SIGTERM the spawn's stderr is suppressed and downstream callers can't distinguish a kill-initiated exit from a child crash. — next-cycle action: surface `signal` as a second argument on the `ChildLike.on('exit')` contract or thread it through `handleChildExit(code, signal)`.
- [minor] [performance] — `src/ai/omp/acpProcess.ts:288-294` — `stderrTail` is captured by a closure per `start()` invocation. If a single `AcpProcess` is reused across multiple sessions (the `ompChatEngine` shutdown path closes the bridge, but a re-`start()` flow keeps the instance), the tail persists and grows across sessions — capping at 8KB is fine, but the consumer (`getStderrTail`) reads a tail that mixes session-A and session-B stderr, which is misleading on a session-B error. — next-cycle action: reset `stderrTail` at the start of every `start()` call.

### src/ai/omp/hostMcp.ts
- [critical] [error-path] — `src/ai/omp/hostMcp.ts:287-356` — the standard (non-curated) tool path inside `tools/call` has NO execution timeout. `containedExecute` (line 206-228) bounds curated tools, but the standard `tool.execute(args)` call (line 334) is unbounded. A standard tool that hangs (e.g. a slow DB query that didn't go through `runReadOnlyQuery`'s timeout, or a custom tool registered by the panel) pins the host's HTTP listener and every subsequent request until the underlying Promise settles. `hostMcp.test.ts` only verifies curated containment — there is no test for the standard-tool timeout path. — next-cycle action: add a per-call timer around `tool.execute(args)` (use the tool's declared timeout if present, fall back to a host-side default), reject with `{isError: true, text: "Tool timed out after <ms>ms"}`, and add `it("standard tool that never settles is bounded by the configured timeout; response isError:true")` in `src/ai/omp/__tests__/hostMcp.test.ts`.
- [minor] [error-path] — `src/ai/omp/hostMcp.ts:513-515` — the `url` getter returns `http://127.0.0.1:${port}` with `port = 0` before `start()` resolves; if a caller captures the engine before start, the descriptor points at port 0 and omp will fail the MCP handshake with a transport error rather than a clear "host not started yet" message. — next-cycle action: have the getter return `undefined` (or throw) when `port === 0` and update the call site in `ompChatEngine.mcpServersDescriptor` accordingly.
- [minor] [error-path] — `src/ai/omp/hostMcp.ts:104-111` — `summarizeArgs` joins every key=value pair into a single line without quoting strings, so a tool arg like `{ sql: "SELECT 'a\nb'" }` produces a permission card with a literal newline in the middle of the `detail` field — the webview card may render it as a card-bleed or be truncated by the panel's card renderer. — next-cycle action: escape `\n`/`\r` in stringified values before joining.
- [minor] [coverage] — `src/ai/omp/hostMcp.ts:386-407` — the HTTP listener only tests POST and GET. The `hostMcp.test.ts` keepalive test covers GET (line 373), but DELETE/PUT/PATCH/OPTIONS are all rejected with 405 + JSON-RPC error — there is no test that the `OPTIONS` response includes the proper CORS preflight headers (omp's MCP client may need them on cross-origin setups even though we're on 127.0.0.1). — next-cycle action: either add an `it("OPTIONS returns 405 + JSON-RPC error envelope")` test OR, if CORS preflight is needed, add a proper CORS middleware path with a test.

### src/ai/omp/mcpBridge.ts
- [important] [error-path] — `src/ai/omp/mcpBridge.ts:201-214` — `createMcpBridge` overload resolution uses `typeof (registryOrHostMcp as Partial<HostMcp>).handle === "function"` as the duck-type gate; a `ToolRegistry` that happens to expose a `handle` property (e.g. an `AgentTool` whose params are called `handle`) would silently route through the wrong handler and bypass `registry.list()`/`registry.get(name)` paths entirely. The current tests assume the duck-type is safe, but no negative test guards the contract. — next-cycle action: add `it("createMcpBridge(toolRegistry-with-handle-prop) still routes through makeHandler, not makeHostMcpHandler")` in `src/ai/omp/__tests__/mcpBridge.test.ts`.
- [minor] [error-path] — `src/ai/omp/mcpBridge.ts:184-189` — `extractBearerToken` accepts the first header value verbatim when `Authorization` is an array, but the HTTP spec allows multi-value `Authorization` headers (RFC 7235 §3.2.2) — omp's MCP client may legitimately send `Authorization: Bearer <a>, Bearer <b>` for token rotation, and we'd silently drop `<b>`. — next-cycle action: join all `Authorization` header values and try each candidate in turn; document the rationale.
- [minor] [coverage] — `src/ai/omp/mcpBridge.ts:226-288` — there is no test for the GET (keepalive) path on the bridge's HTTP listener. `mcpBridge.test.ts` exercises POST and dispose, but a GET request from omp's MCP client (the keepalive probe from `hostMcp.ts:388-396` has the same shape) would currently fall through to the 405 handler. — next-cycle action: add an `it("GET / returns 200 with mcp-session-id header")` test for symmetry with `hostMcp.test.ts`.
- [minor] [performance] — `src/ai/omp/mcpBridge.ts:298` — `server.unref()` is called unconditionally after bind; if the test fixture inspects the server's internal state synchronously after bind (some tests `await` and then immediately call `server.address()`), `unref()` works fine, but the production path can't `unref()` a server with active sockets — the `closeAllConnections()` path on dispose handles the final cleanup. This is documented, but the unconditional `unref()` after bind can race with `accept()` callbacks. — next-cycle action: defer `unref()` to a microtask after `listen` callback returns to avoid the documented race.

### src/ai/omp/ompChatEngine.ts
- [important] [refactor] — `src/ai/omp/ompChatEngine.ts:88-102` + `src/ai/omp/hostMcp.ts:64-89` — the `HostMcp` interface is DUPLICATED in both files with the engine copy being a structural subset. The new `claudeCode/` and `codex/` mirror directories already exist (`src/ai/claudeCode/`, `src/ai/codex/`, both with `detect.ts`); when `claudeCodeChatEngine.ts` and `codexChatEngine.ts` land they will each import a separate `HostMcp` (or duplicate a third copy). — next-cycle action: extract a single `AgentChatEngine` interface from `ompChatEngine.ts:119-137` into `src/ai/agentChatEngine.ts`, hoist the shared `HostMcp` / `AcpSession` / `McpServerDescriptor` types to the same file, and have `ompChatEngine`, `claudeCodeChatEngine`, `codexChatEngine` all implement / consume the shared surface (this is the natural home for the duplication this cycle's mirroring creates).
- [important] [error-path] — `src/ai/omp/ompChatEngine.ts:253-334` — `dispatchNotification` is `async` and called as `void dispatchNotification(...)` (line 417), so any rejection escapes as an unhandled rejection. The body has a try/catch around `hostMcp.call(name, args)` only; the surrounding `emit(...)`, `events.onDelta?.(text)`, etc. are NOT guarded. If a panel-supplied `onDelta` throws (e.g. the panel disposed mid-stream), the whole turn dies. — next-cycle action: wrap the whole `dispatchNotification` body in an outer try/catch that emits `error` and continues, then add `it("onDelta throwing mid-turn does not kill the dispatcher; subsequent frames still stream")` to `src/ai/omp/__tests__/ompChatEngine.test.ts`.
- [minor] [error-path] — `src/ai/omp/ompChatEngine.ts:312-328` — the `tool_call_update` branch fires `onToolEnd` with `result` and `isError === update.isError === true`, but the `tool_call` branch (lines 293-310) fires `onToolEnd` with `isError === out.isError` from `hostMcp.call()` — these two paths may produce DIFFERENT `isError` values for the same logical tool call (e.g. omp reports success at the protocol layer but the tool itself threw). The panel ends up showing two tool cards or a contradictory final state. — next-cycle action: reconcile via a per-toolCallId ledger (track the original `tool_call` and apply the `tool_call_update` as a final override keyed by `toolCallId`); add a regression test pinning the final `isError` to whichever update arrives LAST.
- [minor] [quality] — `src/ai/omp/ompChatEngine.ts:187-198` — `mcpServersDescriptor` rebuilds the `{type: "http", name: "UnicDB", url, headers: []}` descriptor locally, duplicating the shape from `mcpBridge.ts:304-309` (which DOES include the bearer header). The engine's copy drops the bearer header by design ("legacy default"), but the dual-source-of-truth makes it easy for a future caller to send the wrong descriptor to omp. — next-cycle action: replace `mcpServersDescriptor` with `mcpBridge.createMcpDescriptor(hostMcp.url, hostMcp.sessionId, bearerToken)` once the bearer is threaded through `hostMcp`.

### src/ai/omp/mcpExtensionRegistry.ts
- [minor] [coverage] — `src/ai/omp/mcpExtensionRegistry.ts:570-572` — `list()` returns `[...tools]` (a fresh copy per call), but there is NO test that the copy is structurally independent of the internal `tools` array (e.g. caller mutating the returned array does not affect subsequent `list()` calls, and a caller can't push into the internal array). — next-cycle action: add `it("list() returns an independent copy: mutating the result does not affect the next list() call")` in `src/ai/omp/__tests__/mcpExtensionRegistry.test.ts`.
- [minor] [error-path] — `src/ai/omp/mcpExtensionRegistry.ts:518-562` — `execute(args)` always creates a new `createSqlTool(async () => adapter)` per call (line 550), even though `adapter` is captured by closure and never changes. Re-allocating the SQL tool per call is fine for cold paths, but a hot registry (one extension called dozens of times per turn) re-parses the same `isReadOnlySql` grammar each time. — next-cycle action: hoist `createSqlTool` to the per-tool factory closure and reuse the same instance across calls.
- [minor] [quality] — `src/ai/omp/mcpExtensionRegistry.ts:221-231` — `isErrorResult` uses `text.startsWith(prefix)` over a fixed 5-element array. The literals are pinned (PLAN_AIX08 §3a/3b/3c), but adding a 6th curated error category in the future means updating three places (the prefix array, the literal in `register`, and the documentation). — next-cycle action: replace `isErrorResult` with a sentinel marker on the error type (e.g. `kind: "curated-error"`) so adding a category is a single edit.
- [minor] [error-path] — `src/ai/omp/mcpExtensionRegistry.ts:483-485` — `register` rejects a duplicate name with the exact literal `duplicate tool name "<name>"`, but the inner quote/escape handling for `<name>` containing a literal `"` character is naive (`${DUPLICATE_LITERAL_PREFIX}${candidate.name}"` — the closing quote is appended unconditionally even if `candidate.name` itself ends in `"`). — next-cycle action: validate `name` against `/^[a-z][a-z0-9-]{0,63}$/` (already enforced at line 375) so the embedded `"` cannot occur; document the invariant.

### Cross-module refactor candidate
- [important] [refactor] — `src/ai/omp/ompChatEngine.ts:88-102` (HostMcp subset) + `src/ai/omp/ompChatEngine.ts:187-198` (mcpServersDescriptor) + `src/ai/omp/mcpBridge.ts:304-309` (descriptor shape) + the mirrored `src/ai/claudeCode/` + `src/ai/codex/` directories — the new claudeCode/codex mirrors surface the duplication that an `AgentChatEngine` boundary would eliminate. The natural home is `src/ai/agentChatEngine.ts` exporting: `AgentChatEngine` (the `OmpChatEngine` shape extracted from `ompChatEngine.ts:119-137`), `AgentAcpSession` (the `AcpSession` shape at `ompChatEngine.ts:42-79`), `AgentHostMcp` (a shared `HostMcp` superset combining `ompChatEngine.ts:88-102` and `hostMcp.ts:64-89`), and `McpServerDescriptor` (a typed literal of the shape `mcpBridge.ts:304-309` produces). — next-cycle action: extract the shared types into `src/ai/agentChatEngine.ts`, have `ompChatEngine` import them, and seed `claudeCode/` and `codex/` mirrors with the imports so future engines land on the same surface; the descriptor-bearing `mcpServers` field then becomes a uniform `ReadonlyArray<McpServerDescriptor>` everywhere.

---

## Executor Report
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5-20250929
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: N/A (read-only audit task)
ReadOnlyProof:
```
(empty — `git diff --stat -- src/ai/omp` printed nothing)
```
SuiteGreenProof:
```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB
 ✓ src/ai/omp/__tests__/detect.test.ts  (14 tests) 3ms
 ✓ src/ai/omp/__tests__/acpProcess.test.ts  (27 tests) 2044ms

 Test Files  2 passed (2)
      Tests  41 passed (41)
   Duration  2.27s
```
TypecheckProof:
```
> UnicDB@1.53.23 typecheck
> tsc --noEmit
(no output — clean)
```
FindingsCount: 30 total (1 critical, 7 important, 22 minor)
Status: PASS
Note: Coverage gaps include `reason: "spawn-failed"` in `detect.ts`, unbounded standard-tool execution in `hostMcp.ts` (critical), and missing `AgentChatEngine` extraction for the new claudeCode/codex mirrors. No production code touched; `src/ai/omp/` is byte-identical to HEAD.

---

## Follow-up disposition (TASK-014 — 2026-09-07)

Per the cycle's P0.2 "no rewrite this cycle" constraint, the audit findings
in TASK-004 are NOT addressed by AGT source edits. This subsection records
which findings this cycle **guards** with new tests / new wiring vs which
remain **queued** for the next dedicated cycle. No omp source was rewritten.

### Already guarded by this cycle (AGT) — covered by new code/tests:

| Finding | Where guarded |
|---|---|
| `HostMcp` interface duplication (important) — `ompChatEngine.ts:88-102` ↔ `hostMcp.ts:64-89` | `src/ai/claudeCode/claudeCodeChatEngine.ts` + `src/ai/codex/codexChatEngine.ts` each declare a minimal `HostMcp` / `CodexHostMcp` subset. The shape is consistent across all three engines; full extraction into `src/ai/agentChatEngine.ts` is deferred (see queued). |
| `mcpServersDescriptor` dual-source-of-truth (minor) — `ompChatEngine.ts:187-198` vs `mcpBridge.ts:304-309` | `extension.ts` (TASK-012) wires `buildClaudeCodeChatEngine` / `buildCodexChatEngine` reusing `createHostMcp` / `createMcpBridge` from `src/ai/omp/`; the Claude factory writes an ephemeral `{type:"http", url:"http://127.0.0.1:<port>"}` MCP config file (no apiKey/credentials). The dual source remains but is now exercised end-to-end by `agentEnginesIntegration.test.ts #1`. |
| `OMP_INSTALL_HINT` / `OMP_UPDATE_HINT` mapping (minor in detect) — reason → install/update hint | `src/__tests__/agentEnginesIntegration.test.ts #3` pins `resolveEngine` to emit the correct hint per `reason` for all three non-builtin engines (claude-code / codex / omp), so the hint flow is exercised at the integration layer even though the detect-layer regex tightening remains queued. |
| Vision capability distinction (covered indirectly) — omp rejects, claude/codex accept, builtin follows flag | `agentEnginesIntegration.test.ts #4` pins `vision_unsupported` for `engine=omp`, accepted `{mime,base64}` for `engine=claude-code` and `engine=codex`, and confirms `defaultAiSettings().models.work.vision` governs builtin. |

### Intentionally queued for next cycle (no AGT guard):

| Finding | Severity | Reason deferred |
|---|---|---|
| Standard-tool execution timeout in `hostMcp.ts:287-356` (the `tool.execute(args)` path) | **critical** | Out of AGT scope — touches the existing omp hostMcp surface; cycle's P0.2 forbids omp rewrite. Next cycle must add a per-call timer + test `it("standard tool that never settles is bounded by the configured timeout; response isError:true")` per the audit's next-cycle action. |
| `reason: "spawn-failed"` coverage gap in `detect.ts:104-111` | important | Out of AGT scope; queued per audit's next-cycle action. |
| `acpProcess.ts:608-621` — `requestCancel` during `starting` does not emit `cancelling` state | important | Out of AGT scope (raw omp process handling). |
| `acpProcess.ts:680-697` — legacy `disposeClient()` reachable from `start()` catch with no SIGKILL escalation | important | Out of AGT scope. |
| `mcpBridge.ts:201-214` — `createMcpBridge` duck-type gate could route wrong on `handle` prop | important | Out of AGT scope (bridge overload). |
| `ompChatEngine.ts:253-334` — `dispatchNotification` unhandled rejection path | important | Out of AGT scope. |
| `ompChatEngine.ts:88-102` ↔ `hostMcp.ts:64-89` — full `AgentChatEngine` extraction into `src/ai/agentChatEngine.ts` | important (refactor) | Acknowledged in cycle notes; AGT mirrored the shape but did not extract the shared interface (P0.2 "no rewrite"). Recommended as a leading item for the next dedicated refactor cycle. |
| All 22 minor findings | minor | Out of AGT scope; carry forward unchanged. |

### Net result

AGT deliberately leaves all TASK-004 findings queued. The cycle adds no new
risk to the omp surface — every new engine routes through the same
`createHostMcp` / `createMcpBridge` seams and inherits the same gaps the audit
already recorded. The `agentEnginesIntegration.test.ts` matrix proves the
end-to-end wiring works against the existing surface, which means a future
fix to any single omp finding (notably the critical `hostMcp.ts` timeout gap)
will benefit all four engines simultaneously.



## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart (matches handoff.reviewer.model in .ukit/storage/config.json)
EXECUTOR_MODEL: claude-sonnet-4-5-20250929
VERIFICATION_RERUN:
  command: npx vitest run src/ai/omp src/ai/__tests__/policy.test.ts src/ai/__tests__/engineChoice.test.ts ; npm run typecheck ; git diff --stat -- src/ai/omp
  result: 156 pass / 0 fail / 2 skipped (live smokes); typecheck clean; omp diff empty (read-only contract holds)
TEST_PLAN_COVERAGE: all-followed — read-only audit per contract; RED_OUTPUT N/A is pre-justified in §Test Cases; acceptance checklist re-verified (7 module subsections, file:line+severity+category+action on every finding, >=2 named coverage gaps, >=1 refactor candidate, zero-diff proof pasted)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - docs/AI_HANDOFF/tasks/TASK-004.md:95 — the mcpBridge.ts:298 "unref() can race with accept() callbacks" rationale is technically wrong (unref only clears the event-loop ref; it cannot race accept). Reword or drop this queued item so the next planner does not chase a phantom race.
    - docs/AI_HANDOFF/tasks/TASK-004.md:161-172 — queued findings (incl. the critical hostMcp.ts:287-356 standard-tool timeout) have no INDEX/plan row of their own; the next cycle's planner must consume TASK-004 before cycle AGT closes or the critical finding is orphaned.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: All 30 citations land in-range; the critical + all 7 important findings spot-verified true against source (standard tool.execute unbounded vs bounded containedExecute; requestCancel early-return skips "cancelling"; disposeClient SIGTERM-only from start() catch; duplicated HostMcp; duck-type gate; spawn-failed untested). Counts consistent (1c/7i/22m). Disposition guard files exist and agentEnginesIntegration.test.ts passes 28/28.
