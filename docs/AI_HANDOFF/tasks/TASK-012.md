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
