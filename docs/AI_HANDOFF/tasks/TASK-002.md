# TASK-002 — Webview chat UX: thinking block, copy, keybind, scroll, message states

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.2, §3, §4, §7

## Goal

Bring `webview/aiChatPanelMain.ts` to modern AI-chat behavior: render `thought` messages as one collapsible
"Thinking" block (default collapsed); add copy buttons to every code block + a copy action on assistant
messages; replace Ctrl/Cmd+Enter with Enter=send / Shift+Enter=newline; enforce auto-scroll only when near
bottom + a jump-to-latest affordance; show a queued placeholder on the just-sent user bubble, a streaming
caret on the open assistant bubble, and resolve queued/honest-error states cleanly. Regenerate button
posting `{type:"regenerate"}` (button itself styled in TASK-003; wire via the actions row added in
renderInitial so TASK-003 only styles it).

## Target Files

- `webview/aiChatPanelMain.ts` — all rendering + wiring changes. Include:
  (a) `applyThought(text)` → single `#thinkingBlock` (details/summary or div+toggle): label "Thinking",
  default collapsed, chunks append to its body; state (open/closed) survives chunk appends.
  (b) `renderMarkdown` fenced-block branch emits a copy button per block (data-raw on a sibling text node
  or closure — no inline `on*=`); navigator.clipboard.writeText with .catch(() => {}) degrade.
  Copy-message action on assistant bubbles (raw markdown source).
  (c) keydown: `ev.key === "Enter" && !ev.shiftKey` → preventDefault + send; Shift+Enter falls through
  (default newline); plain Enter NEVER inserts a newline.
  (d) scroll discipline: on append/delta, if `scrollTop + clientHeight >= scrollHeight - 40` scroll to
  bottom else show `#jumpLatest` (click → scroll to bottom + hide).
  (e) queued placeholder: on send, user bubble carries a "queued" state element; first delta/error/done
  resolves it; error keeps the honest error bubble (existing `.vsdb-chat-error`).
  (f) streaming caret on the open streaming bubble; removed on done/stop (stopped turns keep partial text —
  existing de-stream path).
  (g) Reset per-turn: new user send collapses thinking block + starts fresh; `done` finalizes it.
  (h) Regenerate button in actions row → `post({ type: "regenerate" })`, disabled while `state.busy`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (bundle, jsdom) | thinking block renders collapsed + appends chunks | After 2 thought msgs: exactly one `.vsdb-chat-thinking` node, no `open` attr / collapsed class, body text === "t1t2"; after `done` block stays visible | bundle of real aiChatPanelMain.ts; dispatch InitMsg → thought×2 → done |
| 2 | edge (state) | thinking state survives append; resets next turn | Toggle open → append chunk → still open; new send → block reset collapsed+empty | same harness, second turn |
| 3 | happy | Enter sends, Shift+Enter newlines | keydown Enter on #prompt → `{type:"send"}` posted + textarea cleared; keydown Shift+Enter → no post, `\n` inserted by default behavior (preventDefault NOT called); plain Enter never inserts newline | bundle; synthetic KeyboardEvent |
| 4 | happy | code-block copy button copies raw code | Assistant msg with one fenced block → exactly one copy button inside rendered markdown; click → clipboard.writeText called with raw code sans fences | clipboard stubbed via navigator.clipboard mock |
| 5 | edge (environment) | clipboard rejection degrades silently | writeText rejects → no unhandled rejection, button label unchanged after revert | clipboard mock rejects |
| 6 | happy | message-level copy on assistant bubble | Copy action present; click → clipboard.writeText with the un-rendered markdown source | assistant msg markdown:true |
| 7 | edge (boundary) | auto-scroll threshold | Thread with scrollHeight > clientHeight: appended delta with scrollTop within 40px of bottom → scrollTo bottom; scrollTop moved 200px up → no scroll, `#jumpLatest` visible; click it → scrolled to bottom, hidden | jsdom scroll metrics stubbed |
| 8 | edge (state) | queued placeholder lifecycle | send → user bubble shows queued marker; then delta → marker gone; separate turn: send → error msg → marker gone + honest error bubble rendered | bundle harness |
| 9 | edge (invariant) | legacy keybind removed | Ctrl/Cmd+Enter no longer posts send | synthetic keydown with ctrlKey/metaKey |
| 10 | regression | agent_thought_chunk kind still never renders via history | HistoryMsg item `{kind:"agent_thought_chunk", ...}` is still dropped by the history branch (no thinking-block reuse from replay) | existing webview #3 pattern |

## Test Files

- `src/ui/__tests__/aiChatPanelWebview.test.ts` — extend (it already bundles the real source via esbuild +
  jsdom; reuse its harness for dispatching HostMsg and clicking elements).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate. No
`npm run compile` prerequisite: this suite bundles `webview/aiChatPanelMain.ts` itself.
(Test selection: target file under `webview/` — no tests-map entry; path convention resolves to the
existing webview bundle suite. Full `npm test` at wave boundary is the regression net.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; RED first for #3/#9 (current code sends on Ctrl/Cmd+Enter only).
- [ ] `npm run typecheck` exits 0.
- [ ] No inline `on*=` handlers introduced (CSP-safe); no new dependencies.
- [ ] Enter never inserts a newline; Shift+Enter never sends (both asserted).
- [ ] Stopped turns keep partial assistant text (regression-safe de-stream path untouched).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (consumes `thought` and `regenerate` message shapes on the wire)

## Interfaces

- Consumes: `AiChatPanelThought { type: "thought"; text: string }` and
  `AiChatPanelRegenerate { type: "regenerate" }` from TASK-001 (exact names/types); existing
  HostMsg union at `webview/aiChatPanelMain.ts:78-88`.
- Produces: DOM ids/classes TASK-003 styles: `#thinkingBlock` (class `vsdb-chat-thinking`, body
  `vsdb-chat-thinking-body`), `#jumpLatest` (class `vsdb-chat-jump`), per-code-block copy button class
  `vsdb-md-copy`, queued marker class `vsdb-chat-queued`, caret class `vsdb-chat-caret`, Regenerate
  button id `regenerateBtn`.

---

## Discussion

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->


## Executor Report
EXECUTOR_TOOL: omp task agent (claude-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecT2 (+ orchestrator finish)
RED_OUTPUT: 19/19 initially RED (16 meaningful failures: no .vsdb-chat-thinking, no copy buttons, no #jumpLatest, no #regenerateBtn, no queued marker, Ctrl+Enter still sent). Excerpt: "expected [{type:'send',text:'ctrl-send'}] to have a length of +0 but got 1".
Verification Output: npx vitest run aiChatPanelWebviewTask002.test.ts aiChatPanelBundle.test.ts aiChatPanel.test.ts aiChatPanelMessages.test.ts aiChatPanelAcp.test.ts -> 103 passed | 11 skipped. npm run typecheck exit 0.
Status: PASS
Note: Executor hit budget at 17/19; orchestrator finished final 2 (restored missing `case "done"` block that had been orphaned after the error case's return — done never re-enabled buttons; error path now also resolves queued marker). All 19 green in main tree.
