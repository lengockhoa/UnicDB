# TASK-005 — @-mention references (DB objects + workspace files)

Status: ready | Owner: executor (code tier) | Reviewer: unic-smart | Parent: docs/AI_HANDOFF/PLAN.md cycle AA
Dependencies: TASK-001, TASK-002 (wave 3 — serializes on host contract + webview input work).

## Goal

Typing `@` in the chat composer opens a candidate dropdown of database objects (tables/views/routines) AND
workspace files (Cursor/Copilot-style). Selecting inserts an `@token`. On send, the host resolves every token
for that turn: object → DDL structure block; file → file content (size-capped, truncation notice). Unresolved
tokens get an inline notice. User-initiated only; the auto-context path (`buildMessages` DDL baseline) is
untouched — the TASK-004 lock must stay green.

## Target Files

- `src/ui/aiChatPanelMessages.ts` — extend webview message union: `mention_objects` (host→webview candidates),
  `webview→host`: `mention_list` request, send carries `mentions: string[]` parsed out; host message union
  gains `mention_objects` + per-turn context injection API on the host side.
- `src/ui/aiChatPanel.ts` — pure `parseMentionTokens(text)` helper (exported for tests); candidates provider
  (adapter.listTables/listViews/listRoutines via existing adapterFactory + `vscode.workspace.findFiles` with
  default excludes, cap 50, debounced); on send: resolve each token (object → buildDatabaseStructure DDL block;
  file → read, >100KB truncate + notice), append "Referenced context" block to that turn's messages; unresolved
  → inline notice message to webview.
- `webview/aiChatPanelMain.ts` — `@` keyup listener on #prompt; dropdown DOM (`.vsdb-chat-mention-*` classes,
  textContent-only), keyboard nav (ArrowUp/Down, Enter/Tab select, Esc close), insert-token-into-textarea,
  Enter-while-open selects and NEVER sends; send strips @tokens from text and ships `mentions` array.
- `webview/styles.css` — dropdown card/rows/kind-badge/hover styles (mirror permission-card pattern).

## Test Cases

| # | Type | Name | Expected |
|---|------|------|----------|
| 1 | happy | dropdown lifecycle | `@` keyup → `mention_list` posted; host replies `mention_objects` (≤50, DB+files, kind badges); typing filters client-side |
| 2 | happy | keyboard select | ArrowUp/Down moves active row; Enter or Tab inserts `@schema.name ` token + closes; Esc closes without insert |
| 3 | happy (invariant interplay) | Enter-while-open selects, not sends | dropdown open + Enter → selection inserted, NO `{type:"send"}` posted; dropdown closed + Enter → sends |
| 4 | happy | object DDL injection | send text containing `@public.users` → messages include "Referenced context" block with CREATE TABLE DDL for users; listTables/listColumns called; runQuery call count 0 |
| 5 | happy | file content injection | send with `@src/foo.ts` → block contains file content; oversized (>100KB) file → truncated + notice line |
| 6 | edge | unresolved token | `@does.not.exist` → inline notice bubble; send proceeds without a block; no throw |
| 7 | edge | no send when candidates empty + @ | `@` with zero matches → dropdown shows "No matches"; Enter closes only |
| 8 | edge (invariant) | no auto-fire | without user `@` input, zero `mention_list` posts; buildMessages output identical to TASK-004 baseline |
| 9 | edge | multiple + duplicate tokens | `@a @b @a` → dedupe, two resolved blocks, order stable |
| 10 | regression | privacy lock intact | TASK-004 sentinel test still green after mention work (run in Verification) |

## Test Files

- `src/ui/__tests__/aiChatPanelMentions.test.ts` (new) — host-side parser + resolution + message shapes.
- `src/ui/__tests__/aiChatPanelBundle.test.ts` (extend) — dropdown DOM lifecycle + keyboard nav + Enter semantics (bundle-based, pattern exists).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelMentions.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] `@` opens unified DB+file candidates dropdown; keyboard navigable; Enter/Tab select; Esc dismiss.
- [ ] Enter-while-open NEVER sends (TASK-002 keybind semantics preserved).
- [ ] Object tokens resolve to DDL-only blocks; file tokens to capped content; both per-turn only.
- [ ] Unresolved tokens → inline notice; never silent, never throw.
- [ ] Privacy invariant intact: TASK-004 sentinel green; auto-context baseline unchanged.
- [ ] No new dependencies; CSP-safe; typecheck green.

## Discussion thread

