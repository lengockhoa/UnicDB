# TASK-012 — DB tools on the omp path: probe the ACP tool transport, then bridge the existing registry

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.8 (B11) — §7 Global Constraints applies by reference

## Goal

Fix B11: **in the default engine the assistant has zero database access**, which is the whole
point of the feature. `session/new` passes `mcpServers: []` (`acpProcess.ts:165`) and no tool
definitions are ever sent. Meanwhile `src/ai/tools/` holds working, tested tools —
`list_tables`, `describe_table`, `export_structure`, `run_sql` (read-only guard at
`sqlTool.ts:99`) — wired only into the builtin loop (`aiChatPanel.ts:441-443` →
`agent.ts:264-269`). `src/ai/omp/hostTools.ts` is dead code targeting a `set_host_tools` RPC that
no longer exists.

Expose the existing `DbToolRegistry` to omp through ACP's `mcpServers` extension point, in-process,
so credentials never leave the extension host and `isReadOnlySql` stays the single chokepoint.

**Step 1 is a live probe, not code.** See Discussion for the stop rule.

## Target Files

- `docs/AI_HANDOFF/queue/ACP-TOOLS-research.md` (new — probe evidence)
- `src/ai/omp/mcpBridge.ts` (new)
- `src/ai/omp/hostTools.ts` (rewrite onto the surviving transport, or delete if fully superseded)
- `src/ai/omp/acpProcess.ts` (pass `mcpServers` through to `session/new`, `acpProcess.ts:165`)
- `src/ai/omp/acp.ts` (**`session/load` hardcodes `mcpServers: []` at `acp.ts:216`** — a resumed
  session would silently lose its tools if only `acpProcess.ts` were fixed; thread the same array
  through `loadSession`)
- `src/ui/aiChatPanel.ts` (construct the bridge from the existing registry; dispose it with the session)
- `src/ai/omp/__tests__/mcpBridge.test.ts` (new)
- `src/ai/omp/__tests__/hostTools.test.ts` (rewrite or delete alongside the module)
- `src/ai/omp/__tests__/acpProcess.test.ts` (extend — `session/new` `mcpServers` payload)
- `src/ai/omp/__tests__/acp.test.ts` (extend — `session/load` `mcpServers` payload)

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | `tools/list` | returns exactly the 4 registry tools with names `list_tables`, `describe_table`, `export_structure`, `run_sql` and their `parameters` passed through unchanged |
| Happy | `tools/call list_tables` | invokes the registry tool and returns its string result in the MCP result envelope |
| Edge (auth) | request with a wrong/absent bearer token | rejected (401-equivalent); the registry tool is **not** invoked |
| Edge (guard) | `tools/call run_sql {sql:"DELETE FROM t"}` | refused by `isReadOnlySql`; no adapter call; refusal text returned as a tool result, not a crash |
| Edge (malformed) | `tools/call` with non-object args | `"Invalid tool arguments"` (same wording as the builtin loop, `hostTools.ts:56`) |
| Edge (unknown tool) | `tools/call nope` | `"Unknown tool: nope"`, no throw |
| Edge (lifecycle) | session disposed | listener closed, port released; a subsequent request fails to connect (no orphan server) |
| Edge (no connection) | `adapterFactory()` returns `null` | tool returns a readable "no active connection" string; no unhandled rejection |
| Edge (resume) | `loadSession()` on a saved session | the `session/load` params carry the **same** descriptor array as `session/new` — a resumed chat keeps its tools |
| R (B11a) | `session/new` params | today `mcpServers: []` (`acpProcess.ts:165`); after fix exactly one descriptor |
| R (B11b) | `session/load` params | today `mcpServers: []` (`acp.ts:216`) even when the bridge exists; after fix the descriptor is present |

## Test Files

- `src/ai/omp/__tests__/mcpBridge.test.ts` (new — `handleMcpRequest` matrix + auth + lifecycle; no real omp needed)
- `src/ai/omp/__tests__/acpProcess.test.ts` (extend — `mcpServers` in `session/new`)
- `src/ai/omp/__tests__/acp.test.ts` (extend — `mcpServers` in `session/load`)
- `src/ai/omp/__tests__/hostTools.test.ts` (rewrite to the surviving transport, or delete with the module)

## Verification Commands

