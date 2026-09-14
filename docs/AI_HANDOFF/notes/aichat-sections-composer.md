# Section drafts — composer keyboard / slash / mention / autocomplete geometry+a11y

TASK-AICHAT-004 deliverable. Consolidated replacement drafts for the interaction half of
`docs/AI_CHAT_REDESIGN.md`. Consumes the verified fact-bases
`aichat-factbase-webview.md` (TASK-AICHAT-001), `aichat-factbase-host.md` (TASK-AICHAT-002)
and `aichat-research-external.md` (TASK-AICHAT-003). This file is TASK-AICHAT-006's
consolidation input; it is not itself the final spec.

Scope boundary: this file owns keyboard precedence, the slash-menu interaction contract,
the mention menu and autocomplete geometry/accessibility. Backend semantics for `/engine`
`/model` `/resume` `/context` `/export`, native-command gating, streaming, timeline,
sessions, permissions and failures belong to TASK-AICHAT-005 — cross-references below read
`→ see TASK-AICHAT-005 section` and no content is duplicated.

Every external claim carries a research-question citation (`per Qxx`) and an evidence label
(`Verified-with-URL` / `Reported-unverified` / `Could-not-verify`) drawn from
`aichat-research-external.md`. Every behavior change carries a grounded delta of the form
`current: <file:line does X> → target: Y`.

---

## 0. Delta ledger (current → target)

Each line is one behavior change, anchored to the current source. Values cited are the
verified line numbers from TASK-AICHAT-001/002; where a fact-base recorded an off-by-N
correction, the corrected range is used and the delta says so.

1. current: `webview/aiChatPanelMain.ts:812` matches `Enter || Tab` for the mention menu and calls `preventDefault()` + `stopImmediatePropagation()` with no Shift check → target: Shift+Enter in the mention menu inserts one newline (KBD-02/KBD-08) and never selects.
2. current: `webview/aiChatPanelMain.ts:872` matches plain `Enter` for the slash menu and likewise excludes any Shift test → target: Shift+Enter in the slash menu inserts one newline and preserves the typed prefix (KBD-02/KBD-08).
3. current: `webview/aiChatPanelComposer.ts:498` is the only Shift exclusion (`!ev.shiftKey`) and sits in the bubble-phase listener that the capture branch above suppresses → target: one controller runs the precedence order and the Shift rule is evaluated before menu handling, so the guard is not shadowed.
4. current: `webview/aiChatPanelMain.ts:907` opens/refreshes mention detection only on `keyup` (the `input` listener at `:897–900` early-returns while `mentionOpen`) → target: detection runs on `input`, `keyup`, paste, mouse-selection change and `compositionend` through one shared detector (MENTION-05).
5. current: `webview/aiChatPanelMain.ts:930` posts `{ type: "mention_list", query }` with no request id or revision token, and the reply handler at `:2027–2032` caches the last-arrived list unconditionally → target: every request carries a requestId plus draft revision; stale or post-dismissal replies are discarded (MENTION-02/MENTION-03).
6. current: `webview/aiChatPanelComposer.ts:449` writes `prompt.value = next` inside the `slashHintBtn` handler and notifies no controller → target: the toolbar button routes through the controller, which opens the same menu as a typed `/` (SLASH-01).
7. current: `webview/aiChatPanelMain.ts:864–866` is the second, inconsistent slash writer (it pairs the DOM write with `composer?.setValue`) → target: one authoritative insertion path used by both the toolbar and the menu (SLASH-01/SLASH-07).
8. current: `webview/aiChatPanelMain.ts:595–599` row-click writes `prompt.value = \`/${command} \`` and focuses, without notifying the composer model → target: row click, Enter and Tab all select through the same controller path (SLASH-02).
9. current: `webview/aiChatPanelMain.ts:631` serializes `thread.innerText` and `:640` appends a local success notice before any host acknowledgement → target: structured transcript export with host-confirmed write (pointer below lowers this to a cross-reference, not a re-spec).
10. current: `webview/aiChatPanelMain.ts:819–825` closes the mention dropdown silently when the active row carries no token (the "No matches" row at `:318–331` has none) → target: loading/empty/error rows are non-selectable and Enter on them keeps the menu open with a polite announcement (MENTION-09/A11Y-07).
11. current: `webview/aiChatPanelMain.ts:801–810` suppresses Ctrl/Meta+Enter only while `!mentionOpen && !slashOpen` → target: Ctrl/Cmd+Enter is state-independent and consumed before menu handling (KBD-04).
12. current: no `composition`/`isComposing` check exists in any of the four chat webview files → target: an IME-composition check is the first rule of the controller on every path (KBD-03).
13. current: `src/ui/aiChatPanelCommands.ts:44` rejects an unclosed quote and returns `null`, and `webview/aiChatPanelMain.ts:645` then lets the raw text fall through to send → target: an invalid argument preserves the draft and shows a corrective example, never an assistant bubble (SLASH-03/SLASH-05).
14. current: `src/ui/aiChatPanel.ts:1779–1781` accepts exactly `builtin|omp` for `/engine` although the protocol advertises four engines at `src/ui/aiChatPanelMessages.ts:102` (fact-base verdict `confirms`, corrected range `:1744–1817`) → target: argument vocabulary is capability-negotiated per engine; backend semantics → see TASK-AICHAT-005 section.
15. current: `src/ui/aiChatPanel.ts:1757–1763` accepts only `work|smart` for the `/model` text path while `AiModelRole` has four members (`src/ai/settings.ts:13`) → target: host-authoritative role picker; no arbitrary model IDs (SLASH-08).

