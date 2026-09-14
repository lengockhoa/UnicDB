# Fact-base (webview layer) — AI-chat spec rewrite

Raw research input for TASK-AICHAT-004. Facts only, no spec prose. Every claim carries a
`webview/<file>.ts:<line>` anchor. Source read at commit on branch `handoff/task-aichat-001`
(composer 579 lines, header 170, thread 415, main 2264). Baseline description under test:
`docs/AI_CHAT_REDESIGN.md` §Source anchors (line 67) and §Composer contract.

---

## 1. Draft anchor verdicts

Format: `webview/<file>.ts:<start>–<end>` — verdict — verbatim quote from inside the range.

### webview/aiChatPanelComposer.ts:496–504 — confirms
Draft text: "Composer keyboard behavior is split between `webview/aiChatPanelComposer.ts:496–504` …".
Actual content: the composer's own bubble-phase `keydown` listener implementing Enter=send with a
Shift+Enter newline exemption.
Quote: `// Enter-to-send (Shift+Enter for newline) — mirrors Claude Code behavior.` (line 496)
and `if (ev.key === "Enter" && !ev.shiftKey) {` (line 498).
Note: the Shift guard lives HERE only. See §3 and gap G1 for the capture-phase branches that lack it.

### webview/aiChatPanelComposer.ts:441–457 — confirms
Draft text: "Slash toolbar insertion currently changes textarea.value directly at
`webview/aiChatPanelComposer.ts:441–457`."
Actual content: the `slashHintBtn` click handler that splices `"/"` into the textarea at the caret.
Quote: `const next = cur.slice(0, start) + "/" + cur.slice(end);` (line 448) followed by
`prompt.value = next;` (line 449). The handler then focuses and calls `setSelectionRange`
(lines 451–453) inside a try/catch.
Note: this path writes the DOM textarea value directly and never notifies a host-side model
(contrast the main-side slash path at `webview/aiChatPanelMain.ts:864–866`, which pairs
`prompt.value = next` with `composer?.setValue(next)`). See gap G3.

### webview/aiChatPanelMain.ts:792–895 — confirms
Draft text: "…capture-phase handling in `webview/aiChatPanelMain.ts:792–895`."
Actual content: `prompt?.addEventListener("keydown", (ev) => { … }, true)` — the capture-phase
listener that runs before the composer's bubble listener.
Quote: `// Listener is attached in the CAPTURE phase (third arg = true) so it` (line 786) and the
third argument `true,` at line 894. The range covers Ctrl/Meta+Enter suppression (801–810),
mention-dropdown Enter/Tab/Escape/Arrows (811–843) and slash-dropdown Escape/Arrows/Tab/Enter
(844–892).

### webview/aiChatPanelMain.ts:907–931 — confirms
Draft text: "Mention discovery currently uses keyup and sends query-only requests in
`webview/aiChatPanelMain.ts:907–931`."
Actual content: the `keyup` listener that recomputes the trailing `@…` span and posts the request.
Quote: `prompt?.addEventListener("keyup", (ev: KeyboardEvent) => {` (line 907) and
`post({ type: "mention_list", query });` (line 930). The request object carries only `type` +
`query` — no request id, no caret/sequence token. The listener body's closing `});` is at line
932 (one line past the cited end); content of 907–931 matches the draft exactly.

### webview/aiChatPanelMain.ts:629–640 — confirms
Draft text: "Current export serializes rendered thread innerText and immediately announces
success at `webview/aiChatPanelMain.ts:629–640`."
Actual content: `function exportTranscript(filename?: string)` — reads `#thread`, serializes to a
Blob, triggers a client-side download, and appends a local success notice.
Quote: `const text = thread?.innerText?.trim() ?? "";` (line 631) and
``appendLocalNotice(`Transcript exported as ${safeName}`);`` (line 640). The function closing
brace is at line 641. No host round-trip and no host confirmation exists in this path.

**Verdict summary:** all 5 cited ranges resolve to the draft's description (`confirms` x5); zero
ranges required a `corrects` verdict, and zero verdict lines were emitted without a
`confirms`/`corrects` token.

---

## 2. File inventory (Glob sweep)

Glob `webview/*.ts` filtered case-insensitively on `chat` returns exactly four files, matching
the task's known set; no additional sibling chat file exists.

