# TASK-UX1-009 — Chat: "AI is thinking…" row + streamed code blocks (R11)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 2), §3 (UX1-009)

## Goal

Two chat-loading/response gaps: (a) the only loading affordance is a 6px dot on the
QUEUED USER bubble — the user wants a plain assistant-side "AI is thinking…" line with a
spinning icon while the turn runs; (b) fenced code blocks only format on the TERMINAL
assistant message, so streamed SQL arrives as one long unboxed line — re-render the
streaming bubble through the existing markdown pipeline once a fence closes. Copy buttons
and boxed code ALREADY exist (`renderMarkdown` + `wireCopyButtons`); this task finishes
the streaming-side gaps and locks truncation.

## Target Files

- `webview/aiChatPanelMain.ts` — (a) new `appendThinking()` / `removeThinking()` pair
  rendering a `.vsdb-chat-thinking-row` (spinner glyph + text "AI is thinking…"), invoked
  on send, removed on first delta / error / done (lifecycle mirrors
  `resolveQueuedUserBubble`, :986); (b) in `appendDelta` (:1128): if the accumulated
  bubble text contains a closed fence, re-render that bubble via `renderMarkdown`
  (escapes first) + `wireCopyButtons`; (c) preserve `data-raw` copy contract on re-render.
- `webview/styles.css` — append chat-region rules: `.vsdb-chat-thinking-row` (spinner via
  CSS animation) + `overflow-wrap: anywhere` on `.vsdb-chat-bubble`. Modify NO other
  selector blocks (`.vsdb-chat-*` region shared with UX1-008 — wave 2, no overlap since
  UX1-008 is wave 1).
- `src/ui/__tests__/aiChatPanelBundle.test.ts` — bundle-level tests (requires
  `npm run compile` first).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | send shows thinking row; first delta removes it | after send, thread contains `.vsdb-chat-thinking-row` with text `AI is thinking…`; after first `{type:"delta"}` post the row is gone | bundle loaded in jsdom; stubbed acquireVsCodeApi (existing bundle harness) |
| 2 | happy | closed fence mid-stream renders boxed code with copy button | send delta chunks ending with a closed ```` ``` ```` fence → bubble contains `pre.vsdb-md-code` + `button.vsdb-md-copy`; clicking the button copies the raw code (data-raw un-escape path) | bundle harness; clipboard stub |
| 3 | edge A — unterminated fence | open fence mid-stream stays plain text | after a delta containing ```` ```sql\nSELECT 1 ```` (no closing fence) the bubble contains NO `pre.vsdb-md-code`; after the closing-fence delta it does (exactly once) | bundle harness |
| 4 | edge B — error/done settles thinking | `{type:"error"}` or terminal assistant message removes the thinking row | row absent after either terminal post; no orphaned spinner | bundle harness |
| 5 | edge B — malformed input safety | hostile streamed content never becomes live HTML | streamed `<img src=x onerror=...>` + fenced payload → no element with tag `img` inside the bubble (escape-first contract preserved through re-render) | bundle harness |
| 6 | edge C — re-render idempotence | repeated deltas over a closed fence do not duplicate copy buttons | after 3 subsequent deltas, bubble contains exactly one `.vsdb-md-copy` per fenced block | bundle harness |
| 7 | regression | queued user bubble lifecycle unchanged | existing queued-marker tests (bundle test #8 region) still pass; user bubble still resolves on first delta | existing suite |
| 8 | regression | truncation contract | `ruleBody('.vsdb-chat-bubble')` contains `overflow-wrap: anywhere` (chatLayoutCss pattern) | styles.css from disk |

## Test Files

- `src/ui/__tests__/aiChatPanelBundle.test.ts` — cases 1–7 (append to existing bundle
  describe set).
- `src/ui/__tests__/chatLayoutCss.test.ts` — case 8 (one assertion appended).

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/chatLayoutCss.test.ts
npm run typecheck && npm run compile
```

(Bundle tests read `dist/aiChatPanel.js` — the initial `npm run compile` is REQUIRED
before the first vitest run; the trailing typecheck+compile re-verifies the final state.)

## Acceptance Criteria

- [ ] Cases 1–8 pass.
- [ ] No CDN/external assets: spinner is pure CSS (project constraint — minimal-markdown
      pipeline has no dependencies).
- [ ] Escape-first contract intact (case 5) — reviewer checks this specifically.
- [ ] UX1-008's bubble layout contract (min-height/fit-content/pre-wrap) still green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-UX1-002 (wave-2 ordering; no code dependency — its `Dependencies` edge exists to
  keep wave-2 lanes non-overlapping; this task shares no file with UX1-002 and may start
  as soon as a lane frees).

## Interfaces

- Consumes: `renderMarkdown(text)` (aiChatPanelMain.ts:418 — escape-first, fenced-block
  placeholder pipeline, `data-raw` attribute contract); `wireCopyButtons(rootEl)` (:1291);
  `appendDelta` streaming bubble (:1128); `resolveQueuedUserBubble` lifecycle (:986);
  bundle-test harness (aiChatPanelBundle.test.ts `loadBundle()`).
- Produces: `.vsdb-chat-thinking-row` DOM contract + streaming re-render on closed fence —
  the UX guide (UX1-004) documents the thinking affordance and copy button for users.

---

## Discussion

### 2026-09-04 · planner · unic-smart
P1's description of R11 as "add a copy button" is already satisfied — `vsdb-md-copy` ships
today (aiChatPanelMain.ts:455, wired at :1291, styled at styles.css:1455). Verified gaps
are exactly (a) the missing assistant-side thinking affordance and (b) streaming deltas
bypassing `renderMarkdown` until the terminal message. The mid-stream re-render is safe
because `renderMarkdown` escapes before injecting and the `data-raw` attribute round-trips
the raw code for copy; re-render must preserve UX1-008's layout contract (dependencies
edge is conceptual, but keep both suites green together at P3 merge).

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (7 of 8 new tests failed before implementation; #7 was a regression guard already green)
Verification Output: chatLayoutCss.test.ts 31/31 + aiChatPanelBundle.test.ts 28/28 after rebuild; full suite 3484|2 (baseline 3469|2, +8 net from UX1-009); typecheck + compile clean
Status: PASS
Note: Test infra fix to loadBundle() (listener teardown) was required to isolate state across sequential tests within the file — no production-bundle changes for that.