---

## 1. Composer keyboard contract

### 1.1 Controller state machine

One composer keyboard controller owns submission and autocomplete. It is the only listener
allowed to decide key precedence; the existing split between the composer's bubble-phase
listener (`webview/aiChatPanelComposer.ts:496–504`) and the capture-phase listener
(`webview/aiChatPanelMain.ts:792–895`) is collapsed into this controller. One shared
popover surface is used (see §4), so there is never more than one menu to disambiguate.

States (explicit, mutually exclusive):

| State | Meaning | Menu | Turn |
|---|---|---|---|
| `IDLE` | composer focused, nothing running, no menu | none | idle |
| `SLASH` | `/` menu open | slash | idle |
| `MENTION` | `@` menu open | mention | idle |
| `RUNNING` | a turn is streaming, composer editable for the next draft | none | running |
| `COMPOSING` | IME composition active — a high-priority overlay that can coexist with any state above | unchanged | unchanged |

`COMPOSING` is an overlay, not a peer state: on `compositionstart` the controller enters
`COMPOSING` from whatever state it held and on `compositionend` it returns to that state.
This is the UnicDB-original IME requirement noted in the external ledger: no fetched vendor
page documents composition handling, so it carries no upstream safety net (per Q22,
Verified-with-URL for the surrounding analysis).

Transitions (event → from → to, with action):

| Event | From | To | Action |
|---|---|---|---|
| `compositionstart` | any | `COMPOSING` | record prior state; suppress send/select |
| `compositionend` | `COMPOSING` | prior state | run one detector refresh (§3) |
| `keydown Enter` | `COMPOSING` | `COMPOSING` | no send, no select; never `preventDefault` the IME commit |
| `keydown Shift+Enter` | `IDLE`,`SLASH`,`MENTION`,`RUNNING` | unchanged | insert one `\n`, close menu if open, resize, keep draft |
| `keydown Ctrl/Cmd+Enter` | any non-composing | unchanged | consume; never send |
| `keydown Enter` | `SLASH`/`MENTION` | prior | select active **selectable** row, insert template, do not execute |
| `keydown Enter` | `IDLE` | `RUNNING` | send one nonempty draft when context is valid |
| `keydown Enter` | `RUNNING` | `RUNNING` | nothing; inline hint stays |
| `keydown Escape` | `SLASH`/`MENTION` | `IDLE` | close menu, preserve draft, do not cancel generation |
| `keydown Tab` | `SLASH`/`MENTION` | prior | select active selectable row; otherwise ordinary focus order |
| `keydown ArrowUp/Down` | `SLASH`/`MENTION` | unchanged | move active row, wrap, scroll into view |
| `input`/`paste`/`compositionend` | `IDLE` | `SLASH`/`MENTION` | open menu when the token boundary matches |
| `send` accepted | `IDLE` | `RUNNING` | set busy, disable send button |
| `done`/`error` | `RUNNING` | `IDLE` | re-enable send, keep the draft textarea contents |