- 2026-08-27 orchestrator: created during Round-2 revision (user steering: mentions must cover files too).

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecT5 (feature-implementer)
SUMMARY: Implemented @-mention host resolution + webview dropdown lifecycle + keyboard nav; host parses tokens, resolves DB objects (tables/views/routines) to DDL blocks and files (≤100KB) to content; webview renders dropdown, handles ArrowUp/Down/Tab/Esc/click-outside, and Enter-while-open NEVER sends (preserves TASK-002 semantics). 135 tests pass across 8 suites; typecheck green; compile clean.
TEST_PLAN_FOLLOWED: inline — happy (parser, resolution, dropdown lifecycle, keyboard nav, Enter semantics), edge (no-matches, miss notice, click-outside, send-while-open), regression (TASK-004 privacy sentinel).
FILES_CHANGED:
  - src/ui/aiChatPanelMessages.ts: extended host→webview with `mention_objects` + `mention_miss`; webview→host with `mention_list`; added AiChatPanelMentionObjects / AiChatPanelMentionMiss / AiChatPanelMentionList unions.
  - src/ui/aiChatPanel.ts: added `parseMentionTokens` + `resolveMentionsForTurn` exports, `handleMentionList`, `case "mention_list"` dispatch, mention resolution + `contextBlock` augmentation on `handleSend`, ACP engine receives augmented content as prompt text.
  - webview/aiChatPanelMain.ts: @-mention dropdown lifecycle (mentionOpen, mentionActiveIndex, mentionItems, mentionQuery, lastCaretPos), DOM helpers (render/position/dispose/filter/move/select), keyup→mention_list, keydown→Arrow/Tab/Enter/Esc (Enter on no-match closes), mousedown click-outside, message handlers for mention_objects + mention_miss.
  - src/ui/__tests__/aiChatPanelMentions.test.ts: 28 tests covering parser (9), object resolution (8), file resolution (5), message shapes (3), contextBlock (3).
  - src/ui/__tests__/aiChatPanelWebviewTask005.test.ts: 16 tests covering dropdown open+refresh (3), DOM render (1), keyboard nav (2), Enter/Tab select (2), Esc (1), no-matches Enter close (1), Send-while-open (1), mention_miss (1), click-outside (1), no apiKey leak (1).
  - webview/styles.css: already had `.vsdb-chat-mention-*` hooks from wave 1.
TESTS_ADDED:
  - src/ui/__tests__/aiChatPanelMentions.test.ts: 28 tests
  - src/ui/__tests__/aiChatPanelWebviewTask005.test.ts: 16 tests
VERIFICATION:
  command: npx vitest run src/ui/__tests__/aiChatPanelMentions.test.ts src/ui/__tests__/aiChatPanelPrivacy.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelThoughtRegen.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelResume.test.ts src/ui/__tests__/aiChatPanelWebviewTask005.test.ts
  result: 8 files / 135 tests pass (exit 0)
  output_excerpt: |
    ✓ src/ui/__tests__/aiChatPanelPrivacy.test.ts  (6 tests) 3ms
    ✓ src/ui/__tests__/aiChatPanelMentions.test.ts  (28 tests) 12ms
    ✓ src/ui/__tests__/aiChatPanel.test.ts  (33 tests) 22ms
    ✓ src/ui/__tests__/aiChatPanelWebviewTask005.test.ts  (16 tests) 44ms
    ✓ src/ui/__tests__/aiChatPanelBundle.test.ts  (11 tests) 39ms
    ✓ src/ui/__tests__/aiChatPanelMessages.test.ts  (20 tests) 11ms
    ✓ src/ui/__tests__/aiChatPanelThoughtRegen.test.ts  (10 tests) 25ms
    ✓ src/ui/__tests__/aiChatPanelResume.test.ts  (11 tests) 28ms
    Test Files 8 passed (8)
    Tests 135 passed (135)
  command: npx tsc --noEmit
  result: exit 0 (no output)
  command: npm run compile
  result: dist/webview.js + dist/webview.css regenerated
ISSUES:
  - Earlier webview-source corruption from prior PUT chains (lost `function post`, `const root`, boot block, escapeHtml switch default) — fixed by restoring each via fresh PUTs; final compile + bundle + tests all green.
  - aiChatPanelWebviewTask002.test.ts uses `node_modules/.bin/esbuild` without parent fallback; only runs in parent repo where node_modules exists (verified: 19/19 PASS in parent). TASK-005's own bundle-based test mirrors wave-2's pattern but adds the parent fallback for worktree execution.
  - Enter-on-empty dropdown originally did not dispose the dropdown (the else-branch was comment-only after a copy-paste edit); added the explicit `disposeMentionDropdown()` call.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review


(fix-round note, orchestrator): executor parked twice on infra (worktree esbuild missing). Orchestrator linked node_modules and re-ran verification: 69/69 in worktree, then full main-tree suite 73 files / 1061 tests green, typecheck exit 0. EXECUTOR_MODEL: unic-code (from earlier plan review contract + executor transcript). Copy-back verified: mention contracts in aiChatPanelMessages.ts, parseMentionTokens/resolveMentionsForTurn in aiChatPanel.ts, dropdown in webview/aiChatPanelMain.ts (331 insertions).
