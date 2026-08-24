# ACTIVE

Cycle: N — builtin engine streaming

## State
planning

## Notes
- Chosen from backlog: UX gap of non-streaming builtin engine (user waits full response); ACP delta plumbing + abort token already exist (L/M); no external protocol guessing (unlike session-resume).
- Deliberate unfreeze: src/ai/provider.ts + src/ai/agent.ts (frozen in cycle J by scope policy, not permanent) — regression net = full suite (751 baseline).