| File | Lines | Role |
|------|-------|------|
| `webview/aiChatPanelComposer.ts` | 579 | Sticky composer: attach strip, multiline textarea `#prompt`, chip menu, slash-affordance button, bypass toggle, send/stop. Exports `renderComposer` + `UnicDBComposer`. |
| `webview/aiChatPanelHeader.ts` | 170 | Pure-DOM header bar: brand glyph, static title, `#engineBanner`, `#sessionChip`. Exports `renderHeader`; installs no listeners. |
| `webview/aiChatPanelThread.ts` | 415 | Extracted pure-DOM thread builders + usage chip. Takes the mount node as an argument; class layout is the newer `chat-msg-*` set. |
| `webview/aiChatPanelMain.ts` | 2264 | Entry + message router: wires header/composer, owns slash + mention + streaming + export state, imports renderers from `src/ui/aiChatPanelCommands.ts`. |

Sweep notes (negative results recorded):
- `ls webview/ | grep -iE 'chat'` → only the four files above.
- `ls webview/ | grep -E '^aiChat'` → only the four files above.
- `webview/aiSettingsFormMain.ts` (454 lines) is NOT a chat webview — AI settings form, no
  composer/thread/message-router role.
- Host-side, non-webview chat modules live under `src/ui/` (`aiChatPanel.ts`,
  `aiChatPanelMessages.ts`, `aiChatPanelCommands.ts`, `aiChatAttachments.ts`) — outside this
  layer's write scope and listed here only to bound the sweep.
- `webview/aiChatPanelThread.ts` is currently imported by NO production module: grep for
  `aiChatPanelThread` outside `webview/__tests__/` returns only its own file plus comment
  references in `webview/aiChatPanelMain.ts:5`, `webview/markdownSafe.ts:4-5`. The thread
  renderers actually used at runtime are the inline copies in `webview/aiChatPanelMain.ts`
  (`appendUser`/`appendAssistant`/`appendDelta`/…). See gap G5.

---

## 3. Behavior inventory

### 3a. Keyboard handling
- Composer Enter=send, Shift+Enter=newline: `webview/aiChatPanelComposer.ts:497–504`, guarded by
  `!ev.shiftKey` at line 498.
- Capture-phase interceptor on the same `#prompt` target: `webview/aiChatPanelMain.ts:792–895`.
  - Ctrl/Cmd+Enter is suppressed (no send) when no dropdown is open: lines 801–810.
  - Mention-dropdown branch: Enter or Tab select/close (812–827); Escape closes (828–832);
    ArrowDown/ArrowUp move the active row (833–842).
  - Slash-dropdown branch: Escape closes (845–849); ArrowDown/ArrowUp wrap the active index
    (850–858); Tab fills the textarea with `/<cmd> ` + `composer.setValue` (859–871); Enter
    executes-or-fills (872–891).
  - Neither the mention Enter/Tab branch (812–827) nor the slash Enter branch (872–891) inspects
    `ev.shiftKey` before calling `preventDefault()` + `stopImmediatePropagation()`.
- No `compositionstart`/`compositionend`/`isComposing` handling exists anywhere in the four chat
  files (grep for `composition|isComposing` returns zero hits). IME composition Enter is treated
  as a plain Enter on every path.
- Chip menu Escape/outside-click: `webview/aiChatPanelComposer.ts:479–494`.

### 3b. Slash menu
- Candidate source: `AI_CHAT_COMMANDS` imported from `src/ui/aiChatPanelCommands.ts` at
  `webview/aiChatPanelMain.ts:27–30`; parser `parseAiChatCommand` at the same import.
- Open/refresh driven by the `input` listener: `webview/aiChatPanelMain.ts:897–900` →
  `updateSlashDropdown` (607–616). Filtering is a case-insensitive `startsWith` on the text after
  `/`; invalid/whitespace-broken input disposes the dropdown (609–611).
- Render: `renderSlashDropdown` (574–605) — rows are `<button role="option">`; row click writes
  `prompt.value = ` then `prompt.focus()` (595–599).
- Execute/insert on Enter: `webview/aiChatPanelMain.ts:872–891`; `executeSlashCommand`
  (643–671) switches on `clear|resume|context|export|engine|model`.

### 3c. Mention menu
- Detection is `keyup`-only: `webview/aiChatPanelMain.ts:907–932`. The `input` listener at
  897–900 explicitly returns early when `mentionOpen` is true (898), so mention refresh does not
  ride the `input` event.