```bash
npm run typecheck
npm test -- src/ai/omp/__tests__/mcpBridge.test.ts
npm test -- src/ai/omp/__tests__/acpProcess.test.ts
npm test -- src/ai/omp/__tests__/acp.test.ts
npm test -- src/ai/omp/__tests__/hostTools.test.ts
npm test -- src/ai/tools/__tests__
npm test -- src/ui/__tests__/aiChatPanelAcp.test.ts
```

Manual, with a real `omp` on PATH (records the probe evidence — not part of the automated gate):

```bash
omp --version
node -e "/* probe: spawn 'omp acp', initialize -> initialized -> session/new with a populated mcpServers entry, print the response */"
```

## Acceptance Criteria

- [ ] `docs/AI_HANDOFF/queue/ACP-TOOLS-research.md` exists and records, with raw request/response
      frames: the omp version probed, both descriptor shapes tried, and for each — whether an
      **inbound `tools/list` / `tools/call` frame was observed** (the acceptance bar; a
      non-erroring `session/new` with no inbound traffic counts as NOT accepted), plus the exact
      rejection error or the timeout duration.
- [ ] All 11 test cases pass; the B11 regressions assert on the actual `session/new` **and**
      `session/load` params, not on a comment.
- [ ] The MCP listener binds `127.0.0.1` only, requires a per-session random token, and is torn
      down with the ACP session (asserted by the lifecycle case).
- [ ] No credential, password, connection string or API key appears in the spawn argv, the
      `mcpServers` descriptor, or any log line (§7).
- [ ] `run_sql` still routes through `isReadOnlySql` — the bridge adds **no** second execution
      path to the database.
- [ ] Tool error wording matches the builtin loop exactly (`Unknown tool: <name>`,
      `Invalid tool arguments`, `Tool failed: <msg>`) so the two engines behave identically.
- [ ] **Unconditional (lands even if the probe blocks the bridge):** `src/ai/omp/hostTools.ts` is
      either rewritten onto the surviving transport or deleted — no dead module referencing
      `set_host_tools` is left behind, and `npm run typecheck` is clean after the removal.
- [ ] `session/load` carries the same `mcpServers` array as `session/new` — a resumed session does
      not silently lose its tools.
- [ ] No new runtime dependency (Node built-ins only).
- [ ] End-to-end, manually: ask the chat "what tables are in this database?" with omp as the
      engine and get a real answer sourced from a tool call. Paste the transcript into the report.
- [ ] `npm run typecheck` clean.

## Dependencies

- TASK-006 (owns `acpProcess.ts` in wave 1; handshake + timeout must be correct first)
- TASK-007 (the turn must settle before tool calls can be observed at all)
- TASK-011 (owns `aiChatPanel.ts` in wave 2; omp must actually be the selected engine)

## Interfaces

- Consumes:

```ts
// existing — src/ai/agent.ts:16
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}
export interface ToolRegistry { list(): AgentTool[]; get(name: string): AgentTool | undefined; }

// existing — src/ai/tools/registry.ts:33
export function createDbTools(adapterFactory: AdapterFactory): DbToolRegistry;
// existing — src/ai/tools/types.ts:12
export type AdapterFactory = () => Promise<DbAdapter | null>;
// existing — src/ai/tools/sqlTool.ts:99
export function isReadOnlySql(sql: string): ReadOnlyCheck;

// TASK-006 — src/ai/omp/acpProcess.ts
export interface AcpProcessOptions { ompPath?: string; cwd: string; supportCwdFlag: boolean; execFn?: AcpExecFn; requestTimeoutMs?: number; }
```

- Produces:

```ts
// src/ai/omp/mcpBridge.ts (new) — NO vscode import
export interface McpBridge {
  /** Descriptor passed inside session/new's `mcpServers` array. Exact shape is
   *  fixed by the probe and MUST match the accepted form recorded in
   *  ACP-TOOLS-research.md — do not guess. */
  descriptor: Record<string, unknown>;
  /** Pure request handler — unit-tested without omp and without a socket. */
  handleMcpRequest(req: { method: string; params?: unknown; id?: unknown }, token: string):
    Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  dispose(): void;
}
export function createMcpBridge(registry: ToolRegistry): Promise<McpBridge>;

// src/ai/omp/acpProcess.ts — options gain:
mcpServers?: ReadonlyArray<Record<string, unknown>>;   // default [] (today's behavior)

// src/ai/omp/acp.ts — loadSession stops hardcoding `mcpServers: []` (acp.ts:216) and
// forwards the same array; absent ⇒ [] ⇒ byte-identical to today.
```

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

