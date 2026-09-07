# TASK-012 — Extension host wiring: configured agent detection, factories, commands, webview switcher

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1(P0.1/P0.3), §2, §3(6)

## Goal

Wire the selected Claude Code/Codex engine from VS Code configuration through detection, host MCP bridge, process/chat-engine factory, AIChat panel options, one-time unavailable fallback UI, and user-visible engine switcher. Register the two new `useWith*` command handlers (manifest registration is TASK-013).

## Target Files

- `src/extension.ts` — imports, activation availability gate (:1075-1100), `commandOpenAiChat` (:1908-2042), Claude/Codex factory helpers beside `buildOmpChatEngine` (:2060), command registrations, `commandUseWithClaudeCode` / `commandUseWithCodex` beside `commandUseWithOmp` (:3497).
- `webview/aiChatPanelMain.ts` — widen host→webview `engine` message type (:63) and engine banner/switch controls to four engine values.
- `src/extension.test.ts` — host routing/fallback/command behavior tests.
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — webview engine-message/switch rendering tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | configured healthy Claude opens panel with Claude factory engine | only `detectClaudeCode` and Claude factory are invoked; panel receives `claudeCodeChatEngine`, resolved path/version | mocked config `ai.engine:"claude-code"`, healthy Claude detection |
| 2 | happy | configured healthy Codex opens panel with Codex factory engine | only Codex detection/factory used; panel gets Codex engine and banner message | mocked `ai.engine:"codex"`, healthy Codex detection |
| 3 | edge (unavailable) | selected Codex missing at activation/open | `showInformationMessage` contains `UnicDB: codex engine unavailable — falling back to builtin.` + install hint; global setting changed to builtin; provider route opens only if config valid | missing detection + valid config |
| 4 | edge (selection precedence) | builtin setting with healthy omp/claude/codex | no agent detection/factory route wins; panel gets builtin only — P0.3 regression | `ai.engine:"builtin"`, all probes healthy |
| 5 | edge (no workspace) | `UnicDB.ai.useWithClaudeCode` / Codex command without workspace | each shows `UnicDB: open a folder before running \`Use with Claude Code\`.` / Codex equivalent; no filesystem write | no workspace folder |
| 6 | edge (webview invalid engine message) | unknown host `engine` message | webview does not inject unsafe class/text; displays/keeps safe builtin state | postMessage `{type:"engine",name:"unknown"}` fixture |
| 7 | regression | existing OMP configured route unchanged | healthy `ai.engine:"omp"` still invokes `buildOmpChatEngine` with detection.path rather than bare string; OMP banner / fallback behavior stays green | preexisting omp test fixture |

## Test Files

- `src/extension.test.ts` — tests 1–5, 7.
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — test 6 and four-engine banner/switch behavior.

## Verification Commands

```bash
npx vitest run src/extension.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
npm run typecheck
npm run compile
```

No lint script exists in this project — lint is N/A; typecheck is the static gate. Compile validates webview bundle output.

## Acceptance Criteria

- [ ] `commandOpenAiChat` reads user choice then probes ONLY that non-builtin agent; it passes explicit `{ engine, detections, config }` mode to TASK-007 `resolveEngine`.
- [ ] Agent unavailable/old means a clear selected-agent notice + persisted global builtin fallback, mirroring current omp update/install pattern; healthy other agent is never silently substituted.
- [ ] Factories reuse `createHostMcp` / `createMcpBridge` from `src/ai/omp/` and thread detected path into new process adapters; no duplicate DB tool registry or secret wire plumbing.
- [ ] MCP configuration is ephemeral/managed: any temporary Claude/Codex config file has restrictive local path, is deleted on engine dispose, and contains only `127.0.0.1` MCP endpoint metadata — NEVER apiKey/DB credentials. Record exact CLI config shape in Discussion with verified source.
- [ ] New `useWith*` command handlers reuse existing `writeUnicDBAiConfig` context export where meaningful, have no additional workspace config format, and return copyable agent-specific command text. Commands are registered in extension (TASK-013 exposes them in manifest).
- [ ] Webview displays/accepts all 4 engine labels and unknown inbound values fail safely.
- [ ] All listed tests pass.

## Dependencies

- TASK-007 — consumes explicit `resolveEngine({ engine, detections, config })` policy.
- TASK-009 — consumes Claude chat engine factory/interface.
- TASK-010 — consumes Codex chat engine factory/interface.
- TASK-011 — consumes `AiChatPanelOptions.claudeCodeChatEngine`, `.codexChatEngine`, widened EngineKind/wire behavior.

## Interfaces

- Consumes: explicit `resolveEngine` mode from TASK-007; `createClaudeCodeChatEngine` (TASK-009); `createCodexChatEngine` (TASK-010); panel option fields from TASK-011; current `buildOmpChatEngine(adapterFactory, ompPath, ...)` at `src/extension.ts:2060` as pattern; `writeUnicDBAiConfig` as current config export used by `commandUseWithOmp` :3511.
- Produces:
  - host construction of `AiChatPanel` carrying exactly one selected external chat engine option (or none for builtin);
  - registered extension command callbacks for `UnicDB.ai.useWithClaudeCode` and `UnicDB.ai.useWithCodex` (manifest identifiers supplied by TASK-013);
  - widened webview inbound engine message union that TASK-014 integration tests exercise.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Avoid touching `package.json` here; TASK-013 owns it. Grounded call sites: activation gate starts at extension.ts:1075, open at :1908, OMP factory at :2060, OMP use command at :3497. New command functions must not imply that a workspace config format is supported without verified CLI evidence.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer (handoff-fullstack I3)

### RED Output