- Span finder: `findAtTokenStart` (293–303) walks back from the caret within `[\w.\-/]` and
  returns the `@` index or -1.
- Request: `post({ type: "mention_list", query })` (930) — query string only.
- Response handling: `mention_objects` caches `msg.items` and filters with the current
  `mentionQuery` (`webview/aiChatPanelMain.ts:2027–2032`); `mention_miss` renders a miss row
  (2033–2035). Rows carry the token via a `data-token` attribute set in
  `renderMentionDropdown` (line 341), and the Enter/Tab branch reads that attribute back at
  lines 819–822.
- Selection/insert: `selectMentionToken` (437–459) splices `@<token> ` over the partial span and
  closes the dropdown.

### 3d. Chips
- Model chip + dropdown: `webview/aiChatPanelComposer.ts:209–213` (`#modelChipMenu` markup),
  `300–360` (render/open/close), click handler 459–466. Chip click posts `model_select`
  (`webview/aiChatPanelMain.ts:717–719`).
- Active-schema chip: click → `onPickSchema` → host `pickActiveSchema`
  (`webview/aiChatPanelComposer.ts:468–476`; `webview/aiChatPanelMain.ts:737–738`); inbound
  `schemaChanged` forwards to `composer.setActiveSchema` (`webview/aiChatPanelMain.ts:2051–2058`).
- Session-state chip: `webview/aiChatPanelMain.ts:1539–1557` delegating to the header controller;
  `textContent`-only.
- Usage/policy chip: `renderUsageChip`-style path at `webview/aiChatPanelMain.ts:1559–1601`
  (`#usageChip`, `textContent`-only join of parts).
- Grounding strip/chip: `renderGroundingChips` (`webview/aiChatPanelMain.ts:2229–2252`), strip
  id `#UnicDB-grounding-strip`, click posts `grounding_toggle` (2243).

### 3e. Streaming render path
- Carrier message type: `delta` — interface at `webview/aiChatPanelMain.ts:72–77`, switch case at
  1964–1966 calling `appendDelta(msg.text)`.
- Renderer: `appendDelta` (`webview/aiChatPanelMain.ts:1272–1320`). It resolves the queued user
  placeholder, settles the thinking row, finds or creates
  `.UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming` (1280–1288), appends the
  fragment as a text node (1292), accumulates raw text in `bubble.dataset.UnicDBRawStream`
  (1309–1311), and re-renders via `renderMarkdown` once a complete ` ```…``` ` fence is present
  (1312–1317). A streaming caret is maintained by `ensureStreamingCaret` (1318).
- Terminal message: `assistant` (case 1976–1991) removes the streaming bubble, settles thinking,
  and calls `appendAssistant(msg.text, msg.markdown)` (1223–1248), which does the final markdown
  render + SQL highlight + copy buttons.
- Turn-close: `done` (1999–2014) calls `deStreamOpenBubble` (1328–1342) and `setBusy(false)`;
  `error` (1992–1998) calls `appendError` + `deStreamOpenBubble`.
- Other incremental carriers on the same `message` listener: `step` → `appendStep`
  (1955–1957), `tool_result` → `appendToolResult` (1958–1960), `thought` → `applyThought`
  (2015–2017). These are not assistant text chunks; only `delta` feeds the streaming bubble.
