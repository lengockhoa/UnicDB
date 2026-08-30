# TASK-AIX01-003 — Grounding service + chat wiring + tool

Status: pending · Wave: 2 · Plan: PLAN_AIX01.md §5
Reviewer verdict: (none yet)

## Scope

`src/ui/groundingService.ts`, `src/ui/groundingMessages.ts`, aiChatPanel
handleSend merge + grounding_state, workspace_search AgentTool
registration, extension.ts optional grounding deps.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: groundingService.test.ts + aiChatGrounding.test.ts +
   workspaceSearchTool.test.ts per PLAN §4 rows 4-6; capture failing
   output.
2. GREEN: implement service (injected getSelection/readFile, caps,
   exclusions), wire block after mention block tagged
   `--- Grounded workspace context ---`, post grounding_state, register
   gated workspace_search tool, optional AiChatPanelOptions.grounding.

## Acceptance

- service ~8 + chat wiring ~6 + tool ~5 tests green
- `npm run typecheck` exit 0
- Targeted vitest file(s) pass; no unrelated file touched
