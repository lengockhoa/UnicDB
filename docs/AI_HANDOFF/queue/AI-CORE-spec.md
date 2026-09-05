# Cycle J (queued) — AI Core: Config + Provider + Agent Foundation

Captured 2026-08-23 from user spec (verbatim intent preserved; analyzed for planning).
Supersedes the older vague "AI assist tab" backlog item.

## User requirements (verbatim intent)

1. **AI config storage** — a single place for AI config; data MUST NOT be exposed publicly.
   - OpenAI-Compatible connection info: `baseUrl`, `apiKey`, `method`: `responses` or `chat/completions`.
   - 2 model roles:
     - `work` (user calls it "unic-work") — daily tasks, **vision-capable** (can read images).
     - `smart` (user calls it "unic-smart") — deep reasoning, thinks thoroughly.
   - The agent MUST be able to call both models continuously (multi-turn loop).
2. **Reconfigurable** — the user MUST be able to change the entire config (including both models) at any time; the AI agent MUST always read the latest config at runtime, NOT cache stale values.
3. **AI Agent foundation** — take that config and operate; future task: provide the best support for already-connected DBs. Prepare the core (foundation); DB-assist capabilities come in later cycles.
4. The user emphasizes: analyze carefully — this is the CORE of the AI integration into the extension.

## Analysis (for cycle J planner)

- **Storage**: apiKey → `context.secrets` (SecretStorage) following the ConnectionManager pattern; baseUrl/method/model ids → workspace/global configuration (vscode.workspace.getConfiguration('UnicDB.ai')) or secrets with JSON. Config edit UI: extend the connectionForm pattern or a dedicated `AI Settings` form (command palette + tree?). NEVER log apiKey; NEVER include in telemetry/error messages.
- **Provider client** (pure module, unit-testable): `src/ai/provider.ts` — thin fetch client for OpenAI-compatible: switch between `chat/completions` and `responses` (different bodies), optional streaming (next cycle if needed), timeout, error mapping. Vision: message content parts with image_url (data URL) for the `work` role.
- **Agent loop**: `src/ai/agent.ts` — config-driven model routing (role → model id), tool-calling loop (function calls) with budget cap (max steps), every run MUST re-read config from storage (reconfigurable requirement). Skeleton + unit tests with a fake fetch; DB tools NOT yet needed — tool registry interface empty, DB tools are cycle K+.
- **Privacy**: all calls go directly to the user-configured baseUrl; no third-party telemetry; document CSP/egress in README. `Data MUST NOT be exposed publicly` = MUST NOT send schema/data anywhere outside the endpoint the user configured.
- **Security**: cycle J planner MUST consult discover-security skill (api key handling). 
- Depends on: nothing from Cycle I (independent subsystem). Consumed later by the "Add to AI Prompt" backlog item and AI DB-assist features.

## Out of scope (cycle J)
- DB-aware tools (schema reading, query gen) — cycle K+
- Streaming UI / chat panel — after the core is stable
- Anthropic/native non-OpenAI-compatible protocols — the user ONLY requires OpenAI-compatible
