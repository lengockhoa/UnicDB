# ACP Session History & Resume Research — Cycle O

> Generated 2026-08-24 from live `omp acp` probes (oh-my-pi 18.0.1, cwd UnicDB). Complements queue/ACP-APPROVAL-research.md (Cycle M).

## Verified facts (live probe evidence)

1. **`session/new` requires `mcpServers` to be an array.**
   - `params: { cwd }` alone → `-32603` `undefined is not an object (evaluating 't.length')`.
   - `params: { cwd, mcpServers: [] }` → `result: { sessionId, configOptions, modes }`.
   - `configOptions` entries: `mode` (default|plan), `model` (currentValue from agent default), `thinking` (off|minimal|low|medium|high|xhigh). `modes.availableModes` + `currentModeId` also returned.
2. **`session/list`** (`params: {}`) → `{ sessions: [...] }`; each session: `sessionId`, `cwd`, `title?`, `updatedAt`, `_meta: { messageCount, size }`. Title may be the literal string `"<function>"` (agent-generated title bug upstream) — UI must treat title as optional/possibly-junk, fall back to date/size.
3. **`session/load`** `params: { sessionId, cwd, mcpServers: [] }` → result `{ configOptions, modes }` then **replays the transcript as `session/update` notifications**. Probe replayed 157 notifications with kinds: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk` (never render), `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `session_info_update`.
   - `user_message_chunk` update shape: `{ sessionUpdate, content: { type:"text", text }, messageId }`.
   - `session_info_update` shape: `{ sessionUpdate, title, updatedAt }`.
   - Bad sessionId → `-32603` `ACP session not found: <id>`.
4. **Resume works end-to-end**: after `session/load`, `session/prompt` on the same sessionId completed with `stopReason: "end_turn"` (probe replied "OK-UnicDB"). Continuation uses the loaded context.
5. `session/fork`, `session/cancel`, `session/close` exist in installed schema; NOT probed this cycle — do not use without evidence.

## Architecture decision (input to plan)

- Add a **History picker** in the AI Chat panel: "Resume session" button/command lists `session/list` entries filtered to the current workspace `cwd`, sorted by `updatedAt` desc, capped (e.g. 20). Row = title||"(untitled)", relative time, messageCount.
- Selecting a row: host performs `session/load`, buffers replay notifications until the load result resolves, then replays them into the webview as history messages (skip `agent_thought_chunk`; render user/agent text + tool calls collapsed), then the panel continues prompting on that sessionId.
- Panel session model must allow replacing the active sessionId (new→loaded) and re-basing history; Stop/dispose keeps Cycle M's default-deny/lifecycle semantics.
- Keep read-only DB host tools + apiKey isolation unchanged. No new deps. History list must never block normal chat; failures degrade to an inline notice.

## Risks for the plan

- Replay volume: a session can be huge (probe saw `_meta.size` 14.9 MB). Buffering replay chunks must not OOM the webview — cap rendered history (e.g. last N messages), note truncation.
- `title: "<function>"` junk — never show raw title if equal to that literal; fallback label.
- `session/load` params must include `mcpServers: []` (same as session/new) or server errors.
- Concurrent load while a turn is streaming must be forbidden (disable picker while busy).