### 1.2 Modifier rules

One rule per modifier key, all evaluated in this order by the controller:

- **IME composition:** Enter during composition never sends and never selects an item; the
  commit keystroke is passed through. `compositionend` triggers one detector refresh so a
  paste-free IME edit updates `@` detection like typing (KBD-03; delta 12, 4).
- **Shift+Enter:** always insert exactly one newline at the current selection, close the
  open menu, preserve the text before and after the selection, and resize the input. This
  holds **even while `/` or `@` menus are open** — the rule that the current capture branch
  violates and that KBD-02/KBD-08 pin (deltas 1, 2, 3).
- **Enter (no modifier):** menu select first (when a selectable row is active), otherwise
  submit once. Plain Enter submits one nonempty draft only when the turn is idle and the
  selected context is valid; repeated keydown or a double click must not create duplicate
  turns (KBD-07).
- **Ctrl/Cmd+Enter:** never sends, in every state including with a menu open. This
  supersedes the current dropdown-state-dependent suppression at
  `webview/aiChatPanelMain.ts:801–810` (delta 11, KBD-04).
- **Escape:** closes the topmost menu and preserves the draft; it never cancels generation
  implicitly. Stop remains an explicit button (KBD-06).
- **Tab:** selects a valid active result only while a menu is open; otherwise it follows the
  ordinary focus order (A11Y-06).

Prefixing a message with `!` to run a terminal command is documented upstream as available
only in Agent Host sessions (per Q07, Verified-with-URL). UnicDB must treat `!` as a
provider-native, capability-gated behavior, never a universal composer rule.

### 1.3 Running-turn policy

While a turn runs the textarea remains editable for the next draft, but Enter does not
enqueue or send. An inline hint says "AI is responding. Your draft is kept." Stop is an
explicit button. Queueing and steering are separate future capabilities, never inferred
from typing (KBD-05). This mirrors the upstream separation where queue/steer are explicit
dropdown actions — **Add to Queue**, **Steer with Message**, **Stop and Send** (per Q10,
Verified-with-URL), with `chat.requestQueuing.defaultAction` choosing the default.

### 1.4 Draft-preservation guarantees

- Enter with an empty or whitespace-only draft is a no-op; no turn is created.
- Escape, menu close, and state transitions never clear or mutate the draft text.
- Insertion of a mention reference or a slash template replaces only the active token and
  preserves every character before and after it (MENTION-04).
- A running turn never overwrites the draft the user is editing.
- Sending clears the textarea only after the `send` message is posted; a rejected send keeps
  the draft.

Baseline `KBD-01` through `KBD-07` are preserved verbatim in §5. New IDs `KBD-08`
(Shift+Enter inside an open menu), `KBD-09` (running-turn hint plus editable draft) and
`KBD-10` (Esc/close never mutate the draft) extend the family to 10 distinct IDs.

**supersedes:** the draft's ordering prose ("Next handle Shift+Enter … Next handle the active
autocomplete menu") is superseded by the explicit state-machine table above. Rationale: the
old prose listed the order correctly but left the capture-vs-bubble listener boundary
implicit, which is exactly where the Shift bug lives; the table makes the order normative
and testable and is the contract KBD-02/KBD-08 assert.

---

## 2. Slash menu contract

### 2.1 Open / close trigger

Typing `/` opens the local command menu when the trimmed input starts with `/` and the
first token contains no whitespace. A slash inside a URL, file path, code fence or ordinary
sentence must not open it (SLASH-04). The toolbar slash button focuses the composer and
opens this same menu through the controller; it must not only mutate the textarea value
without notifying the controller (SLASH-01; deltas 6, 7). If prose already exists, the
button opens command browsing without silently replacing that prose.

Upstream, "Type `/` in the chat input to see all available commands" mixes built-in prompts
and contributed commands in one surface (per Q08, Verified-with-URL), and per-participant
registration bounds the command set (per Q02, Verified-with-URL). Continue's shipped flow —
type `/`, select the prompt, then type additional instructions — confirms select-then-execute
as a real pattern (per Q15, Verified-with-URL). UnicDB's rule that selection never executes
and a second Enter runs matches this.

