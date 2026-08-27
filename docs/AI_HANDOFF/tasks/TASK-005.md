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
