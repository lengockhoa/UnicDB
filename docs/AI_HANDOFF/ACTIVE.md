# ACTIVE

Cycle: N — builtin engine streaming
Date: 2026-08-24
Base: main (8c4f2e7)

## State
planning_done — ready for executor

## Notes
- Chosen from backlog: UX gap of non-streaming builtin engine (user waits full response); ACP delta plumbing + abort token already exist (L/M); no external protocol guessing (unlike session-resume).
- Deliberate unfreeze: src/ai/provider.ts + src/ai/agent.ts (frozen in cycle J by scope policy, not permanent) — regression net = full suite (751 baseline).
- Tasks: 3, chain waves (1→2→3) — interface dependency thật mỗi tầng (streamComplete → onText/deps → panel wiring).
- Key decisions: SSE parse tự viết trong provider.ts (0 dep); stream-fail fallback nằm ở runAgent (pre-emit only); mid-stream fail = error surface, không retry.
- Goal: builtin turn stream delta realtime, stop giữa stream hủy được, 0 npm dep mới, 0 network call trong test, apiKey không vào webview/history.