**Stated unknown — read this before writing code.** Whether omp 18 accepts an HTTP-transport MCP
entry, a stdio one, or neither was **not** probed. The only verified fact is that `mcpServers`
must be an array (`docs/AI_HANDOFF/queue/ACP-SESSION-research.md:7,30`); every probe so far passed
`[]`. `src/ai/omp/hostTools.ts` targets a `set_host_tools` RPC that no longer exists, so there is
no working precedent in this repo to copy.

**What counts as "accepted" — the bar is an observed inbound request, not a silent 200.** omp
returning a non-erroring `session/new` proves only that it did not reject the JSON; it does *not*
prove it will ever talk to the server. **Accepted := at least one inbound `tools/list` OR
`tools/call` frame arriving at the bridge from omp**, with the raw frame pasted into
`ACP-TOOLS-research.md`. A clean `session/new` with no inbound request within the probe timeout is
**not** acceptance — it falls to branch 3 below.

**Probe budget — bounded, so a stalled unknown cannot eat the wave.** At most **two** descriptor
shapes (HTTP first, then stdio), **one** session each, **60 s** wait per session for an inbound
frame, using a prompt that forces a tool ("list the tables in this database"). If both shapes are
exhausted, stop — do not iterate on descriptor variants hoping one sticks.

**Stop rule — do not invent a protocol.** Run the probe first and record the frames. Then:

1. HTTP descriptor accepted (inbound frame observed) ⇒ implement the in-process `127.0.0.1` +
   bearer-token server. Preferred: registry, adapter and credentials all stay in the extension host.
2. HTTP not accepted but stdio accepted (inbound frame observed) ⇒ implement stdio. The child must
   receive its token via env, never argv, and must reach the database **through the extension
   host**, not by re-connecting with its own credentials.
3. Neither shape produced an inbound frame (including the "no error, no traffic" case) ⇒ finish the
   unconditional cleanup below, then **set this task's Status to `needs_breakdown`**, paste the
   frames (or the silence, with timings) into `ACP-TOOLS-research.md` and into this Discussion, and
   stop. A fabricated transport that silently no-ops is worse than an honestly blocked task: it
   would ship a chat that looks wired up and answers from imagination.

**Unconditional, regardless of branch:** `src/ai/omp/hostTools.ts` and its test are dead code
targeting an RPC that no longer exists. Delete (or rewrite) them and land that change **even if
the probe blocks the bridge** — otherwise the cleanup is stranded behind an unknown and the next
reader re-discovers the same dead module.

**Fallback already covered:** TASK-007 restores real schema context to the ACP prompt, so even if
this task is blocked the omp chat knows the schema — it just cannot query. Losing tools is a
degraded feature, not a dead one, which is why this task sits last and alone in wave 3.