**supersedes:** the draft's "at the beginning of an otherwise empty command line" is
superseded by "start of the trimmed input, command token with no whitespace". Rationale: the
existing filter already matches a partial command word (`webview/aiChatPanelMain.ts:607–616`),
so "otherwise empty" was never the actual trigger and cannot be tested as written.

### 2.2 Current command inventory (fact-base, with anchors)

Registry: `AI_CHAT_COMMANDS = ["clear","resume","engine","context","export","model"]` at
`src/ui/aiChatPanelCommands.ts:2–9`. Parser: `parseAiChatCommand` at `:36–84` (fact-base
verdict `corrects (actual: registry :2–9, parser :36–84)` — the draft's `:1–83` is off by
one line at the end). Webview execution switch: `webview/aiChatPanelMain.ts:643–671`. Only
`engine` and `model` cross the wire (`:666–669`); `clear`, `resume`, `context`, `export` are
handled webview-locally. The `command` wire union is only `"engine" | "model"`
(`src/ui/aiChatPanelMessages.ts:425`).

`/help` and `/new` do **not** exist in the registry or the webview switch (fact-base §7.9);
they are proposals in §2.5.

### 2.3 Menu row anatomy

Each row shows, left to right: a 16px kind/availability icon, the command name at 13px/20px
primary text, a short description at 11px/16px secondary text, and an argument hint. Local
commands appear immediately with no network spinner. Unavailable entries render with
`aria-disabled="true"` (kept focusable, per Q21 Verified-with-URL) and a reason string.
Up/Down moves the active item and scrolls it into view; the active row is the only one with
`aria-selected="true"`.

### 2.4 Argument grammar

The parser is a small shell-like grammar: whitespace separates unquoted values; matching
single or double quotes group whitespace; backslash escapes the next character inside or
outside quotes; an unclosed quote returns `null` (`src/ui/aiChatPanelCommands.ts:36–84`).
A command must occupy the whole trimmed input; ordinary text and unknown/incomplete prefixes
return `null`. Per-command grammar:

| Command | Accepted arguments (current) | Target contract |
|---|---|---|
| `/clear` | none | confirmation before clearing an existing conversation; states it stops a running turn first; → see TASK-AICHAT-005 section |
| `/resume` | none; opens picker | unsupported native resume disabled and explained per backend; → see TASK-AICHAT-005 section |
| `/engine` | exactly 1: `builtin\|omp` (`src/ui/aiChatPanel.ts:1779–1781`) | capability-advertised only; never reruns the last prompt; → see TASK-AICHAT-005 section |
| `/model` | text path `work\|smart` (`src/ui/aiChatPanel.ts:1757–1763`) | host-authoritative role picker, no arbitrary model IDs; → see TASK-AICHAT-005 section |
| `/context` | none | context inspector of actual items/exclusions/privacy boundaries; → see TASK-AICHAT-005 section |
| `/export` | optional filename (`webview/aiChatPanelMain.ts:664`) | export destination/format flow, success only after host write; → see TASK-AICHAT-005 section |
| `/help` (proposed) | none | opens the command catalog in the same menu surface |
| `/new` (proposed) | none | new conversation preserving saved history; session semantics → see TASK-AICHAT-005 section |

Invalid or malformed arguments keep the input and show a corrective example; they do not
create an assistant reply bubble (SLASH-03). Unknown commands show an inline validation
message with "Send as text" as an explicit alternative; they must not silently reach a
backend as if supported (SLASH-05).

### 2.5 Selection and execution flow

Enter, Tab or clicking a row selects and inserts the command template; selection never
executes it. A second Enter with the menu closed executes a complete, valid command
(SLASH-02). Escape preserves the typed prefix. Commands with missing arguments open their
relevant picker. Provider-native commands form a separately labelled, capability-gated group;
do not fabricate native commands, map them to shell execution, or promise identical command
sets across engines (per Q02, Verified-with-URL; per Q22, Verified-with-URL). A command
switch must never rerun the last prompt automatically.

Baseline `SLASH-01` through `SLASH-06` are preserved verbatim in §5. New IDs `SLASH-07`
(single authoritative insertion path), `SLASH-08` (capability-negotiated engine/model
arguments) and `SLASH-09` (`/help` and `/new` proposal) extend the family to 9 distinct IDs.

---

## 3. Mention menu contract

### 3.1 Token-boundary detection (concrete)

