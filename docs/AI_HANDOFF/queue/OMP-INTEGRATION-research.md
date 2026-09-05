# OMP Integration Research — UnicDB Extension

> Generated: 2026-08-23 (handoff Cycle L wave 1, scout agent) | Evidence-only, no speculation

## §Facts

### F1: omp is a native binary at `~/.local/bin/omp` (118.5 MB, Rust+N-API)
- Binary: `/Users/lenk/.local/bin/omp` — self-contained darwin-arm64 executable.
- Version: 18.0.1 (`~/.omp/agent/last-changelog-version`).
- Natives: `~/.omp/natives/18.0.1/pi_natives.darwin-arm64.node` (140 MB N-API addon — Rust core).
- Runtime data: `~/.omp/agent/` — `config.yml`, `models.yml`, `models.json`, SQLite DBs (`history.db`, `agent.db`, `models.db`), sessions, extensions, blob cache.
- License: MIT. Source: github.com/can1357/oh-my-pi (TypeScript + Rust).

### F2: omp has four programmatic surfaces
- **A — CLI headless**: `omp -p "prompt"` plain text stdout; `--mode json` streams JSON events; `--model <id>`; `--yolo --no-session`. Cold start 300-500ms per invocation. No tool callback.
- **B — RPC over stdio**: `omp --mode rpc --yolo --no-session`. Stdio JSONL. Client sends RpcCommand (prompt, steer, abort, set_model, set_host_tools, new_session, …); server emits RpcResponse + AgentSessionEvent stream (message_update/text_delta streaming, tool_execution_start/end). v2 framing for payloads up to 64 MB. `set_host_tools` lets the host register custom tools the agent calls back via host_tool_call frames. Canonical spec: docs/rpc.md (885 lines).
- **C — In-process SDK**: `@oh-my-pi/pi-coding-agent` `createAgentSession()` — requires **Bun 1.3.14+**, not Node.js → blocked for VS Code extension host (Node), would need a Bun worker process (architecturally equal to B but with an extra runtime dep).
- **D — ACP**: `omp acp --yolo` — approval-aware alternative to RPC.

### F3: config system
- Global `~/.omp/agent/config.yml`: `modelRoles` (this machine: default unic/unic-code, smol unic/unic-lite, slow+plan unic/unic-smart), `tools.approvalMode: yolo`, `model.maxOutputTokens`.
- Providers `~/.omp/agent/models.yml`: provider `unic` → `baseUrl https://openai.unicjsc.com/v1`, api `openai-responses`; models unic-smart/unic-work(vision)/unic-code/unic-lite (256k ctx, 32k out).
- Project `.omp/config.yml` overrides (UnicDB repo has one: modelRoles lite/code/smart/vision, approvalMode write).
- Agents `<project>/.omp/agents/*.md` — YAML frontmatter (name, description, model: "@code", tools) + Markdown system prompt.
- Skills: omp reads `.claude/skills/` directly via its claude discovery provider (no mirror needed).

### F4: install/upgrade
| Method | Command |
|---|---|
| curl script | `curl -fsSL https://omp.sh/install \| sh` |
| Homebrew | `brew install can1357/tap/omp` |
| npm (bun global) | `bun install -g @oh-my-pi/pi-coding-agent` |
| Self-update | `omp update` |
| Version | `omp --version` |

Natives are versioned directories (`~/.omp/natives/<version>/`). npm package (~17.2.x) lags binary (18.0.1).

### F5: UnicDB's existing install/update story
- One command (README): `curl -fsSL https://raw.githubusercontent.com/lengockhoa/UnicDB/main/scripts/install-UnicDB.sh | bash` — fetches latest .vsix from GitHub Releases → `code --install-extension <vsix> --force`. Idempotent.
- No post-install step for external tools. AI config currently manual via "UnicDB: Open AI Settings".

## §Options Compared

| Criterion | (a) spawn `omp -p` | (b) RPC server | (c) config-only reuse | (d) in-process SDK |
|---|---|---|---|---|
| Latency | 300-500ms/message | ~100ms first, ~0 after | ~0 (current) | ~200ms init |
| Streaming | no | **yes** (text_delta) | yes (UnicDB fetch) | yes |
| Persistence | session resume flags | **in-process + resume** | UnicDB in-memory | full |
| Tools | omp built-ins only | **set_host_tools bridge** | UnicDB 3 tools only | customTools |
| Errors | exit code | **structured RpcResponse** | ProviderError | structured |
| Upgrade coupling | tight | **medium (v1/v2 nego)** | none | tight (Bun sync) |
| Runtime req | binary on PATH | binary on PATH | none | **Bun 1.3.14+** ✗ |

## §Recommendation — Option (b): RPC bridge

Spawn `omp --mode rpc --yolo --cwd <workspace>` as a long-lived child process. `src/ai/ompBridge.ts` = RPC client + lifecycle (spawn/health/restart/`--continue` resume). Register UnicDB's DB tools (`run_sql` read-only, `list_tables`, `describe_table`) via `set_host_tools`; omp agent calls them back through host_tool_call frames. Chat panel streams text_delta into webview. **Fallback**: omp missing/old/crashed → existing cycle-J/K path (provider+agent.ts) with a one-time notification pointing at the install one-liner.

Why: persistent process (no per-message cold start), real streaming, host-tool bridge keeps read-only guardrails in UnicDB hands, omp's full 31-tool surface + model routing for free, `omp update` is the one-command upgrade, no Bun dependency. (a) latency unusable; (c) discards omp's value; (d) blocked by VS Code Node host.

## §Risks

| Risk | Severity | Mitigation |
|---|---|---|
| omp not installed | High | Activation check `omp --version`; fallback to existing AI + one-time install notice |
| Version skew | Medium | minOmpVersion constant (≥17.0.0 — host_tools + v2 framing); `omp update` one-liner |
| Process crash | Medium | Monitor exit; auto-restart with `--continue`; degrade gracefully |
| Agent file-system access | High | `--cwd` scoped to workspace; `--yolo` + bash.patterns deny rules; document that omp mode grants workspace access |
| Two AI paths | Medium | Bridge isolates omp path; shared AgentTool shape; non-omp remains default fallback |

## §Open Questions (implementer decisions logged here)
1. Approval mode: start `--yolo` + bash.patterns; ACP later.
2. Session history: read via get_messages from omp storage; don't duplicate.
3. Model UI: `set_model` RPC with user-chosen role; respect omp modelRoles.
4. Min version: 17.0.0.
5. Tool schema: AgentTool.parameters passes through directly — smoke-test.
6. Degradation: spawn error → non-omp path; crash → banner + restart.
7. LSP: enabled by default (`--no-lsp` escape hatch).
