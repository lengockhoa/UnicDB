# ACTIVE

Cycle: J   Date: 2026-08-23   Base: main
Goal: AI Core foundation — config storage (SecretStorage + globalState) + OpenAI-compatible provider + agent loop (multi-turn, tool seam) + AI Settings form
Tasks: 4 total (TASK-001..004; waves 1:[001,002] 2:[003] 3:[004])
Status: planning_done — ready for executor

Notes:
- Pure modules: src/ai/settings.ts (no vscode), src/ai/provider.ts + src/ai/agent.ts (no vscode, injected fetch/config/registry). Interface freeze list in PLAN.md §3.
- Scope guards cycle J: NO DB tools (empty ToolRegistry seam), NO streaming, NO chat panel, NO Anthropic protocol. Method enum: 'responses' | 'chat/completions'; roles: work (vision) + smart.
- Unit tests only — fake vscode (connectionManager.test.ts pattern), fake fetch, fake registry. No PG container, no network.
- Security: apiKey → SecretStorage `vsdb.ai.apiKey` only; never logged/serialized; agent re-reads config per run (no stale cache).

Kết quả gần nhất:
- v1.5.1 (2026-08-23-H): EXPLAIN ANALYZE guard, emoji-safe modal, lock sync. 453 tests.
- Cycle I (2026-08-23, table designer): 6 tasks done; plan archived trong archive/.
