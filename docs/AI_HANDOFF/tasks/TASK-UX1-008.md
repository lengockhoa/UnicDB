# TASK-UX1-008 — Chat: pending garble fix + left padding (R9+R10)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 1), §3 (UX1-008)

## Goal

Fix two chat-panel visual defects: (R9) during pending/streaming, text reads as
one-character-per-line vertically before the bubble settles; (R10) assistant bubbles sit
too close to the panel's left border ("dính vô viền"). Fix in
`webview/aiChatPanelMain.ts` (only if a structural cause is confirmed) + `webview/styles.css`
(chat-region selectors ONLY), pinned by CSS-contract tests.

## Target Files

- `webview/styles.css` — ONLY the chat-region blocks: `.vsdb-chat-bubble` (:918),
  `.vsdb-chat-assistant` (:930), `.vsdb-chat-assistant.vsdb-chat-streaming` (:935),
  `.vsdb-chat-thread` (:909), `.vsdb-chat-caret` (:1490). Do NOT touch
  `.vsdb-setfilter-*` (UX1-005) or add `.vsdb-ddl-*` (UX1-010) — region exclusivity per
  PLAN §2.
- `webview/aiChatPanelMain.ts` — ONLY the streaming-caret creation
  (`ensureStreamingCaret`, near :1148) and queued-marker handling (`appendUser` :966 /
  `resolveQueuedUserBubble` :986) if reproduction shows a DOM cause; expected fix is
  CSS-only.
- `src/ui/__tests__/chatLayoutCss.test.ts` — new contract assertions appended.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | streaming bubble cannot collapse to one char per line | `ruleBody('.vsdb-chat-bubble')` (or the streaming compound rule) declares a positive `min-height` (e.g. `1lh`) AND `width: fit-content` AND retains `max-width` ≤ 95% | styles.css read from disk |
| 2 | happy | caret no longer forces its own line box | `.vsdb-chat-caret` rule no longer contains `display: inline-block` (replaced with `display: inline` or equivalent) | same |
| 3 | edge A — newline preservation | streamed multi-line SQL keeps its line breaks | assistant + streaming bubble rules RETAIN `white-space: pre-wrap` (regression guard against a naive `white-space: normal` "fix") | same |
| 4 | edge B — boundary padding | assistant bubbles off the left edge | `.vsdb-chat-assistant` (or `.vsdb-chat-thread`) declares `padding-left ≥ 12px` (or thread margin-left ≥ 8px) | same |
| 5 | edge C — user bubble unaffected | user bubbles stay right-aligned with their own padding | `.vsdb-chat-user` rule still declares `align-self: flex-end` | same |
| 6 | regression | RED on main | cases 1–2 fail against today's styles.css (caret `display: inline-block` at :1491; no min-height/fit-content on bubbles); record RED output in Discussion | current main |
| 7 | edge B — malformed input | streamed fragment with only whitespace + caret renders one thin line, not a tall column | DOM-level unit check: bubble with textContent `" "` + caret span contains no child whose class list forces `display:block`/line break (assert caret is inline after fix) | jsdom: build bubble via appendDelta path or hand-built nodes |

## Test Files

- `src/ui/__tests__/chatLayoutCss.test.ts` — cases 1–6 (append to existing describe set).
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — case 7 ONLY if a DOM-level fix in
  aiChatPanelMain.ts was needed; otherwise omit (note in Discussion).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/chatLayoutCss.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
npm run typecheck && npm run compile
```

Executor runtime check (extension host, once): start a chat turn, observe the pending →
streaming transition; confirm text flows horizontally with the caret inline, and the
assistant bubble no longer touches the left border. Record before/after observation in
Discussion (vision evidence for this request was unusable).

## Acceptance Criteria

- [ ] Cases 1–6 pass; case 6 recorded RED before edits.
- [ ] Only chat-region CSS changed; `git diff -- webview/styles.css` contains no
      `.vsdb-setfilter` / `.vsdb-ddl` / `.vsdb-md` hunks (wave exclusivity with UX1-005,
      UX1-010).
- [ ] Case 3 proves no newline-regression for streamed SQL.
- [ ] Runtime observation note in Discussion.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none (wave-1 region contract — promoted to the operative rule by P2.5 round 1, retiring
  the strict-file-no-overlap fallback: this task's styles.css edits are confined to
  `.vsdb-chat-*` selectors; UX1-005 owns `.vsdb-setfilter-*`, UX1-010 appends only the new
  `.vsdb-ddl-*` block — disjoint selector families, P3 merge conflict-free.)

## Interfaces

- Consumes: `.vsdb-chat-*` CSS region (webview/styles.css:887-1000, 1472-1500);
  `ensureStreamingCaret` / `appendDelta` / `resolveQueuedUserBubble`
  (webview/aiChatPanelMain.ts:1128-1175, 966-1000); `ruleBody()` test pattern
  (chatLayoutCss.test.ts).
- Produces: bubble layout contract (min-height + fit-content + pre-wrap preserved + caret
  inline) that UX1-009's streamed-markdown re-render (appendDelta changes) must keep
  green — UX1-009 depends on these selectors not being re-broken.

---

## Discussion

### 2026-09-04 · planner · unic-smart
Vision receipts: one chat screenshot's receipt parsed OK but its textContent reads as
garbled/partial ("K | hi tôi về việc chữ v …"), the rest unrelated — so the mechanism is
code-derived: `.vsdb-chat-bubble` uses `white-space: pre-wrap` and the caret is
`display: inline-block` (styles.css:1491); an inline-block atom at a wrap boundary drops
to its own line, and during the pre-first-delta phase only the queued dot occupies the
assistant side — narrow panels then show vertical one-char-per-line text. The pinned
contract (cases 1–4) asserts the observable outcome, not specific properties, so the
executor may swap the exact fix if reproduction shows a different cause, provided
equality/layout contracts stay green. If the real cause turns out structural (e.g. the
thread's flex column), fix it in aiChatPanelMain.ts within the declared regions and note
the finding here.