**Security is the reason this is not a thin wrapper.** The bridge must not become a second path to
the database that bypasses `isReadOnlySql`. Route every tool call through the existing registry
objects — do not re-implement `run_sql`.

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-5
EXECUTOR_SUBAGENT: -
SUMMARY: Stage 1 probe (recorded in `docs/AI_HANDOFF/queue/ACP-TOOLS-research.md`) proved omp
18.0.1 accepts an ACP `McpServer` HTTP descriptor and calls `tools/list`/`tools/call` on it
synchronously during `session/new` — branch 1 of the Discussion's stop rule (HTTP accepted).
Implemented `src/ai/omp/mcpBridge.ts`, an in-process `127.0.0.1`-only MCP Streamable-HTTP
listener with a per-bridge random bearer token, exposing the existing `ToolRegistry`
(`list_tables`, `describe_table`, `export_structure`, `run_sql`) to omp without adding any second
path to the database. Fixed both hardcoded `mcpServers: []` sites (`acpProcess.ts`'s
`session/new` and `acp.ts`'s `sessionLoad`) to forward the descriptor array, defaulting to `[]`
for backward compatibility. Wired `aiChatPanel.ts::ensureAcpSession()` to build the bridge from
the same registry the builtin engine uses and dispose it with the session; threaded the same
`mcpServers` array through `session/load` on resume. Deleted the dead `hostTools.ts` (targeted a
`set_host_tools` RPC that no longer exists) and its test, unconditionally per Acceptance Criteria.
Fixed a pre-existing test-helper timing bug uncovered by this change: `http.Server.listen()`'s
callback is a macrotask, so `aiChatPanelAcp.test.ts`/`aiChatE2e.test.ts`/`aiChatPanelResume.test.ts`
helpers (`until`/`flush`) needed a `setImmediate`-based wait (captured before any
`vi.useFakeTimers()` call) instead of pure-microtask polling, or they silently exhausted their
iteration budget against the now-real listener.
TEST_PLAN_FOLLOWED: task §Test Cases (11 rows) — all 11 implemented as described.
FILES_CHANGED:
  - src/ai/omp/mcpBridge.ts: new — in-process MCP HTTP bridge (`createMcpBridge`, pure
    `handleMcpRequest`, bearer-token auth, `127.0.0.1`-only listener)
  - src/ai/omp/acpProcess.ts: `AcpProcessOptions.mcpServers` (default `[]`) forwarded verbatim
    into `session/new`'s `mcpServers` param (previously hardcoded `[]`)
  - src/ai/omp/acp.ts: `sessionLoad(sessionId, cwd, mcpServers = [])` forwards `mcpServers` into
    `session/load`'s params (previously hardcoded `[]`)
  - src/ui/aiChatPanel.ts: `ensureAcpSession()` builds the bridge from the real
    `createDbTools`+`run_sql`+`export_structure` registry, passes its descriptor into
    `acp.start()`, disposes the bridge with the session; `handleResumePick()` forwards the same
    `mcpServers` array into `sessionLoad()`
  - src/extension.ts: `buildAcpDeps()`'s `start()` accepts and forwards `mcpServers`
  - src/ai/omp/hostTools.ts: deleted (dead code, no `set_host_tools` RPC exists)
  - src/ai/omp/__tests__/hostTools.test.ts: deleted alongside the module
  - src/ai/omp/__tests__/mcpBridge.test.ts: new — 10 tests (tools/list, tools/call happy +
    auth/guard/malformed/unknown-tool/lifecycle/no-connection edges)
  - src/ai/omp/__tests__/acpProcess.test.ts: removed 3 `hostTools:`-prefixed tests (module gone),
    added 2 tests asserting `session/new`'s `mcpServers` param (populated + default-`[]`)
  - src/ai/omp/__tests__/acp.test.ts: added 1 test asserting `sessionLoad`'s `mcpServers` param
  - src/ui/__tests__/aiChatPanelAcp.test.ts: `until`/`flush` switched to a `setImmediate`-based
    wait (real listener now sits behind `ensureAcpSession()`)
  - src/ui/__tests__/aiChatE2e.test.ts: same `until` timing fix
  - src/ui/__tests__/aiChatPanelResume.test.ts: same `until`/`flush` timing fix
  - docs/AI_HANDOFF/queue/ACP-TOOLS-research.md: new — Stage 1 live-probe evidence (raw
    initialize/session-new/tools-list/tools-call frames against real omp 18.0.1)
TESTS_ADDED:
  - src/ai/omp/__tests__/mcpBridge.test.ts: 10 tests — tools/list happy, tools/call happy, wrong
    token rejected (tool not invoked), run_sql DELETE refused by isReadOnlySql, malformed args,
    unknown tool, dispose()/lifecycle (port released), null adapter ("no active connection"),
    plus auth/shape edges
  - src/ai/omp/__tests__/acpProcess.test.ts: "session/new forwards a non-empty mcpServers array
    verbatim…" and "…still defaults to mcpServers: [] when omitted (no regression)"
  - src/ai/omp/__tests__/acp.test.ts: "sessionLoad forwards a non-empty mcpServers array verbatim
    as the 3rd request param"
VERIFICATION:
  command: npm run typecheck
  result: clean, exit 0
  output_excerpt: |
    > vsdb@1.6.3 typecheck
    > tsc --noEmit
    (no errors)

  command: npm test -- src/ai/omp/__tests__/mcpBridge.test.ts
  result: 10 passed
  output_excerpt: |
    ✓ src/ai/omp/__tests__/mcpBridge.test.ts  (10 tests) 10ms
    Test Files  1 passed (1)
    Tests  10 passed (10)

  command: npm test -- src/ai/omp/__tests__/acpProcess.test.ts
  result: 17 passed
  output_excerpt: |
    ✓ src/ai/omp/__tests__/acpProcess.test.ts  (17 tests) 32ms
    Test Files  1 passed (1)
    Tests  17 passed (17)

  command: npm test -- src/ai/omp/__tests__/acp.test.ts
  result: 18 passed
  output_excerpt: |
    ✓ src/ai/omp/__tests__/acp.test.ts  (18 tests) 56ms
    Test Files  1 passed (1)
    Tests  18 passed (18)

  command: npm test -- src/ai/omp/__tests__/hostTools.test.ts
  result: "No test files found, exiting with code 1" — EXPECTED. hostTools.ts and its test were
    deleted unconditionally per Acceptance Criteria ("no dead module referencing set_host_tools
    is left behind"); there is nothing left for this path to match. `grep -rn hostTools src/`
    confirms zero remaining imports (only explanatory comments referencing the deletion).

  command: npm test -- src/ai/tools/__tests__
  result: 51 passed
  output_excerpt: |
    ✓ src/ai/tools/__tests__/schemaContext.test.ts  (4 tests)
    ✓ src/ai/tools/__tests__/sqlTool.test.ts  (36 tests)
    ✓ src/ai/tools/__tests__/schemaTools.test.ts  (9 tests)
    ✓ src/ai/tools/__tests__/registry.test.ts  (2 tests)
    Test Files  4 passed (4)
    Tests  51 passed (51)

  command: npm test -- src/ui/__tests__/aiChatPanelAcp.test.ts
  result: 25 passed
  output_excerpt: |
    ✓ src/ui/__tests__/aiChatPanelAcp.test.ts  (25 tests) 21ms
    Test Files  1 passed (1)
    Tests  25 passed (25)
    (previously timed out at 90s under the pure-microtask `until`/`flush`; fixed by the
    setImmediate-based wait described in SUMMARY)

  command: npm run compile && npm test (full suite, run once after compile per constraint)
  result: 1196 passed | 2 skipped, 86 files (85 passed + 1 skipped) — no regression vs the
    1193/2/85 baseline; net +3 tests, +1 test file (all from this task's changes: +10 mcpBridge,
    -N hostTools removed, +2 acpProcess, +1 acp)
  output_excerpt: |
    Test Files  85 passed | 1 skipped (86)
    Tests  1196 passed | 2 skipped (1198)
    Duration  7.53s

  command: manual E2E (Acceptance Criteria, not part of the automated gate) — real omp/18.0.1 on
    PATH + real Postgres (docker `vsdb-postgres`, 127.0.0.1:5433/vsdb) + the actual
    acpProcess.ts/acp.ts/mcpBridge.ts/registry.ts/sqlTool.ts/schemaTools.ts modules via tsx, no
    mocks; two throwaway tables created in the live DB, chat asked "What tables are in this
    database? Use your tools to check, don't guess."
  result: PASS — real tool round-trip observed, correct answer
  output_excerpt: |
    [BRIDGE] descriptor: {"type":"http","name":"vsdb","url":"http://127.0.0.1:52854",
      "headers":[{"name":"Authorization","value":"Bearer c9c4dedb…"}]}
    [HANDSHAKE OK] sessionId=01a0372e-1659-7547-9c0f-881c137735cf version=18.0.1
    [TOOL CALL] list_tables({})
    [TOOL RESULT] list_tables -> [{"schema":"public","name":"customers"},
      {"schema":"public","name":"orders"}]
    [SESSION/PROMPT RESULT] {"stopReason":"end_turn"}
    [ASSISTANT TEXT]
    Two tables:
    - `public.customers`
    - `public.orders`
    (both tables were created fresh in the live DB immediately before this run and dropped
    immediately after; the answer matches exactly, sourced from the real MCP tools/list call
    logged above, not from omp's imagination)
ISSUES:
  - The `npm test -- src/ai/omp/__tests__/hostTools.test.ts` Verification Command from the task
    file necessarily exits 1 ("no test files found") because that file is deleted, as required by
    the Acceptance Criteria's unconditional-deletion clause. This is the expected/correct outcome
    of that command post-fix, not a regression — documented above rather than silently omitted.
  - `createDbTools(...)` in `ensureAcpSession()` is intentionally left without an explicit
    `: ToolRegistry` type annotation — the frozen `ToolRegistry` interface (`get`/`list` only)
    erases `DbToolRegistry.register()` under TS structural typing if annotated, so the concrete
    return type is left to inference.
HANDOFF_TO_REVIEWER: yes — handoff.reviewer.enabled per config; this is the last task of wave 3.
NEXT: ready for review. INDEX.md is intentionally NOT edited by this report per process
constraints; the orchestrator/reviewer owns status transitions.