Detection runs through one shared detector invoked by `input`, `keyup`, `paste`, a
mouse-selection change, and `compositionend` — never by `keyup` alone (delta 4, MENTION-05).
The detector walks back from the caret; the token span is the run of `[\w.\-/]` characters
immediately before the caret ending at an `@`. Concretely, an `@` opens the menu iff:

- the `@` is at position 0, or the character before it is whitespace or one of
  `( [ { " ' ` < , ; :` — this excludes `user@host` email addresses; and
- the caret-to-`@` span contains only token characters (no space/newline), so a completed
  `@token ` followed by a space does not reopen; and
- the current line is not inside a fenced code block, tracked by a running fence counter.

The walk-back itself mirrors the existing `findAtTokenStart` helper
(`webview/aiChatPanelMain.ts:291–303`), which already stops at the first non-token character.

**supersedes:** the draft's "Do not trigger inside email addresses or fenced code" is
superseded by the prev-character grammar plus fence tracker above. Rationale: email and
fenced code were examples of a boundary rule, not the rule; the grammar is strictly stronger
(it also rejects `#tag@x` mid-word, Python decorators, and `@` inside URLs) and is directly
assertable.

### 3.2 Categories

The initial categories are Files, Editor selection and Database objects. Existing
database-object mention behavior must remain supported. Optional folders, diagnostics, git
diff and terminal output are later capabilities and stay hidden until implemented with
explicit content and privacy rules. This mirrors the upstream context model where `@` selects
scoped context (per Q09, Verified-with-URL) and a single sigil attaches files/folders/selection
everywhere (per Q22, Verified-with-URL). Cline's `@/path` file and trailing-slash folder
convention is the closest token-grammar comparator (per Q14, Verified-with-URL).

### 3.3 Result disambiguation (per kind)

Each result has a kind icon, a name, a **secondary disambiguating identifier**, and an
availability state. Two files named `index.ts` show distinct workspace-relative paths. Two
tables with the same name show distinct connection/schema identifiers. A database mention
initially includes metadata, not table rows; obtaining rows remains a separate governed tool
action. Continue's deprecated `@Database` provider stops at "table schemas," which is
evidence the metadata-only boundary is reasonable (per Q14, Verified-with-URL), while the
rows-via-tool-action rule is UnicDB-original with no upstream equivalent (per Q22). The
duplicate-disambiguation rule likewise has no fetched upstream wording and stays a
UnicDB-original requirement (per Q09, Could-not-verify sub-part).

### 3.4 Async correlation and timing

Debounce remote/host search by **150 ms**. Every request and result carries a `requestId`
plus a draft revision; stale results must not replace a newer query or reopen a dismissed
menu. Show "Searching…" only if the request is still pending after **200 ms**. Empty results
say "No matching context"; an error says "Could not search context" with Retry that
preserves the query. No result, error or loading row is selectable (MENTION-09/A11Y-07).

The combined `requestId` + draft-revision staleness guard is UnicDB-original: upstream docs
describe search but not this correlation contract (per Q22, Verified-with-URL). The current
code posts a query-only request and caches the last-arrived reply unconditionally (deltas 5,
10).

### 3.5 Keyboard behaviour

Up/Down changes selection; Enter/Tab/click inserts the selected reference without submitting.
Escape preserves literal text. Shift+Enter inserts a newline and closes the menu. Replacement
affects only the active `@` token, never the rest of the draft. Preserve text after the caret
and restore focus and caret after insertion. Type-ahead is required for lists over seven
options, and Up/Down/Home/End navigation follows the APG listbox guidance (per Q20,
Verified-with-URL; A11Y-04/A11Y-05).

### 3.6 Chip data model

Selected context appears in removable chips above the textarea. The chip carries a structured
identity separate from the displayed label. Enumerated fields:

| Field | Purpose |
|---|---|
| `kind` | `file` \| `folder` \| `selection` \| `database` \| … — drives the icon |
| `label` | displayed name only; may truncate |
| `stableId` | workspace-relative URI, object id, or `connection/schema/table` |
| `range` | line/column range where applicable |
| `sourceRevision` | file mtime/hash or schema revision at pin time |
| `resolutionState` | `resolved` \| `missing` \| `changed` \| `forbidden` |
| `token` | the literal `@…` text the chip replaced |