Wrote 18 new tests across the two test files (7 in extension.test.ts TASK-012 describe block, 11 in aiChatPanelWebview.test.ts across 4-engine banner + unknown engine blocks). Initial RED phase confirmed — new TASK-012 describe blocks failed because the helpers/factories did not yet exist (TS errors `Cannot find name 'claudeCodeState'/'codexState'` plus runtime `expected "spy" to be called` failures). Captured each failing assertion before implementing the corresponding helper. Tests immediately GREEN after implement would have been flagged; none were.

### Implementation summary

- `src/extension.ts` (+451): added imports (`detectClaudeCode`, `detectCodex`, `createClaudeCodeChatEngine`, `createCodexChatEngine`, `createClaudeCodeProcess`, `CodexProcess`, `fsp`, `path`, install hints, `AgentDetections`); rewrote `commandOpenAiChat` to normalize raw engine setting, probe only the selected non-builtin agent, pass `{engine, detections, config}` to `resolveEngine`, surface engine-specific unavailable notice, persist global builtin fallback, build matching chat engine and wire onto TASK-011 seams (`ompChatEngine` / `claudeCodeChatEngine` / `codexChatEngine`); added helpers `normalizeEngineChoice`, `probeSelectedEngine`, `projectAgent`, `engineHint`; added factories `buildClaudeCodeChatEngine`, `buildCodexChatEngine`, `writeClaudeMcpConfigFile`; added commands `commandUseWithClaudeCode`, `commandUseWithCodex` reusing `writeUnicDBAiConfig`; registered `UnicDB.ai.useWithClaudeCode` + `UnicDB.ai.useWithCodex`. Claude factory writes ephemeral MCP config (`{"mcpServers":{"UnicDB":{"type":"http","url":"http://127.0.0.1:<port>"}}}` — 127.0.0.1 metadata only, no apiKey/DB credentials), 0o600 perms, deleted on engine dispose via wrapped `hostMcp.stop`. Codex factory reuses same HostMcp + McpBridge but does not write a temp config (TASK-006 verified `codex exec --json -` does not consume `--mcp-config`).

- `webview/aiChatPanelMain.ts` (+70): widened inbound `EngineMsg.name` to `string` with closed-set whitelist; added `ENGINE_LABELS` (builtin→"builtin", omp→"oh-my-pi (omp)", claude-code→"Claude Code", codex→"Codex"); added `safeEngineClassName` + `safeEngineLabel` mapping unknown values to builtin; updated `applyEngine` to render all 4 labels with safe fallback.

- `src/extension.test.ts` (+369): added `state.workspaceConfigUpdates` array (each `update()` call pushes); added `claudeCodeState` / `codexState` vi.hoisted stubs; added vi.mocks for `./ai/claudeCode/detect`, `./ai/codex/detect`, `./ai/claudeCode/claudeCodeProcess` (returns stub handle that never spawns), `./ai/codex/codexProcess` (returns `CodexProcessStub` with stub `start()`); added `TASK-012 — Claude Code / Codex engine routing` describe block with 7 tests covering tests 1–5 + 7 from the task file.

- `src/ui/__tests__/aiChatPanelWebview.test.ts` (+171): added `TASK-012 4-engine banner` block (8 tests covering omp, claude-code, codex, builtin banners + versions + hint) and `TASK-012 unknown engine name fails safely` block (4 tests covering unknown name, hostile `<script>`, hostile `<img onerror>`, missing name field).

### Verification Output

```
> npx vitest run src/extension.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
Test Files  1 failed | 1 passed (2)
Tests       1 failed | 223 passed (224)
```

All 18 TASK-012 tests pass. The single failure is `TASK-AIX07-003 #1 — showPolicy reports provider+context+tools+export; exportTrace calls saveDialog and writes envelope; clearTrace calls the panel` — assertion `expect(win.showSaveDialog).toHaveBeenCalledTimes(1)` got 0. Verified pre-existing on main by stashing TASK-012 changes and re-running the same test on main: same failure. Not introduced by TASK-012; out of scope here (TASK-AIX07 belongs to its own wave).

```
> npm run typecheck
> UnicDB@1.53.23 typecheck
> tsc --noEmit
(no errors)
```

```
> npm run compile
> UnicDB@1.53.23 compile
(esbuild output — dist/webview.js 2.3mb, dist/webview.css 41.1kb, dist/extension.js 6.5mb)
esbuild: build complete
```

```
> git diff --stat HEAD package.json
(empty — package.json untouched, manifest registration deferred to TASK-013)
```

### MCP config shape (verified)

`buildClaudeCodeChatEngine` writes a temp file (0o600, `.vscode/.unicdb-claude-mcp-<port>-<ts>.json`) containing:

```json
{"mcpServers":{"UnicDB":{"type":"http","url":"http://127.0.0.1:<port>"}}}
```

Confirmed via `claude --help` (local 2.1.261): `--mcp-config <file>` accepts JSON with `mcpServers` map keyed by server name; URL is the Streamable-HTTP endpoint HostMcp listens on (127.0.0.1 only, no apiKey/DB credentials ever appear in this file). File is removed by the `hostMcp.stop` wrapper installed in the factory dispose path. Codex exec mode (TASK-006 verified) does not accept `--mcp-config`, so no temp file is written.

### package.json untouched

Verified `git diff --stat HEAD package.json` → empty. Manifest registration of `UnicDB.ai.useWithClaudeCode` / `UnicDB.ai.useWithCodex` is TASK-013's job per the planner's Discussion note.

Status: PASS
Note: TASK-AIX07-003 #1 pre-existing failure unrelated to TASK-012 (verified by stash-and-rerun on main); defer to its own wave. No other issues.
