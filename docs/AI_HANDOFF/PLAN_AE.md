# PLAN_AE — Cycle AE: OMP runtime session wiring (v1.11.0)

## §Goal

Turn cycle AD's "export config + print command" bridge into a real `omp` runtime: spawn `omp` as a long-lived child process, stream its responses into the AI Chat panel, and host VSDB's DB-aware tools into OMP's MCP bridge so the model can call them directly. Release target v1.11.0.

## §Constraints

- Base: `main @ 4a2c251` (cycle AD release v1.10.0).
- OMP availability = opt-in: detection already exists (`src/ai/omp/detect.ts`, `MIN_OMP_VERSION = "17.0.0"`). Activation gate checks `vsdb.ai.engine === "omp"` and `omp --version ≥ 17.0.0`. Fallback to existing builtin engine + one-time install notice (per OMP-INTEGRATION-research.md §Recommendation).
- Privacy invariant (cycle AA): when VSDB hosts the tools via the MCP bridge, the tools live inside the extension host — no schema/row bytes leave the extension except through `omp`'s configured base URL.
- ACP session lifecycle already implemented (`src/ai/omp/acp.ts`, `src/ai/omp/acpProcess.ts`). Cycle AE reuses the existing child-process infrastructure, NOT a new RPC client.
- TDD mandatory; RED first.

## §Approach

### Bridge architecture

Two new modules:

1. **`src/ai/omp/ompChatEngine.ts`** (NEW) — wires the chat panel to an `omp` ACP session. Owns the chat-level lifecycle: spawn → resume-or-new session → send text → stream `text_delta` into the panel → tool-call permission hand-off → finalize.
2. **`src/ai/omp/hostMcp.ts`** (NEW) — exposes the cycle-AD DB-aware tools as an in-process MCP HTTP server bound to `127.0.0.1:<port>`. Uses the `mcpServers` `http` shape proven in `docs/AI_HANDOFF/queue/ACP-TOOLS-research.md`. Pure tool-call dispatch: host tool call → `DbToolPermissionGate.wrap(tool)` → result text.

`src/ai/omp/mcpBridge.ts` already exists for cycle O (history replay). Cycle AE keeps it (different concern) and adds `hostMcp.ts` as a sibling.

### Engine selection (chat panel)

`AiSettings.engine: "builtin" | "omp"` (new field, default `"builtin"`). When the user picks `"omp"` (via the existing `vsdb.ai.openAiSettings` form + a new UI element), the chat panel delegates to `ompChatEngine.send()` instead of the current `provider.ts`+`agent.ts` path.

On activation:

1. `detectOmp()` → if `not-installed` / `version-too-old`, show a one-time `vscode.window.showInformationMessage` with the install one-liner (`OMP_INSTALL_HINT` / `OMP_UPDATE_HINT`) and degrade to builtin (silent re-fallback, never an error toast).
2. Spawn `omp acp --yolo --cwd <workspace>` via `acpProcess.spawn()`. Reuse existing `acp.ts` types.
3. `session/new` with `mcpServers: [{type:"http", name:"vsdb", url:"http://127.0.0.1:<port>"}]` — verified acceptance per ACP-TOOLS-research.md.
4. The first inbound `tools/list` from omp confirms tool discovery; the gate attaches host tools lazily on first prompt to avoid boot-time cost.

### Streaming

`acp.ts` already exposes `agentMessageDelta`, `agentThoughtChunk`, `agentToolCallStart`, `agentToolCallEnd` events. `ompChatEngine` forwards `agentMessageDelta` to the panel's `appendDelta(msg)` mirror (the existing streaming UI in `webview/aiChatPanelMain.ts` already handles it).

### Permission gate (reuse, no new UX)

DB-aware tools inherit the cycle-AD `DbToolPermissionGate` — the hostMcp layer wraps every tool with it before registration. Permission requests travel host→webview exactly as cycle AD wired them (the gate posts `permission_request`; the user clicks Allow/Deny; the host runs the tool). The MCP HTTP bridge handles JSON-RPC `tools/call` synchronously: `permission_request` posts to the panel, the bridge holds the call open, the user responds, the bridge resolves the call with the tool's text output.

### Resume

When the user clicks `Resume` (existing cycle-O picker), `ompChatEngine.resume(sessionId)` issues `session/load` against the running `omp acp` child and replays via the existing `AcpReplayBuffer`. No new code path needed for replay itself.

## §Files (expected)

- `src/ai/omp/ompChatEngine.ts` (NEW) — chat-level glue
- `src/ai/omp/hostMcp.ts` (NEW) — in-process MCP HTTP server with `tools/list` + `tools/call`
- `src/ai/settings.ts` — add `engine: "builtin" | "omp"` with default `"builtin"` (in `AiSettings`)
- `src/ui/aiChatPanel.ts` — when `engine === "omp"`, route through `ompChatEngine.send` instead of the builtin path. Pure additive.
- `src/extension.ts` — at activation, if `vsdb.ai.engine === "omp"`, call `hostMcp.start()` and pass its port into `acpProcess` boot args.
- `webview/aiChatPanelMain.ts` — engine-agnostic; no change.
- New tests:
  - `src/ai/omp/__tests__/ompChatEngine.test.ts` — unit tests with fake ACP stream + fake MCP bridge
  - `src/ai/omp/__tests__/hostMcp.test.ts` — pure HTTP server probe + tool dispatch tests
  - `src/ui/__tests__/aiChatPanelEngine.test.ts` — engine routing: builtin path unchanged, omp path delegates, fallback works

