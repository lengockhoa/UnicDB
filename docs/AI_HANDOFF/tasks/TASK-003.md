# TASK-003 — Chat layout: pinned composer, full-height thread (CSS)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.3, §3, §4, §7

## Goal

Fix the "input in the middle" bug: make the chat panel a full-height flex column — `.vsdb-chat-thread`
grows (`flex: 1`) and scrolls; `.vsdb-chat-input` pins to the bottom edge. Kill the `max-height: 60vh` cap
(`webview/styles.css:902-909`). Style the TASK-002 affordances (thinking block, jump-to-latest, copy
buttons, queued marker, caret, Regenerate button) consistently with the existing bubble styles.

## Target Files

- `webview/styles.css` — replace `.vsdb-chat-thread` cap with full-height flex growth; extend the
  `.vsdb-chat` shell (`src/ui/aiChatPanel.ts:1486`) to `display:flex; flex-direction:column; height:100%`
  so the composer pins to the panel bottom; keep `.vsdb-form-body` usable by other forms (scope overrides
  to `.vsdb-chat`). Add styles for: `.vsdb-chat-thinking` (+`-body`), `.vsdb-chat-jump`,
  `.vsdb-md-copy`, `.vsdb-chat-queued`, `.vsdb-chat-caret`, `#regenerateBtn`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug) | 60vh cap removed, thread flexes | RED against current CSS, GREEN after: `.vsdb-chat-thread` rule block in webview/styles.css declares `flex: 1` (or `flex: 1 1 auto`) and contains NO `max-height: 60vh`; `.vsdb-chat` declares `display: flex`, `flex-direction: column`, `height: 100%` | CSS contract test parsing styles.css |
| 2 | happy | composer pinned | `.vsdb-chat-input` remains a flex child AFTER the thread with no `position: absolute`; margin/visual order thread→input preserved in stylesheet order | same test file |
| 3 | edge (boundary) | caret visible on streaming bubble | `.vsdb-chat-caret` (or `.vsdb-chat-assistant.vsdb-chat-streaming::after`) exists with a non-empty `content` and `display` ≠ `none` | streaming class from TASK-002 |
| 4 | edge (scope) | other forms unaffected | `.vsdb-form-body`/`.vsdb-form` rules untouched by diff: no rule targeting bare `.vsdb-form-body` is added/modified; new rules all scoped under `.vsdb-chat` | full-file parse |

## Test Files

- `src/ui/__tests__/aiChatPanelChatLayout.test.ts` — (new) reads `webview/styles.css` and asserts the
  contract above (pure string/regex parse of rule blocks; same style as CSS contract checks used in
  bundle tests — no browser needed).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelChatLayout.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate. No
`npm run compile` prerequisite: the test reads `webview/styles.css` directly.
(Test selection: target file `webview/styles.css` — no tests-map entry; falls to the mandatory non-empty
floor via a purpose-built single test file. Full `npm test` at wave boundary is the regression net.)

## Acceptance Criteria

- [ ] Test #1 is RED before the CSS change and GREEN after (paste both outputs in Executor Report).
- [ ] Every test in §Test Cases passes; `npm run typecheck` exits 0.
- [ ] Visual layout: thread fills panel height, composer at bottom (smoke: open AI Chat panel in VS Code
  host or `code --extensionDevelopmentPath`; report observed — cannot screenshot in CI).
- [ ] No rule outside the `.vsdb-chat` scope modified.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — pure CSS + new test file; no source-file overlap with TASK-001/002 (they own .ts files).
  Styling targets TASK-002's DOM contract (`#thinkingBlock` etc.) but does not modify it.

## Interfaces

- Consumes: DOM contract from TASK-002 §Interfaces: ids `#thinkingBlock`, `#jumpLatest`,
  `#regenerateBtn`; classes `vsdb-chat-thinking`, `vsdb-chat-thinking-body`, `vsdb-md-copy`,
  `vsdb-chat-queued`, `vsdb-chat-caret`.
- Produces: (none) — leaf styling task.

---

## Discussion

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
