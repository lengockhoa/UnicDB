# INDEX_AIX01 — Grounded Workspace Context

Base: main @ 3b30f7c (post DBX-04) · Plan: PLAN_AIX01.md · Reviewer: unic-smart (Aix01Reviewer)
Executor: unic-code

## Tasks

| Task | Scope | Status |
|---|---|---|
| TASK-AIX01-001 | src/ai/grounding/{selection,attribution}.ts + tests | done |
| TASK-AIX01-002 | src/ai/grounding/fileSearch.ts + tests | done |
| TASK-AIX01-003 | groundingService + groundingMessages + aiChatPanel wiring + workspace_search tool | done |
| TASK-AIX01-004 | aix01Scaffold.test.ts + full regression | done |

## Contract (shared)

- Pure modules under src/ai/grounding/ — no vscode, no fs, no network.
  Host (groundingService) owns all I/O behind injected deps.
- Caps: selection 8_000 chars; file hits MAX_FILE_HITS=8 /
  MAX_CONTEXT_LINES=40; per-file read 100 KB (matches
  MENTION_RESOLVE_FILE_CAP_BYTES value).
- Secret/binary exclusions reported in bundle.excluded, never silently
  dropped.

Status (2026-08-30): all 4 tasks done AND reviewed. Review cycle: unic-smart reviewer issued CHANGES-REQUESTED (line offsets, Slack tokens, recursive globs, byte cap, tool registration on both engines, attribution footer + line-ranged refs, panel toggle protocol) -> 2 fix rounds (a388cdf, 6a2b560) -> superseding APPROVED verdicts at HEAD 6a2b560. Final: targeted 124/124 + bundle 21/21, full 2448 (0 failed), typecheck + esbuild clean.
