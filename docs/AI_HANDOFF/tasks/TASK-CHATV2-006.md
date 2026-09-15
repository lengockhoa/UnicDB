# TASK-CHATV2-006 — Stable transcript and safe streaming renderer

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§3,6,8

## Goal
Replace bubble-by-append logic with keyed transcript rendering that updates one assistant node per message, safely renders Markdown and preserves partial output on stop.

## Target Files
- `webview/aiChat/transcript.ts` — new keyed renderer and message actions.
- `webview/aiChat/markdown.ts` — extract/reuse escape-first Markdown primitives if current renderer is embedded.
- `webview/aiChatPanelThread.ts` — compatibility exports only; deletion disposition for 017.
- `webview/aiChat/__tests__/transcript.test.ts` — streaming, XSS, actions, cap tests.
- `webview/__tests__/markdownSafe.test.ts` — preserve hostile Markdown coverage.

## Required Work / Exact Spec
Render by `messageId` into stable DOM nodes; `renderTranscript(state, refs)` diffs logical items or updates only changed item. Never delete streaming node then append a terminal duplicate. Maintain raw assistant source in reducer state, not DOM dataset. Coalesce stream paint with requestAnimationFrame and maximum 100ms fallback; finalize exactly once.

User bubble: align right, max-width 78%, padding 8px 12px, radius `12px 12px 4px 12px`, 13/20px. Assistant answer: unboxed max 880px/92%, 4px 0; narrow width becomes 100% minus 8px margins. Preserve whitespace/RTL/long unbroken SQL with wrapping and code horizontal scroll.

Only assistant Markdown enters existing escape-first renderer. User, path, tool, model, error and action labels use textContent. SQL highlighting continues through DOM fragments/textContent. No user/provider string is assigned raw to innerHTML. Links, if existing renderer permits them, must retain safe scheme filtering and no script/event attributes.

Message actions: user Copy/Edit/Retry; assistant Copy/Regenerate/More and Insert SQL only when a parsed SQL fenced block exists. Buttons 28×28, title+aria-label, visible on hover and `:focus-within`. Controller callbacks carry stable IDs and raw safe source, never scrape innerText. Clipboard success says `Copied`; rejection says `Could not copy` in polite toast.

Stop retains partial answer and adds muted `Stopped` footer; terminal finalization removes caret once. Streaming caret is decorative. Empty delta is ignored. Duplicate terminal frame does not duplicate action row/footer. Viewport model renders <=200 message units and offers `Load earlier messages`; no browser persistence.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | DOM | stable streaming item | many deltas + final retain one node/messageId |
| 2 | security | hostile payload matrix | scripts/attributes remain text; no executable node |
| 3 | edge | empty/duplicate terminal | no blank/duplicate bubble/action row |
| 4 | regression | stopped partial text | text remains, caret gone, Stopped footer and regenerate enabled |
| 5 | edge | clipboard rejection | accessible failure toast, no silent catch |
| 6 | boundary | 201+ items | <=200 message DOM units plus load-earlier control |
| 7 | content | SQL action | appears only for SQL fence and returns exact raw SQL |