- Host-side shape: `src/ui/aiChatPanelMessages.ts:78` declares the `delta` variant (out of this
  layer's scope; cited to locate the carrier).

### 3f. Export
- Command entry: `/export` → `executeSlashCommand` case `export` (663–665) → `exportTranscript`.
- Implementation: `webview/aiChatPanelMain.ts:629–641`. Serializes `#thread` `innerText`
  (631), builds a Blob + object URL, clicks a synthetic `<a download>` (633–639), revokes the URL,
  then announces success locally (640). No host message is posted on this path and no host
  confirmation is awaited.

---

## 4. Gap list (concrete, anchored)

- **G1 — Shift not excluded in the menu Enter branches.**
  `webview/aiChatPanelMain.ts:812` (`if (ev.key === "Enter" || ev.key === "Tab")`) and
  `webview/aiChatPanelMain.ts:872` (`if (ev.key === "Enter")`) call `preventDefault()` +
  `stopImmediatePropagation()` without checking `ev.shiftKey`. The composer's contract at
  `webview/aiChatPanelComposer.ts:498` only exempts Shift on the bubble-phase handler, which the
  capture branch above suppresses. Net effect: Shift+Enter while a mention or slash dropdown is
  open is consumed by the dropdown, not inserted as a newline. An always-newline contract needs a
  specific controller change + regression test here.

- **G2 — Mention request is query-only (no correlation id).**
  `webview/aiChatPanelMain.ts:930` posts `{ type: "mention_list", query }`. The handler caches
  whatever `mention_objects` arrives and filters by the current `mentionQuery`
  (`webview/aiChatPanelMain.ts:2027–2032`). There is no request/response id, so out-of-order or
  late host replies cannot be discarded — the last-arrived list always wins. Detection is also
  `keyup`-only (`webview/aiChatPanelMain.ts:907`), so IME composition and paste-driven `@` edits do
  not refresh the dropdown.

- **G3 — Slash toolbar writes `textarea.value` directly (bypasses the composer model).**
  `webview/aiChatPanelComposer.ts:449` sets `prompt.value = next` inside the `slashHintBtn` click
  handler (441–457) without calling `composer.setValue` or posting anything. The main-side slash
  fill path does both: `webview/aiChatPanelMain.ts:864–866` pairs `prompt.value = next` with
  `composer?.setValue(next)`. Two writers, inconsistent notification.

- **G4 — Export announces success without host confirmation.**
  `webview/aiChatPanelMain.ts:640` appends `Transcript exported as …` immediately after the
  synthetic-download click, with no host round-trip. The serialized payload is rendered
  `innerText` (631), i.e. lossy vs. the structured turn list, and the success text is asserted
  locally.

- **G5 — Thread builder module is dead code vs. the inline renderers.**
  `webview/aiChatPanelThread.ts` (415 lines) is imported by no production module (only its tests).
  The runtime thread renderers are the inline copies in `webview/aiChatPanelMain.ts`
  (`appendUser` 1001, `appendAssistant` 1223, `appendDelta` 1272, `appendError` 1250,
  `appendStep` 1086, `appendToolResult` 1110, `appendChangePlan` 1158). Any spec that references
  "the thread module" must say which copy it means.

- **G6 — No IME/composition guard.**
  `webview/aiChatPanelComposer.ts:497` and `webview/aiChatPanelMain.ts:792` both key off raw
  `Enter` with no `ev.isComposing`/`compositionend` check (zero `composition` hits across the four
  chat files). Composing Enter can fire send or dropdown-select on IME languages.

- **G7 — Ctrl/Cmd+Enter suppression is dropdown-state-dependent.**
  `webview/aiChatPanelMain.ts:801–810` suppresses Ctrl/Meta+Enter only while `!mentionOpen &&
  !slashOpen`. With a dropdown open, Ctrl+Enter falls through to dropdown handling rather than
  being a distinct shortcut.

- **G8 — Mention Enter/Tab fallback closes the dropdown silently on a missing token.**
  `webview/aiChatPanelMain.ts:819–825`: if the active row's token attribute is absent or empty the
  code disposes the dropdown; with an empty-result dropdown (`webview/aiChatPanelMain.ts:318–331`,
  "No matches" row has no token attribute) Enter simply closes it and inserts nothing.

---

## 5. Open questions for TASK-AICHAT-004

1. Which Shift+Enter behaviour is normative when a menu is open — newline insertion while keeping
   the menu open, or menu-select regardless of Shift? The capture branch currently wins and must
   be changed either way (G1).
2. Should mention requests carry a correlation id/turn token, and should detection move to `input`
   + compositionend (G2, G6)? What is the accepted behaviour when a late reply arrives after the
   user already changed the query?
3. Which single write path is authoritative for slash insertion — composer-local DOM write or
   main-side `prompt.value` + `composer.setValue` (G3)?
4. Does the structured transcript export need a host-side write acknowledgement, and what does the
   UI show on failure (G4)?
5. Is `webview/aiChatPanelThread.ts` the intended renderer for the rewrite, with the inline copies
   in `webview/aiChatPanelMain.ts` deleted (G5)?

---

## Verification log (this note)

Commands from §Verification Commands (TASK-AICHAT-001), run in worktree
`/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-aichat-001`:

- Pre-write (RED): the anchor-verdict loop aborted at
  `MISSING VERDICT: aiChatPanelComposer\.ts:496[–-]504` because the note did not exist yet.
- Post-write: see the task's `## Executor Report` for the full green transcript.
