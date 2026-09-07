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