## Test Files
- `webview/aiChat/__tests__/transcript.test.ts`
- `webview/__tests__/markdownSafe.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/transcript.test.ts webview/__tests__/markdownSafe.test.ts webview/__tests__/aiChatPanelThread.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Streaming and final output share one stable node and ID.
- [ ] XSS fixtures cannot create active DOM.
- [ ] Actions are keyboard accessible and callback-driven, not DOM-scraped.
- [ ] Stop and 200-item cap behavior match contract.

## Dependencies
- TASK-CHATV2-004, TASK-CHATV2-005

## Interfaces
- Consumes: transcript entities/order from `ChatViewState`, shell refs, safe Markdown/highlight primitives.
- Produces: `createTranscriptRenderer(refs, callbacks)` with `render(state)`/`dispose()` for 007/015/016.

## Discussion
(no comments yet)

## Progress

- 2026-09-16T02:09:56+0700 · milestone: markdown primitives · last-green: `npx vitest run webview/__tests__/markdownSafe.test.ts` 19/19 pass · files: webview/aiChat/markdown.ts, webview/__tests__/markdownSafe.test.ts · drift: none
- 2026-09-16T02:12:16+0700 · milestone: transcript renderer · last-green: `npx vitest run webview/aiChat/__tests__/transcript.test.ts` 17/17 pass · files: webview/aiChat/markdown.ts, webview/__tests__/markdownSafe.test.ts, webview/aiChat/transcript.ts, webview/aiChat/__tests__/transcript.test.ts · drift: none
- 2026-09-16T02:12:44+0700 · milestone: thread compatibility exports · last-green: targeted suite 61/61, `npm run typecheck`, `npm run compile` all pass · files: webview/aiChat/transcript.ts, webview/aiChat/__tests__/transcript.test.ts, webview/aiChatPanelThread.ts · drift: none
- 2026-09-16T02:14:20+0700 · milestone: styles + final verification · last-green: targeted suite 64/64, typecheck clean, compile clean, webview+ui lane 2004 tests pass · files: webview/aiChat/styles.css, webview/aiChat/__tests__/transcript.test.ts · drift: webview/aiChat/styles.css is not a declared Target File but the task hard-constraint ("scoped CSS") and PLAN §6 geometry require the new renderer's rules to live in the V2-scoped stylesheet owned by TASK-CHATV2-005.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
RED_OUTPUT: Files were written incrementally in four milestones (markdown primitives, transcript renderer, thread exports, styles). Real RED was observed inside the transcript suite during milestone 2 — first run 14 passed / 3 failed:
  - `never assigns raw provider text to innerHTML anywhere in the tree` — AssertionError: expected `...` not to contain `<svg` (my assertion was wrong: decorative icon SVGs are legitimate; rewrote to assert no event attribute / no provider-derived element node instead).
  - `announces Copied on success through the polite status region` — AssertionError: expected `''` to be `Copied` (Promise jobs had not drained with `await Promise.resolve()`; switched to a macrotask `settle()`).
  - `announces Could not copy in the alert region on rejection` — same async-flush cause; fixed with `settle()`.
  A fourth RED surfaced after the first two fixes: `expected '...' not to contain 'onload'` — the payload text `onload` legitimately survives as escaped text; replaced the over-broad innerHTML substring check with an element-attribute assertion.

Verification Output:
```
$ npm test -- --run webview/aiChat/__tests__/transcript.test.ts webview/__tests__/markdownSafe.test.ts webview/__tests__/aiChatPanelThread.test.ts
 ✓ webview/__tests__/markdownSafe.test.ts  (19 tests) 14ms
 ✓ webview/__tests__/aiChatPanelThread.test.ts  (25 tests) 21ms
 ✓ webview/aiChat/__tests__/transcript.test.ts  (20 tests) 166ms
 Test Files  3 passed (3)
      Tests  64 passed (64)

$ npm run typecheck
> tsc --noEmit
(exit 0, no errors)

$ npm run compile
  dist/aiChatPanel.css  14.9kb
esbuild: build complete
(exit 0)

# broader regression lane (vitest run webview src/ui)
 Test Files  5 failed | 144 passed (149)
      Tests  2004 passed (2004)
```
The 5 file-level failures in the broad lane are environmental only: `spawnSync .../.worktrees/task-chatv2-006/node_modules/.bin/esbuild ENOENT` in `src/ui/__tests__/aiChatPanelWebview*.test.ts` (they exec the worktree's uninstalled esbuild binary). Zero test assertions failed; all 2004 tests passed.

Status: PASS
Note: `webview/aiChat/styles.css` was touched beyond the declared Target Files list; rationale recorded in the Progress drift field. No new dependency, no version bump, no publish. `node_modules` is not installed inside the worktree, so bundle-exec tests that spawn the local esbuild binary cannot run there — this is a worktree setup gap, not a regression from this task.

## Executor Report (returned summary)

TASK: TASK-CHATV2-006
STATUS: PASS
EXECUTOR_MODEL: bao-sonnet
FILES: webview/aiChat/transcript.ts, webview/aiChat/markdown.ts, webview/aiChatPanelThread.ts, webview/aiChat/styles.css, webview/aiChat/__tests__/transcript.test.ts, webview/__tests__/markdownSafe.test.ts
RED: confirmed
VERIFY: 3 commands, all pass
NOTE: webview/aiChat/styles.css touched beyond declared Target Files (scoped rules required by hard constraint); rationale in Progress drift.
