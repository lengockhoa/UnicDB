# TASK-AIX01-004 — Scaffold hygiene + full regression

Status: done · Wave: 3 · Plan: PLAN_AIX01.md §5
Reviewer verdict: (none yet)

## Scope

`src/__tests__/aix01Scaffold.test.ts`.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: purity guards (no vscode in src/ai/grounding/*, no network
   imports, no eval, word-safe secret patterns); capture failing output.
2. GREEN: fix violations.
3. Full regression: `npx vitest run` 0 failed; `npm run typecheck`.

## Acceptance

- scaffold ~5 green; full suite green
- `npm run typecheck` exit 0

## Executor Report

### 2026-08-30 · executor · omp-direct/unic-code

TDD RED→GREEN evidence:
- TASK-AIX01-001: RED `Failed to load url ../selection` / `../attribution` → GREEN 14/14 (8 selection + 6 attribution). One assertion correction: startLine is 1-based into the source file (post-trim), so leading-blank-trim test asserts 5 (4 blank lines trimmed off).
- TASK-AIX01-002: RED `Failed to load url ../fileSearch` → GREEN 14/14. One bug fix during GREEN: match score is now TOTAL OCCURRENCE count (walk all matches per term) so one term with many matches outranks several terms matching once; also fixed two sloppy-edit failures (`return { hits, excluded }` left without closing brace + `function*` generator not used).
- TASK-AIX01-003: RED `Failed to load url ../groundingService` / `../workspaceSearchTool` → GREEN 18/18 (8 service + 5 tool + 5 chat wiring). Source-level guards + UiChatPanel message-union + wiring edits survived the typecheck pass without regression.
- TASK-AIX01-004: scaffold guards GREEN immediately (purity, secret word-safety, source-level wiring presence).

Verification: targeted (grounding + service + tool + chat + scaffold + extension) 138/138; full suite 2440 passed | 2 skipped; typecheck exit 0; esbuild clean.

Files: src/ai/grounding/{selection,attribution,fileSearch}.ts + 3 test files, src/ui/{groundingService,groundingMessages}.ts + 2 test files, src/ai/tools/workspaceSearchTool.ts + test, src/__tests__/aix01Scaffold.test.ts, src/ui/aiChatPanel.ts (block merge + grounding_state post), src/ui/aiChatPanelMessages.ts (AiChatPanelGroundingState type), src/extension.ts (isGroundingEnabled + readActiveSelection + readWorkspaceFile + opt-in wiring).