Do not store raw secret content in chip datasets. Removing a chip removes its reference from
the outgoing context, not the user's unrelated prose (MENTION-06). Unresolvable references
show a warning and require removal, replacement or an explicit "Send without this context"
action; never silently omit them (MENTION-07). Previewing a chip does not send its content
to a model (MENTION-08). Refresh context at send time and warn when a pinned
selection/file revision changed.

Baseline `MENTION-01` through `MENTION-10` are preserved verbatim in §5. New IDs `MENTION-11`
(chip field model / no raw secrets) and `MENTION-12` (revision refresh at send time) extend
the family to 12 distinct IDs.

---

## 4. Autocomplete geometry and accessibility

### 4.1 Geometry (values preserved verbatim)

Use one shared popover surface for slash and mention search. Width is `min(420px, available
composer width)`, viewport gutter `8px`, maximum height `min(280px, 40vh)`, row minimum
height `44px`, horizontal padding `12px`, row gap `8px`, icon `16px`, primary text `13px/20px`
and secondary text `11px/16px`. Anchor above the composer by default; reposition into
available space on resize and never clip behind an overflow container. Long paths truncate
visually but remain available in the accessible name and tooltip.

All draft values are retained verbatim:
`420px` · `8px` gutter · `280px` · `40vh` · `44px` · `12px` · `8px` gap · `16px` icon ·
`13px/20px` primary · `11px/16px` secondary · `2px` focus outline · `2px` focus offset ·
`500 ms` tooltip delay · `150 ms` search debounce · `200 ms` pending threshold.

### 4.2 Theme tokens

Use VS Code theme colors: `editorWidget.background`, `editorWidget.border`, `foreground`,
`descriptionForeground`, `list.activeSelectionBackground`, `list.activeSelectionForeground`
and `focusBorder`. These exact IDs are confirmed real on the theme-color reference (per Q06,
Verified-with-URL). That reference also lists chat-specific tokens —
`chat.slashCommandBackground`, `chat.slashCommandForeground`, `chat.requestBubbleBackground`,
`chat.checkpointSeparator` — which are a concrete future upgrade path over the generic
widget/list tokens (per Q06, Verified-with-URL). Fallbacks are for missing theme tokens only,
not a forced dark theme. Keep a visible `2px` focus outline with `2px` offset. Tooltips appear
on hover after `500 ms` and on keyboard focus; they must not contain essential instructions
unavailable elsewhere. Respect reduced motion — the webview receives the
`vscode-reduce-motion` body class (per Q06, Verified-with-URL) — and maintain readable
contrast in light, dark and high-contrast themes.

### 4.3 APG combobox checklist → A11Y IDs

The textarea exposes combobox semantics; results use listbox/option semantics with stable
IDs; DOM focus stays in the textarea while the active result moves. Mapped against the WAI-ARIA
APG (per Q19 combobox, Q20 listbox, Q21 keyboard-interface/live-regions — all
Verified-with-URL):

| APG requirement | Mapped ID |
|---|---|
| Input role `combobox`; popup role `listbox`; `aria-controls` references the popup; `aria-expanded` false/true | A11Y-01 |
| `aria-activedescendant` points at the active option while DOM focus stays on the combobox; `aria-autocomplete="list"` | A11Y-02 |
| Labeling via HTML `label` else `aria-labelledby`/`aria-label`; options named by visible text (not `aria-label`, which hides descendants) | A11Y-03 |
| Up/Down move focus; Home/End for lists over five options; type-ahead for lists over seven; wrap behaviour defined | A11Y-04 |
| `aria-selected` on the active option, never combined with `aria-checked`; async sets `aria-setsize`/`aria-posinset` | A11Y-05 |
| Focus retained in the textarea; on close move focus to the trigger, never to `body`; Tab follows ordinary order when no menu | A11Y-06 |
| Loading/empty/error rows use `aria-disabled="true"` (focusable, not selectable); polite live region announces count/failure/selection; `aria-busy` during refresh; never `assertive` | A11Y-07 |
| Reduced motion honoured; 200% zoom and light/dark/high-contrast keep every control reachable | A11Y-08 |

APG's "keep disabled rows focusable with `aria-disabled` rather than HTML `disabled`"
guidance refines the draft's non-selectable-row rule (per Q21, Verified-with-URL). The polite
live region ("not every keystroke or streaming token") is APG-correct rather than
`assertive` (per Q21, Verified-with-URL).