## §Acceptance criteria

0. **Detection gate**: with `vsdb.ai.engine = "omp"` AND `omp` missing → builtin path runs + one-time install notice fires once per activation (idempotent across restarts).
1. **Engine routing**: chat panel's `handleSend` calls `ompChatEngine.send()` when `engine === "omp"` and `provider.completeStream` when `"builtin"`. No cross-contamination.
2. **MCP tool discovery**: `omp acp` child, on `session/new` with the in-process MCP server entry, sends an inbound `tools/list` request to the local HTTP server (verified by an integration test that captures the inbound frame, mirroring ACP-TOOLS-research probe).
3. **DB tool routing**: when omp calls `tools/call` with one of the 5 DB tool names → `hostMcp` wraps the call in `DbToolPermissionGate`; on Allow the tool executes against the active adapter; on Deny the bridge returns `isError: true, content: [DB_TOOL_DENIED_MESSAGE]`.
4. **Streaming parity**: text_delta and thought_chunk events from `omp` map to the same panel renders the builtin engine uses. Cycle-AA streaming UI behavior (blinking caret, jump-to-latest, scroll discipline) unchanged.
5. **Fallback**: when the `omp` child process exits or crashes mid-turn, the panel surfaces a single error bubble and continues with builtin on subsequent turns (engine flips back to `"builtin"` in settings with a notice).
6. **Cycle-AA regressions stay green**: privacy sentinel + attachments + mention + thought + regen + DB-aware regression pins all pass. New tests do not break cycle AD's 33 + 23 + 12 + 5 test counts.
7. **Cycle-AB regressions stay green**: image attach + clipboard paste still works in both engines; non-vision rejection still happens when `vsdb.ai.models.work.vision = false` and engine is `omp` (mirror the cycle-AB omp gate).
8. **No apiKey leak**: `omp`'s `mcpServers` entry uses an in-process HTTP URL only; the DB credentials, secrets, and api keys never enter any omp wire frame — verified by a static assertion in `hostMcp.test.ts`.

## §Test plan

| Layer | Cases | Tool |
|---|---|---|
| Engine routing RED | engine="builtin" → provider path; engine="omp" → ompChatEngine; missing engine in config → default builtin | T3 |
| hostMcp RED | tools/list returns 5 DB tools; tools/call with allow-once runs; tools/call with deny returns DB_TOOL_DENIED_MESSAGE; no apiKey in any wire frame | T1 |
| ompChatEngine RED | send() spawns omp + streams text_delta; tool_call bridges to hostMcp; crash mid-turn → fallback notice | T2 |
| Cycle AA/AB/AD regression | privacy 7, attachments 11, dbAware 12, dbAwareWebview 4, extensionConfigExport 5 | T1-T3 |

## §Out of scope (defer to AF/AG+ if user wants)

- Slash commands queue (`/clear`, `/resume`, `/engine`, `/context`, `/export`, `/model`).
- In-process SDK surface (Bun 1.3.14+).
- Grid Excel overhaul (cycle S).
- Direct OMP RPC mode (we use ACP because it's the proven transport from cycle O).

## §Wave plan

- **Wave 1** (2 parallel, file-disjoint):
  - T1: `hostMcp.ts` + tests (pure server + tool dispatch; no chat glue)
  - T2: `ompChatEngine.ts` + tests (depends on T1's interface; executor stubs T1 contract)
- **Wave 2** (1):
  - T3: `engine` field in `aiSettings.ts` + chat panel routing + extension.ts wiring + integration tests

## §Verification

- `npm test` — expect ≥ 1937 + ~25-30 new tests passing
- `npm run typecheck` — exit 0
- `npm run package -- --no-dependencies` → `vsdb-1.11.0.vsix` with 18 entries, 0 forbidden, all v1.10.0 markers + new cycle AE markers (`ompChatEngine`, `hostMcp`, `vsdb.ai.engine`)
- Manual smoke: spin VS Code, set `vsdb.ai.engine = "omp"`, open AI Chat, send a query that requires DB context — observe streaming + a permission card for a DB tool, click Allow, see the inline tool result in the chat.
- Optional integration probe (mirror cycle O's acpLiveSmoke.test.ts): spawn a real `omp acp` against the local MCP server in CI; accept if `tools/list` arrives.

## §Versioning

Minor bump `v1.10.0 → v1.11.0` per `docs/RELEASE.md` minor policy (new user-visible surface: omp runtime mode in the AI Chat).