Baseline geometry and accessibility prose is preserved; the A11Y family is new with 8 IDs.

---

## 5. Required interaction acceptance tests (extended)

Baseline IDs KBD-01..07, SLASH-01..06 and MENTION-01..10 are preserved verbatim from the
draft; new IDs are appended in family order.

**KBD**
- KBD-01: Enter sends one ordinary message; Shift+Enter inserts one newline and sends none.
- KBD-02: repeat that assertion with slash and mention menus open.
- KBD-03: IME composition Enter never sends or selects; Enter after composition works normally.
- KBD-04: Ctrl/Cmd+Enter sends nothing.
- KBD-05: a running turn allows draft editing without a second send.
- KBD-06: Escape closes the menu without losing text or stopping generation.
- KBD-07: repeated Enter and double-click send produce one acknowledged turn.
- KBD-08: Shift+Enter while a slash or mention menu is open inserts one newline and keeps the draft; the menu closes.
- KBD-09: while a turn runs, the inline "AI is responding. Your draft is kept." hint is visible and Enter does not enqueue.
- KBD-10: closing a menu by Escape or by selection never mutates text outside the active token.

**SLASH**
- SLASH-01: toolbar click and typed slash open the same menu.
- SLASH-02: Enter/Tab select a command without execution; the next Enter executes.
- SLASH-03: invalid arguments preserve the draft.
- SLASH-04: URLs and paths do not trigger.
- SLASH-05: unknown commands require explicit Send as text.
- SLASH-06: clear has confirmation, engine switch has host acknowledgement and export waits for successful write.
- SLASH-07: toolbar, row click, Enter and Tab all insert through the single authoritative path and notify the composer model.
- SLASH-08: `/engine` and `/model` reject values outside host-advertised capabilities with a corrective example.
- SLASH-09: `/help` opens the catalog in the same surface; `/new` starts a conversation while saved history remains.

**MENTION**
- MENTION-01: duplicate filenames and tables remain distinguishable.
- MENTION-02: an older async response cannot replace newer results.
- MENTION-03: a response arriving after Escape cannot reopen the menu.
- MENTION-04: inserting a reference preserves text before and after the active token.
- MENTION-05: paste and caret movement update detection.
- MENTION-06: removing context removes only that reference.
- MENTION-07: missing/forbidden files cannot silently enter or disappear from a sent prompt.
- MENTION-08: previews and search do not trigger model calls.
- MENTION-09: loading, error and empty rows cannot submit.
- MENTION-10: narrow panel, 200% zoom and keyboard-only interaction keep every control reachable.
- MENTION-11: a chip exposes the enumerated field set and stores no raw secret content.
- MENTION-12: at send time a changed pinned revision raises a warning and never silently swaps content.

**A11Y**
- A11Y-01: the textarea exposes `combobox` with `aria-controls` and `aria-expanded` mirroring menu visibility.
- A11Y-02: `aria-activedescendant` tracks the active option while DOM focus stays in the textarea.
- A11Y-03: the composer is labelled and options are named by visible text.
- A11Y-04: Up/Down/Home/End and type-ahead navigate options per the APG listbox pattern.
- A11Y-05: `aria-selected` marks exactly one active option; async lists set `aria-setsize`/`aria-posinset`.
- A11Y-06: on close, focus returns to the trigger; Tab follows ordinary order when no menu is open.
- A11Y-07: loading/empty/error rows are `aria-disabled` and non-selectable; a polite live region announces count, failure and selection; never `assertive`.
- A11Y-08: reduced motion is honoured and 200% zoom plus light/dark/high-contrast keep every control reachable.

## 6. Baseline preservation ledger

Preserved verbatim: KBD-01..07, SLASH-01..06, MENTION-01..10, and the geometry/timing values
`420px`, `8px` gutter, `280px`, `40vh`, `44px`, `12px`, `8px` gap, `16px`, `13px/20px`,
`11px/16px`, `2px` focus, `2px` offset, `500 ms`, `150 ms`, `200 ms`. Superseded draft rules
carry an explicit `supersedes:` rationale in §1.1, §2.1 and §3.1. Content owned by
TASK-AICHAT-005 is referenced, not duplicated.
