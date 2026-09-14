# UnicDB AI Chat — Research-complete implementation specification

Status: **Research-complete final specification — consolidated 2026-09-15** (replaces the earlier draft-in-progress header). This is a proposed redesign and the frozen input to the next implementation cycle. It is not an implemented feature, and it is not a verified comparison of the extensions the original draft alluded to. External claims carry an explicit evidence label; every source anchor in §12 was re-checked against the current tree by the automated anchor gate in this cycle.

## Scope

Improve the existing VS Code AI Chat experience while retaining the OMP, Claude Code, Codex and builtin integration boundaries. This document specifies the composer keyboard controller, the slash-command menu, the `@` mention menu and chips, streaming and rendering, the activity timeline, sessions and persistence, permissions and approvals, failure and recovery classes, the four-engine capability matrix, engine-gated command semantics, accessibility, and visual acceptance for the new rendered surfaces. No runtime source change is authorized by this research deliverable; §Appendix A sequences the work that a later cycle may plan from it.

## Evidence status

**Research state.** Internal research is complete against the current tree: the webview layer (TASK-AICHAT-001) and the host/engine layer (TASK-AICHAT-002) were read and reduced to anchored facts, and all limits below were checked directly against source during consolidation. External research (TASK-AICHAT-003) completed with a reachable primary-source fetch tool: every `Verified-with-URL` label below corresponds to a page the executor actually opened this cycle. One research tool remained unavailable — keyword web search returned empty result blocks — so research proceeded by fetching known primary documentation URLs directly and by reading vendor sitemaps to discover correct paths rather than guessing. No remembered feature was promoted to a verified label on the strength of memory alone.

**Subject substitution (stated openly).** The earlier draft promised a comparison against three then-unnamed Marketplace extensions; it never named them, and a repository search for any such list returns nothing, so the originals remain genuinely unnamed. This specification **substitutes a named, inspectable set of research subjects** that it can actually cite: **GitHub Copilot Chat** and the **official VS Code chat/webview documentation**, **Cline**, **Continue**, and the **WAI-ARIA Authoring Practices Guide** as the accessibility authority. The substitution is deliberate and disclosed here. These subjects are **comparisons for design reasoning only**; nothing in this document attributes a behavior, repository, license, or maintenance status to whatever the original draft author had in mind. If the original three are ever named, this document must be re-checked against them rather than silently reused.

**Evidence labels carried end-to-end.** Every external claim in this document is tagged `Verified-with-URL`, `Reported-unverified`, or `Could-not-verify`, and cites the research question (`per Qnn`) that produced it. Internal claims are tagged `Verified (file:line)`, `Unverified-internal`, or `absent in current source`.

<details><summary>Known limits of the external evidence (honest ledger)</summary>

- Every claim marked `Verified-with-URL` traces to a fetched page; the full URL list is in §14.
- `Could-not-verify` sub-parts, carried forward rather than papered over: the webview docs contain no explicit focus-management or keyboard-navigation guidance (Q06); the default-keybindings reference does not list a send or newline-in-chat binding (Q07); no fetched page documents how any product disambiguates two identically-named files in its picker (Q09); no fetched page documents an in-IDE streaming cancel/retry control for Continue — three candidate URLs returned HTTP 404 (Q17).
- `Reported-unverified`: none. Every external assertion in this document resolved to a fetched primary page or is marked `Could-not-verify`.
- TASK-AICHAT-003 did **not** end blocked; this document therefore carries no whole-document `Could-not-verify` overlay, only the four sub-parts above.
</details>

## Terminology — one accepted name per concept

The two section drafts used overlapping vocabulary. The consolidated names below are normative for the rest of this document and for implementation.

| Concept | Accepted name | Rejected synonyms | Meaning |
|---|---|---|---|
| Slash surface | **command menu** | slash dropdown, slash popover, command palette | The single popover listing local and capability-gated provider-native commands. |
| `@` surface | **mention menu** | context menu, `@` dropdown, mention picker | The single popover listing searchable context results. |
| Attached context | **chip** | pill, tag, token badge | The removable element above the textarea carrying a structured context identity. |
| Backend runtime | **engine** | provider, adapter, backend, mode | One of `builtin`, `omp`, `claudeCode`, `codex` (wire literals `builtin`/`omp`/`claude-code`/`codex`). |
| Conversation unit | **session** | conversation, thread, history | A first-class unit of work with an id or a locally saved transcript. |
| Execution of one exchange | **turn** | request, message, run | One user submission through to a terminal `done`/`error` frame. |

**One shared surface rule.** The command menu and the mention menu render through one popover component (§1.5). There is never more than one menu open at once, so "the active menu" is unambiguous everywhere below.

## 1. Composer interaction contract

This section defines target behavior. It is **not** an assertion that any external product implements it identically; external grounding is cited per rule. The implementation must consolidate the existing slash and mention handlers into one controller rather than attach another competing key listener.

### 1.1 Keyboard precedence

A single composer keyboard controller owns submission and autocomplete and is the only listener allowed to decide key precedence. The current implementation splits this ownership between a bubble-phase listener (`webview/aiChatPanelComposer.ts:496–504`) and a capture-phase listener (`webview/aiChatPanelMain.ts:792–895`) that runs first — and the capture branch is where the Shift bug lives (§12, gap notes). The controller collapses both into one explicit, mutually-exclusive state machine:

| State | Meaning | Menu | Turn |
|---|---|---|---|
| `IDLE` | composer focused, nothing running, no menu | none | idle |
| `SLASH` | command menu open | command | idle |
| `MENTION` | mention menu open | mention | idle |
| `RUNNING` | a turn is streaming; composer stays editable for the next draft | none | running |
| `COMPOSING` | IME composition active — a high-priority overlay that can coexist with any state above | unchanged | unchanged |

`COMPOSING` is an overlay, not a peer: it is entered on `compositionstart` from whatever state was held and releases back to that state on `compositionend`. No upstream page documents IME composition handling, so this rule carries no external safety net and is UnicDB-original (per Q22).

Transitions (event → from → to, with action):

| Event | From | To | Action |
|---|---|---|---|
| `compositionstart` | any | `COMPOSING` | record prior state; suppress send and select |
| `compositionend` | `COMPOSING` | prior state | run exactly one detector refresh (§1.3) |
| `keydown Enter` | `COMPOSING` | `COMPOSING` | no send, no select; never `preventDefault` the IME commit |
| `keydown Shift+Enter` | `IDLE`/`SLASH`/`MENTION`/`RUNNING` | unchanged | insert one newline at the selection, close the menu if open, resize, keep the draft |
| `keydown Ctrl/Cmd+Enter` | any non-composing | unchanged | consume; never send |
| `keydown Enter` | `SLASH`/`MENTION` | prior | select the active **selectable** row, insert its template, do not execute |
| `keydown Enter` | `IDLE` | `RUNNING` | send one nonempty draft when context is valid |
| `keydown Enter` | `RUNNING` | `RUNNING` | nothing; the inline hint stays |
| `keydown Escape` | `SLASH`/`MENTION` | `IDLE` | close the menu, preserve the draft, never cancel generation |
| `keydown Tab` | `SLASH`/`MENTION` | prior | select the active selectable row; otherwise ordinary focus order |
| `keydown ArrowUp/Down` | `SLASH`/`MENTION` | unchanged | move the active row, wrap, scroll into view |
| `input`/`paste`/`compositionend` | `IDLE` | `SLASH`/`MENTION` | open the menu when the token boundary matches |
| send accepted | `IDLE` | `RUNNING` | set busy, disable the send button |
| `done`/`error` | `RUNNING` | `IDLE` | re-enable send, keep the draft textarea contents |

**Modifier rules, evaluated in this order by the controller:**

- **IME composition** — Enter during composition never sends and never selects; the commit keystroke passes through. One refresh fires on `compositionend` so an IME edit updates `@` detection like typing.
- **Shift+Enter** — always inserts exactly one newline at the current selection, closes the open menu, preserves the text before and after the selection, and resizes the input. This holds **even while a menu is open**, which the current capture branch violates: neither the mention branch at `webview/aiChatPanelMain.ts:812` nor the slash branch at `webview/aiChatPanelMain.ts:872` inspects `shiftKey` before calling `preventDefault()` and `stopImmediatePropagation()`, so the composer's own Shift guard at `webview/aiChatPanelComposer.ts:498` is shadowed.
- **Enter (no modifier)** — menu selection first (when a selectable row is active), otherwise submit once. Plain Enter submits one nonempty draft only when the turn is idle and selected context is valid; repeated keydown or a double click must not create duplicate turns.
- **Ctrl/Cmd+Enter** — never sends, in every state including with a menu open. This supersedes the dropdown-state-dependent suppression at `webview/aiChatPanelMain.ts:801–810`, which currently applies only while no menu is open.
- **Escape** — closes the topmost menu and preserves the draft; it never cancels generation implicitly. Stop remains an explicit button; external precedent treats stop as explicit and separate from queue/steer (per Q10).
- **Tab** — selects a valid active result only while a menu is open; otherwise it follows the ordinary focus order.

Prefixing a message with `!` to run a terminal command is documented upstream as available only in Agent Host sessions (per Q07, Verified-with-URL). UnicDB must treat `!` as a provider-native, capability-gated behavior, never a universal composer rule.

**Running-turn policy.** While a turn runs the textarea remains editable for the next draft, but Enter does not enqueue or send. An inline hint reads exactly "AI is responding. Your draft is kept." Stop is an explicit button. Queueing and steering are separate future capabilities, never inferred from typing. This mirrors the upstream separation where queue/steer are explicit dropdown actions — **Add to Queue**, **Steer with Message**, **Stop and Send** — with `chat.requestQueuing.defaultAction` choosing the default (per Q10, Verified-with-URL).

**Draft-preservation guarantees.** Enter on an empty or whitespace-only draft is a no-op. Escape, menu close, and every state transition leave the draft text untouched. Inserting a mention reference or a slash template replaces only the active token and preserves every character around it. A running turn never overwrites the draft being edited. Sending clears the textarea only after the send message is posted; a rejected send keeps the draft.

**Supersedes.** The draft's ordering prose ("Next handle Shift+Enter … Next handle the active autocomplete menu") is superseded by the explicit state-machine table above. Rationale: the old prose listed the order correctly but left the capture-vs-bubble listener boundary implicit, which is exactly where the Shift defect lives; the table makes the order normative and directly testable.

### 1.2 Command menu (slash)

Typing `/` opens the local command menu when the trimmed input starts with `/` and the first token contains no whitespace. A slash inside a URL, file path, code fence, or ordinary sentence must not open it. The toolbar slash button focuses the composer and opens this same menu through the controller; it must not merely mutate the textarea value without notifying the controller — today the composer-local handler does exactly that at `webview/aiChatPanelComposer.ts:449`, while the main-side fill path at `webview/aiChatPanelMain.ts:864–866` pairs the DOM write with `composer.setValue`. If prose already exists, the button opens command browsing without silently replacing that prose.

Upstream, "Type `/` in the chat input to see all available commands" mixes built-in prompts and contributed commands in one surface (per Q08, Verified-with-URL), and per-participant registration bounds the command set (per Q02, Verified-with-URL). Continue's shipped flow — type `/`, select the prompt, then type additional instructions — confirms select-then-execute as a real pattern (per Q15, Verified-with-URL). UnicDB's rule that selection never executes and a second Enter runs follows this.

**Supersedes.** The draft's "at the beginning of an otherwise empty command line" is superseded by "start of the trimmed input, first command token with no whitespace". Rationale: the existing filter already matches a partial command word (`webview/aiChatPanelMain.ts:607–616`), so "otherwise empty" was never the actual trigger and could not be tested as written.

**Current inventory (anchored).** The registry is the closed six-command set `clear`/`resume`/`engine`/`context`/`export`/`model` at `src/ui/aiChatPanelCommands.ts:2–9`; the parser is `parseAiChatCommand` at `src/ui/aiChatPanelCommands.ts:36–84`; the webview execution switch is `webview/aiChatPanelMain.ts:643–671`. Only `engine` and `model` cross the wire (`webview/aiChatPanelMain.ts:666–669`); the other four are handled webview-locally. The command wire union is only `"engine" | "model"` at `src/ui/aiChatPanelMessages.ts:425`. `/help` and `/new` do not exist in either the registry or the switch and are proposals here.

**Menu row anatomy.** Each row shows, left to right: a 16px kind/availability icon, the command name at 13px/20px primary text, a short description at 11px/16px secondary text, and an argument hint. Local commands appear immediately with no network spinner. Unavailable entries expose `aria-disabled="true"` (kept focusable per Q21, Verified-with-URL) plus a reason string. Up/Down moves the active item and scrolls it into view; the active row is the only one carrying `aria-selected="true"`.

**Argument grammar.** The parser is a small shell-like grammar: whitespace separates unquoted values; matching single or double quotes group whitespace; backslash escapes the next character inside or outside quotes; an unclosed quote returns null (`src/ui/aiChatPanelCommands.ts:36–84`). A command must occupy the whole trimmed input; ordinary text and unknown or incomplete prefixes return null. Per-command contracts:

| Command | Accepted arguments (current, anchored) | Target contract |
|---|---|---|
| `/clear` | none | confirmation before clearing an existing conversation; states that it stops a running turn first; backend semantics → §8 |
| `/resume` | none; opens the picker | unsupported native resume disabled and explained per backend; backend semantics → §8 |
| `/engine` | exactly one of `builtin`/`omp` (`src/ui/aiChatPanel.ts:1779–1781`) | capability-advertised only; never reruns the last prompt; backend semantics → §8 |
| `/model` | text path accepts only `work`/`smart` (`src/ui/aiChatPanel.ts:1757–1763`) | host-authoritative role picker, no arbitrary model ids; backend semantics → §8 |
| `/context` | none | inspector of actual items, exclusions and privacy boundaries; backend semantics → §8 |
| `/export` | optional filename | destination/format flow, success only after host write; backend semantics → §8 |
| `/help` (proposed) | none | opens the command catalog in the same menu surface |
| `/new` (proposed) | none | new conversation preserving saved history; session semantics → §4 |

**Selection and execution flow.** Enter, Tab, or clicking a row selects and inserts the command template; selection never executes it. A second Enter with the menu closed executes a complete, valid command. Escape preserves the typed prefix. Commands with missing arguments open their relevant picker. Invalid or malformed arguments keep the input and show a corrective example; they do not create an assistant reply bubble — today the parser returns null at `src/ui/aiChatPanelCommands.ts:80` and the raw text can fall through to send at `webview/aiChatPanelMain.ts:645`. Unknown commands show an inline validation message with "Send as text" as an explicit alternative; they must never silently reach a backend as if supported.

Provider-native commands form a separately labelled, capability-gated group; do not fabricate native commands, map them to shell execution, or promise identical command sets across engines (per Q02, Verified-with-URL; per Q22, Verified-with-URL). A command switch must never rerun the last prompt automatically.

### 1.3 Mention menu

**Token-boundary detection (concrete).** Detection runs through one shared detector invoked by `input`, `keyup`, `paste`, a mouse-selection change, and `compositionend` — never by `keyup` alone. Today detection is `keyup`-only (`webview/aiChatPanelMain.ts:907–931`) and the `input` listener early-returns while the mention menu is open (`webview/aiChatPanelMain.ts:897–900`); this supersedes that path. The detector walks back from the caret; the token span is the run of token characters immediately before the caret ending at an `@`, mirroring the existing `findAtTokenStart` helper (`webview/aiChatPanelMain.ts:291–303`) which already stops at the first non-token character. Concretely, an `@` opens the menu iff:

- the `@` is at position 0, or the character before it is whitespace or one of `( [ { " ' \` < , ; :` — this excludes `user@host` email addresses; and
- the caret-to-`@` span contains only token characters (no space or newline), so a completed `@token ` followed by a space does not reopen; and
- the current line is not inside a fenced code block, tracked by a running fence counter.

**Supersedes.** The draft's "Do not trigger inside email addresses or fenced code" is superseded by the prev-character grammar plus fence tracker above. Rationale: email and fenced code were examples of a boundary rule, not the rule itself; the grammar is strictly stronger (it also rejects `@` inside a URL, mid-word `@`, and Python decorators) and is directly assertable.

**Categories.** The initial categories are Files, Editor selection, and Database objects. Existing database-object mention behavior remains supported. Optional folders, diagnostics, git diff, and terminal output are later capabilities and stay hidden until implemented with explicit content and privacy rules. This mirrors the upstream context model where `@` selects scoped context (per Q09, Verified-with-URL) and a single sigil attaches files, folders and selection everywhere (per Q22, Verified-with-URL). Cline's `@/path` file and trailing-slash folder convention is the closest token-grammar comparator (per Q14, Verified-with-URL).

**Result disambiguation (per kind).** Each result has a kind icon, a name, a secondary disambiguating identifier, and an availability state. Two files named `index.ts` must show distinct workspace-relative paths. Two tables with the same name must show distinct connection/schema identifiers. A database mention initially includes metadata, not table rows; obtaining rows remains a separate governed tool action. Continue's deprecated `@Database` provider stops at "table schemas", evidence that the metadata-only boundary is reasonable (per Q14, Verified-with-URL), while the rows-via-tool-action rule is UnicDB-original (per Q22). The duplicate-disambiguation rule has no fetched upstream wording and stays a UnicDB-original requirement (per Q09, Could-not-verify sub-part).

**Async correlation and timing.** Debounce remote/host search by 150 ms. Every request and result carries a `requestId` plus a draft revision; stale results must not replace a newer query or reopen a dismissed menu. Today the request is query-only at `webview/aiChatPanelMain.ts:930` and the reply handler caches the last-arrived list unconditionally at `webview/aiChatPanelMain.ts:2027–2032`, so late replies cannot be discarded. Show "Searching…" only if the request is still pending after 200 ms. Empty results say "No matching context"; an error says "Could not search context" with Retry that preserves the query. No result, error, or loading row is selectable. The combined `requestId` + draft-revision staleness guard is UnicDB-original; upstream docs describe search but not this correlation contract (per Q22, Verified-with-URL).

**Keyboard behavior.** Up/Down changes selection; Enter/Tab/click inserts the selected reference without submitting. Escape preserves literal text. Shift+Enter inserts a newline and closes the menu. Replacement affects only the active `@` token, never the rest of the draft. Preserve text after the caret and restore focus and caret after insertion. Pasting text and editing with mouse selection must trigger the same detector as typing. Type-ahead is required for lists over seven options, and Up/Down/Home/End navigation follows the APG listbox guidance (per Q20, Verified-with-URL).

**Chip data model.** Selected context appears in removable chips above the textarea. The chip keeps a structured identity separate from the displayed label:

| Field | Purpose |
|---|---|
| `kind` | `file` \| `folder` \| `selection` \| `database` \| … — drives the icon |
| `label` | displayed name only; may truncate |
| `stableId` | workspace-relative URI, object id, or `connection/schema/table` |
| `range` | line/column range where applicable |
| `sourceRevision` | file mtime/hash or schema revision pinned at insert time |
| `resolutionState` | `resolved` \| `missing` \| `changed` \| `forbidden` |
| `token` | the literal `@…` text the chip replaced |

Do not store raw secret content in chip datasets. Removing a chip removes its reference from the outgoing context, not the user's unrelated prose. Unresolvable references show a warning and require removal, replacement, or an explicit "Send without this context" action; they are never silently omitted. Previewing a chip does not send its content to a model. Refresh context at send time and warn when a pinned selection or file revision changed.

### 1.4 Autocomplete geometry and accessibility

**Geometry (values preserved verbatim from the baseline).** Use one shared popover surface for the command and mention menus. Width is `min(420px, available composer width)`, viewport gutter `8px`, maximum height `min(280px, 40vh)`, row minimum height `44px`, horizontal padding `12px`, row gap `8px`, icon `16px`, primary text `13px/20px` and secondary text `11px/16px`. Anchor above the composer by default; reposition into available space on resize and never clip behind an overflow container. Long paths truncate visually but remain available in the accessible name and tooltip.

All baseline values are retained: `420px` · `8px` gutter · `280px` · `40vh` · `44px` · `12px` · `8px` gap · `16px` icon · `13px/20px` primary · `11px/16px` secondary · `2px` focus outline · `2px` focus offset · `500 ms` tooltip delay · `150 ms` search debounce · `200 ms` pending threshold.

**Theme tokens.** Use VS Code theme colors: `editorWidget.background`, `editorWidget.border`, `foreground`, `descriptionForeground`, `list.activeSelectionBackground`, `list.activeSelectionForeground`, and `focusBorder`. These exact IDs are confirmed real on the theme-color reference (per Q06, Verified-with-URL). That reference also lists chat-specific tokens — `chat.slashCommandBackground`, `chat.slashCommandForeground`, `chat.requestBubbleBackground`, `chat.checkpointSeparator` — which are a concrete future upgrade path over the generic widget/list tokens (per Q06, Verified-with-URL). Fallbacks are for missing theme tokens only, not a forced dark theme. Keep a visible `2px` focus outline with `2px` offset. Tooltips appear on hover after `500 ms` and on keyboard focus; they must not contain essential instructions unavailable elsewhere. Respect reduced motion — the webview receives the `vscode-reduce-motion` body class (per Q06, Verified-with-URL) — and maintain readable contrast in light, dark, and high-contrast themes.

**APG combobox conformance.** The textarea exposes combobox semantics; results use listbox/option semantics with stable IDs; DOM focus stays in the textarea while the active result moves. Mapped against the WAI-ARIA APG (per Q19 combobox, Q20 listbox, Q21 keyboard-interface/live-regions — all Verified-with-URL):

| APG requirement (each is checked by the A11Y family in §10) | Conformance rule |
|---|---|
| Combobox roles and relationship | Input role `combobox`; popup role `listbox`; `aria-controls` references the popup; `aria-expanded` false/true |
| Virtual focus | `aria-activedescendant` points at the active option while DOM focus stays on the combobox; `aria-autocomplete="list"` |
| Labeling | HTML `label` else `aria-labelledby`/`aria-label`; options named by visible text (not `aria-label`, which hides descendants) |
| Keyboard navigation | Up/Down move focus; Home/End for lists over five options; type-ahead for lists over seven; wrap behaviour defined |
| Selection state | `aria-selected` on the active option, never combined with `aria-checked`; async lists set `aria-setsize`/`aria-posinset` |
| Focus retention | Focus retained in the textarea; on close move focus to the trigger, never to `body`; Tab follows ordinary order when no menu is open |
| Disabled and async rows | Loading/empty/error rows use `aria-disabled="true"` (focusable, not selectable); a polite live region announces count/failure/selection; `aria-busy` during refresh; never `assertive` |
| Motion, zoom, contrast | Reduced motion honoured; 200% zoom and light/dark/high-contrast keep every control reachable |

APG's "keep disabled rows focusable with `aria-disabled` rather than HTML `disabled`" guidance refines the baseline's non-selectable-row rule (per Q21, Verified-with-URL). The polite live region "not every keystroke or streaming token" is APG-correct rather than `assertive` (per Q21, Verified-with-URL). The baseline geometry and accessibility prose is preserved in full; the A11Y family is new.

## 2. Streaming & rendering

### 2.1 Carrier inventory (message names exact, from the protocol inventory)

One streaming primitive exists today: the host→webview `delta` frame (`src/ui/aiChatPanelMessages.ts:77`; webview case at `webview/aiChatPanelMain.ts:1964–1966`). Every engine funnels into it through the same events shape.

| Carrier | Direction | Anchor | Role in the stream | Status |
|---|---|---|---|---|
| `delta` | host → webview | `src/ui/aiChatPanelMessages.ts:77` | Incremental assistant text; the only carrier feeding the streaming bubble | Verified |
| `assistant` | host → webview | `src/ui/aiChatPanelMessages.ts:59` | Terminal reply; replaces the streaming bubble via `appendAssistant(text, markdown)` (`webview/aiChatPanelMain.ts:1223–1248`) | Verified |
| `done` | host → webview | `src/ui/aiChatPanelMessages.ts:73` | Turn boundary; de-streams the open bubble and clears busy (`webview/aiChatPanelMain.ts:1999`) | Verified |
| `error` | host → webview | `src/ui/aiChatPanelMessages.ts:67` | Non-fatal error bubble; also de-streams (`webview/aiChatPanelMain.ts:1992`) | Verified |
| `step` | host → webview | `src/ui/aiChatPanelMessages.ts:44` | Discrete progress label — not a text chunk (`webview/aiChatPanelMain.ts:1955`) | Verified |
| `tool_result` | host → webview | `src/ui/aiChatPanelMessages.ts:51` | Tool-outcome card (`ok`/`failed`/`denied`) (`webview/aiChatPanelMain.ts:1958`) | Verified |
| `thought` | host → webview | `src/ui/aiChatPanelMessages.ts:87` | ACP reasoning text (`webview/aiChatPanelMain.ts:2015`) | Verified |
| `session_state` | host → webview | `src/ui/aiChatPanelMessages.ts:114` | `connecting`/`running`/`done`/`error` plus `turnId` | Verified |

**Per-engine delta route (all four already converge today):** builtin runs `runAgent` → `provider.streamComplete`, panel `onText` posts `delta` (`src/ui/aiChatPanel.ts:2358`, route at `src/ai/agent.ts:243`); omp maps ACP `session/update` → `agent_message_chunk` → `onDelta` (`src/ai/omp/ompChatEngine.ts:273`); claudeCode carries subprocess stdout through the omp-shaped callbacks (`src/ai/claudeCode/claudeCodeChatEngine.ts:48`), forwarded by `runImageCapableEngineTurn` (`src/ui/aiChatPanel.ts:2754`); codex carries subprocess stdout over stdin (`src/ai/codex/codexChatEngine.ts:64`). All three external routes are redacted at the wire boundary (`src/ui/aiChatPanel.ts:2586`, `src/ui/aiChatPanel.ts:2782`). **The target contract keeps this: no raw engine byte reaches the webview unredacted, and `thought` is redacted the same way.**

### 2.2 Render coalescing policy (target-state; UnicDB-original)

Today each `delta` appends one raw text node and markdown is re-parsed on fence close (`webview/aiChatPanelMain.ts:1272–1320`). At provider chunk rates this re-parses far more often than the display needs. Target rule:

- One animation-frame scheduler coalesces incoming `delta` frames: fragments are buffered and flushed **at most once per 16 ms** (one 60 Hz frame), and a markdown re-parse is capped at **at most once per 50 ms**. Rationale: typed incremental output is the upstream norm (`stream.markdown` is incremental — per Q04, Verified-with-URL), but re-parsing the whole tail per token is required by no precedent and is the dominant cost.
- Coalescing never reorders or drops text: the concatenation of all flushed fragments equals the concatenation of all received `delta` frames, byte-for-byte, per turn.
- The raw accumulated text stays on the bubble dataset so `assistant` can reconcile the final text against what streamed (`webview/aiChatPanelMain.ts:1309–1311`).
- When `assistant` arrives, the coalescer flushes any buffered fragment before the bubble is replaced; the final rendered text includes every received chunk, not a truncated tail.
- **Announcement discipline:** the polite live region announces turn-state changes and the final response, never each coalesced flush (per Q21, Verified-with-URL; per Q04, Verified-with-URL). The a11y family in §1.4 owns announcement cadence; this section only fixes that streaming must not drive per-token announcements.

### 2.3 Partial-markdown and fence policy (target-state)

Today text is appended as a text node and markdown re-renders once a complete fenced block is present (`webview/aiChatPanelMain.ts:1312–1317`). Target rule:

- Text outside any fence renders as inline markdown incrementally.
- An **unclosed** fence renders as a provisional code block whose language class comes from the info string if one is present, and is **re-labelled on close**; the fence delimiter itself is never shown as literal backticks.
- A fence counts as closed only when an even number of triple-backtick delimiters has been seen since the bubble was created; an odd count means open and the block is provisional.
- Incomplete inline spans (an unclosed `**`, backtick, or `[`) render as **literal text** until the closing token arrives; tail characters are never swallowed and never render as a broken emphasis node.
- On `assistant`, the full text renders once through the canonical `appendAssistant(text, markdown)` path with SQL highlighting and copy buttons (`webview/aiChatPanelMain.ts:1223–1248`). If the terminal render throws, the bubble keeps the last good streamed render and the render-failure class in §6 fires.

### 2.4 Stick-to-bottom scroll rule (target-state; concrete px threshold, UnicDB-original)

No scroll-lock constant exists in current source. Target rule:

- While content streams the thread auto-follows the bottom **only if** the viewport is already near it: `scrollHeight - scrollTop - clientHeight <= 24px` (the stick-to-bottom threshold, 24 px). Above that distance the thread must not yank the viewport.
- When auto-follow is suppressed by user scroll, a persistent affordance with the exact string "Jump to latest" appears bottom-center of the stream area (visual spec in §9). Activating it restores the rule and resumes following.
- Auto-follow is cancelled by any explicit user scroll gesture (wheel, scrollbar drag, touch) and re-armed only by reaching the bottom again or activating the affordance.
- `done`/`assistant`/`error` settlement does not force a scroll unless auto-follow was still armed at settlement.

### 2.5 Stop / cancel semantics (target-state)

The composer's Stop button is explicit. Today a builtin Stop aborts the turn's `AbortController` and posts `done` in `finally`, keeping partial text with no error bubble (`src/ui/aiChatPanel.ts:2480`). `/clear` and Escape must never implicitly cancel generation. Target rule:

- Stop ends the in-flight turn only: it does not clear the transcript, does not delete completed tool results, and does not undo side effects already applied — text is preserved in the open bubble. Stopping does not undo file edits, terminal commands, or other actions that already completed (per Q10, Verified-with-URL).
- After Stop the settled bubble shows the exact string "Stopped." and the turn's `session_state` returns to `done`.
- Stop is idempotent: a second Stop on a settled turn is a no-op (no duplicate bubble, no duplicate `done`).
- Queueing and steering are out of scope and are never inferred from typing; they are separate, explicitly-triggered future capabilities (per Q10, Verified-with-URL).
- Stop stays reachable by keyboard while the textarea holds a draft; the draft is preserved verbatim across Stop.

## 3. Activity timeline

### 3.1 Current state — `absent in current source`

No `timeline` or `activity` file or chat identifier exists (a `grep -rniE "timeline|activity"` sweep over `src` and `webview` returns nothing chat-related). The closest artifacts are (a) inline `step` rows — a plain label with no timestamp, id, or status (`src/ui/aiChatPanelMessages.ts:44`, rendered at `webview/aiChatPanelMain.ts:1086`) — and (b) the redacting in-memory `TraceRecorder` (`src/ai/trace.ts:144`), which is attached to turns (`src/ui/aiChatPanel.ts:1299`) but never rendered in the panel. A timeline is therefore a new capability, not a rename of a step row.

### 3.2 Turn / event model (target-state)

The timeline is a per-turn ordered event list derived from carriers the protocol already emits, plus timestamps the host must add. Each event carries:

| Field | Type | Source / rule |
|---|---|---|
| `id` | string | Stable per event; used for collapse state and copy |
| `turnId` | string | Matches `session_state.turnId` (`src/ui/aiChatPanelMessages.ts:114`) |
| `kind` | `thought` \| `step` \| `tool` \| `delta-group` \| `error` | Mapped from the corresponding carriers |
| `at` | ISO-8601 | Wall-clock at receipt; current carriers carry no timestamp (gap) |
| `status` | `running` \| `ok` \| `failed` \| `denied` | `tool_result` already carries `ok`/`failed`/`denied` (`src/ui/aiChatPanelMessages.ts:51`) |
| `label` | string | The existing step/tool string |

Per-engine content rules, honest about what each backend supplies:

- **omp** supplies real reasoning (`thought`) and tool outcomes (`tool_result`) — the richest event stream (`src/ai/omp/ompChatEngine.ts:273`, `src/ai/omp/ompChatEngine.ts:307`).
- **builtin** supplies step labels and tool results only; there is no reasoning channel (`absent in current source` for thoughts on builtin).
- **claudeCode / codex** forward the same omp-shaped callback shape, so event kinds match omp, but the underlying richness is `Unverified-internal` until each adapter's event mapping is confirmed.
- A turn with zero events renders no timeline block at all (no empty chrome).

### 3.3 Collapsibility and content rules (target-state)

- The timeline block is collapsed by default after the turn settles, showing a one-line summary with the exact string pattern "N steps" (e.g. "3 steps"); it is expanded while the turn runs.
- Manual collapse/expand is sticky per turn for the session; expanding one turn does not expand others.
- A `tool_result` with status `failed` or `denied` never collapses its row's status badge — a failure inside a collapsed group is still surfaced as a count (e.g. "3 steps · 1 failed").
- The timeline is read-only history: it never exposes interactive controls inside a listbox option row (APG option rows are flat text — per Q20, Verified-with-URL); it uses ordinary disclosure buttons.
- Clicking an event copies the event, not the whole transcript (per Q11, Verified-with-URL).
- Reasoning text is visually subordinate to tool outcomes and is labelled in words, never shown as an unlabeled wall of model text.

## 4. Sessions & persistence

### 4.1 Current storage mechanism (facts)

- **The extension persists nothing to disk.** Conversation state is the per-panel in-memory history array (`absent in current source` for any extension-owned session store; the only durable policy surface is `UnicDB.ai.showPolicy`, `package.json:282`).
- **Session persistence belongs to the omp child process.** Listing is ACP `session/list` (`src/ai/omp/acp.ts:213`); loading is `session/load` (`src/ai/omp/acp.ts:252`).
- The host filters the list by `cwd`, excludes the current session, sorts by `updatedAt` descending, and caps at 20 (`RESUME_PICKER_CAP`, `src/ui/aiChatPanel.ts:1154`, applied at `src/ui/aiChatPanel.ts:4051`).
- **Resume is omp-only.** Both list and pick post `"Resume requires the omp engine."` for any other engine (`src/ui/aiChatPanel.ts:4020`, `src/ui/aiChatPanel.ts:4072`). `builtin` has no session id at all.
- The webview replays a resumed transcript from the `history` frame, capped by `HISTORY_RENDER_CAP` (`src/ui/aiChatPanelMessages.ts:328`, `src/ui/aiChatPanelMessages.ts:373`).

### 4.2 Session index schema (target-state; new capability)

The extension owns a thin session index; engine-owned transcripts stay with the engine. Fields:

| Field | Type | Rule |
|---|---|---|
| `sessionId` | string | Engine-native id when one exists, otherwise a locally generated id; present for omp (`src/ui/aiChatPanel.ts:4046`) |
| `engine` | `builtin` \| `omp` \| `claudeCode` \| `codex` | Matches the four-literal union (`src/ui/aiChatPanelMessages.ts:102`) |
| `title` | string | First user message truncated to 80 chars, or the rename value |
| `cwd` | string | Workspace folder; the picker filter key |
| `createdAt` / `updatedAt` | ISO-8601 | `updatedAt` drives picker sort order (`src/ui/aiChatPanel.ts:4046`) |
| `resumable` | boolean | True only where native resume is supported (omp) |
| `turnCount` | integer | For the picker's secondary line |
| `hasTranscript` | boolean | True when a local structured transcript exists |

**Privacy boundary.** The index never stores raw secret content. `grounding_state.excludedCount` is today a bare number with no detail (`src/ui/aiChatPanelMessages.ts:190`); the target keeps exclusions as a count plus a policy label, never a dump of excluded content. A single privacy flag that strips prompts and code from captured data is the upstream precedent (per Q18, Verified-with-URL). The index is written **only after a confirmed host write**; a failed write raises the export-failure class in §6 and leaves the prior index intact.

### 4.3 Session picker contents (target-state)

- Rows are capped at 20 — the existing `RESUME_PICKER_CAP` (`src/ui/aiChatPanel.ts:1154`).
- Each row shows a title, a secondary line of engine plus relative `updatedAt`, and a resumability state. Two sessions with the same title must show distinct secondary lines.
- Non-resumable engines show their rows disabled **and explain it**: the row carries the engine's own unsupported string (below) rather than a generic failure. The `aria-disabled` (not HTML `disabled`) convention keeps the row focusable so screen readers can discover it (per Q21, Verified-with-URL).
- The picker uses ordinary dialog/list semantics; its interaction contract and focus policy live in §1.
- Filtering/grouping: time buckets "Today" / "Last Week" / "Older" (target-state; upstream groups sessions by time — per Q05, Verified-with-URL).

### 4.4 Per-engine native-resume wording (must stay per-engine, never global)

| Engine | Native resume | Wording rule | Status |
|---|---|---|---|
| `omp` | supported | Picker enabled; the string `"Resume requires the omp engine."` appears only when the engine is not omp | Verified (`src/ui/aiChatPanel.ts:4020`) |
| `claudeCode` | **unavailable** | Row disabled with `"Claude Code session resume is unavailable"` | Verified (`src/ai/claudeCode/claudeCodeChatEngine.ts:105`, `src/ai/claudeCode/claudeCodeChatEngine.ts:280`) |
| `codex` | **unavailable** | Row disabled with `"Codex session resume is unavailable"` | Verified (`src/ai/codex/codexChatEngine.ts:364`) |
| `builtin` | **no session id** | No native session concept; the picker shows locally saved transcripts only | Verified (`src/ui/aiChatPanel.ts:4020`) |

**Hard rule (preserved into the final spec): viewing a locally saved transcript must never be labelled "native resume".** A local transcript is a client-side replay of stored turns; it is labelled `"Saved transcript"` and can be opened even when the engine reports resume unsupported. Only the omp path may use the words "resume"/"resumed session". This follows the baseline source-anchor rule and the participant-scoped, opt-in history model upstream (per Q05, Verified-with-URL).

### 4.5 Rename / delete / export (target-state; new capability)

- **Rename** — inline edit on the picker row; empty or whitespace-only input is rejected and the prior title restored. Rename persists to the session index only.
- **Delete** — deleting a local index record removes its transcript and requires confirmation with the exact string "Delete this saved transcript? This cannot be undone." Deleting an engine-owned omp session is **not** offered by this UI (`absent in current source` for any engine delete API); the row shows "Managed by the omp engine" instead of a Delete control.
- **Export** — replaces the current path (backend semantics and the exact success/failure strings are owned by §8, which is the single home for engine-command rules). Today export serialises rendered `thread.innerText` and immediately appends the success notice with no host round-trip (`webview/aiChatPanelMain.ts:631`, `webview/aiChatPanelMain.ts:640`). Export format becomes **structured JSON** — the session record above plus an ordered `turns[]` array — matching the upstream JSON export precedent (per Q11, Verified-with-URL).

## 5. Permissions & approvals

### 5.1 Current permission surface inventory (facts)

| Surface | What it gates | Status |
|---|---|---|
| `DbToolPermissionGate` (exported class) | Database tool calls in the builtin path; wraps via `DbToolPermissionGate.wrap` | Verified (`src/ui/aiChatPanel.ts:809`) |
| `permission_request` frame | ACP permission card: `requestId`, `tool`, `options` | Verified (`src/ui/aiChatPanelMessages.ts:143`) |
| HostMcp gate | In-process MCP permission gate used by all three external engines | Verified (`src/ui/aiChatPanel.ts:2918`, construct at `src/extension.ts:2433`) |
| `permission_response` routing | One wire kind, two id-namespaces: DB-tool gate → HostMcp → raw ACP bridge | Verified (`src/ui/aiChatPanel.ts:1668–1679`) |
| Timeout | Default deny after 60 s (`DEFAULT_PERMISSION_TIMEOUT_MS`) | Verified (`src/ui/aiChatPanel.ts:123`, `src/ui/aiChatPanel.ts:3629`) |
| Bypass | Session-scoped, default OFF, never persisted; when ON the webview receives no card | Verified (`src/ui/aiChatPanel.ts:1727`, `src/ui/aiChatPanel.ts:3599`, `src/ui/aiChatPanel.ts:2933`) |
| Plan approval | Separate consent path: `plan_approve`/`plan_reject` on the `change_plan` card, re-validated against the live schema via `confirmDangerousStatements` | Verified (`src/ui/aiChatPanelMessages.ts:241`, `src/ui/aiChatPanelMessages.ts:253`, `src/ui/aiChatPanelMessages.ts:258`, `src/ui/aiChatPanel.ts:4357`) |
| Durable policy surface | `UnicDB.ai.showPolicy` is the only durable policy view | Verified (`package.json:282`) |

**Codex caveat (stated honestly).** The HostMcp gate is constructed and bridged for the codex lane, but the codex CLI route passes no `--mcp-config` in `codex exec` mode, so the gate is **not reachable by the documented CLI route** (`src/extension.ts:2491`, `src/extension.ts:2479`). The codex permissions cell in §7 therefore stays `Unverified-internal`.

### 5.2 Target approval model (Cline-informed, VS Code-adapted)

Today the model is one session-scoped bypass toggle plus a per-request card. The target adopts Cline's escalating, per-tool-class shape — auto-approve is "evaluated per tool call" across labeled toggles, with "all files"/"all commands" requiring their base toggle (per Q12, Verified-with-URL) — adapted to VS Code policy keys (auto-approve modes are harness-specific and must stay engine-gated — per Q22, Verified-with-URL).

- **Approval classes** (each independently configurable): `read-project-files`, `edit-project-files`, `run-safe-commands`, `run-all-commands`, `db-read`, `db-write`, `mcp-tools`. The two escalation pairs (`edit all files` over `edit project files`; `run all commands` over `run safe commands`) require their base class ON — enabling the broad class alone does nothing (per Q12, Verified-with-URL).
- **Per-request default is deny.** An omitted `optionId`, a duplicate response, or the 60 s timeout resolves to `cancelled` with exactly one result per request — preserving the current invariant at `src/ui/aiChatPanel.ts:3649–3677`.
- **Bypass stays session-scoped and default-OFF** unless a durable policy is explicitly opted into; the target adds a durable policy view (not a silent default change). A durable bypass must be visibly indicated in the header for the whole session.
- **Plan approval is a distinct consent path from tool approval** and keeps its re-validation plus `confirmDangerousStatements` before execution (`src/ui/aiChatPanel.ts:4357`).
- **Capability gating:** engines that never surface a permission card, or whose gate is unreachable (codex `codex exec`), must show the class as "Unavailable for this engine", never a toggle that silently does nothing.
- **Prompt content:** each card names the concrete target (file path, SQL statement, command line) and the class it falls under; the card never obscures what is being approved. A plan approval is not a substitute for a per-tool card, and vice versa.

## 6. Failures & recovery

Every class below has a stable id in the FAIL family, defined once in the §10 index; the table names each class and its exact string. Current strings are quoted verbatim from anchors; proposed strings are marked `proposed`.

| Failure class | Trigger | User-visible message (exact) | Recovery action | Status |
|---|---|---|---|---|
| Mid-stream disconnect | The stream stops without `done` or `error` (transport drop) | `"Connection lost during the response. The partial reply is kept."` (proposed) | Keep the partial bubble; offer Retry that re-runs the last user turn; never auto-retry silently | new capability; `src/ui/aiChatPanel.ts:2480` shows Stop alone produces no error path |
| Engine process exit | An external engine child exits mid-turn | `"codex process start failed: <msg>"` (current, codex) / `"claude code chat engine is disposed"` (current, claudeCode) | Mark the turn failed; "Restart engine" re-spawns; transcript preserved | Verified (`src/ai/codex/codexChatEngine.ts:320`, `src/ai/claudeCode/claudeCodeChatEngine.ts:169`) |
| Permission denied or timed out | User denies, or no response within 60 s | `"Permission denied."` for an explicit deny; `"Permission request timed out and was denied."` for the 60 s path (both proposed) | The blocked action is skipped; the turn continues where possible; the timeline records the denied tool | Verified timeout semantics (`src/ui/aiChatPanel.ts:3629`); strings proposed |
| Unresolvable context item | A mention/file reference cannot be resolved at send time | `"This context item could not be resolved: <name>. Remove it or send without it."` (proposed) | Block the send until the chip is removed, replaced, or explicitly sent without; never silently omit | baseline chip rule; new capability for the string |
| Stale or missing session | Resume requested for a session id the engine no longer holds | `"That session is no longer available on this engine."` (proposed); unsupported engines keep their own per-engine strings (§4.4) | Re-open the picker and refresh; if a local transcript exists, offer "Open saved transcript" (never native resume) | Verified (`src/ai/claudeCode/claudeCodeChatEngine.ts:280`, `src/ai/codex/codexChatEngine.ts:364`, `src/ui/aiChatPanel.ts:4020`) |
| Export write failure | Host write of the structured transcript fails or is unacknowledged | `"Export failed. Nothing was written."` (proposed) — replaces the optimistic success notice | Keep the transcript unchanged; offer "Retry export" and "Save a copy…"; never show success before host acknowledgement | current optimistic path Verified (`webview/aiChatPanelMain.ts:640`) |
| Render failure | Terminal `assistant` render throws (markdown/SQL highlight) | `"Could not render the final response. Showing the streamed text."` (proposed) | Keep the last good streamed render visible; log internally; do not blank the bubble | new capability; render path Verified (`webview/aiChatPanelMain.ts:1223–1248`) |
| Engine not configured or fallback | The requested engine seam is not wired | `"<engine> is not configured; falling back to builtin for this turn."` (current) | Run the builtin turn; mark the fallback in the timeline so the user knows which engine answered | Verified (`src/ui/aiChatPanel.ts:2880`) |
| AI not configured | No base URL / API key | Current enriched error bubble naming the Open AI Settings path | Offer "Open AI Settings"; do not retry automatically | Verified (`src/ai/agent.ts:307`, `src/ui/aiChatPanel.ts:2497`) |
| Provider stream fails before any chunk | Zero chunks then a provider error | `"stream fallback"` step label (current) followed by a non-streaming retry | The non-streaming retry is transparent; surface an error only if the retry also fails | Verified (`src/ai/agent.ts:274`, `src/ui/aiChatPanel.ts:2369`) |
| Export unacknowledged | `/export` completes without a host acknowledgement | `"Export failed. Nothing was written."` (proposed) | Same recovery as the export-write class above | new capability |
| Unsupported provider-native command | A typed provider-native command the active engine does not advertise | Draft preserved with a corrective example; no assistant bubble | Never map to a shell; never silently reach a backend | baseline rule |

**Cross-cutting recovery rules.** No failure class may erase the transcript — recovery always preserves already-rendered content. There is no automatic infinite retry: every retry is either one bounded transparent retry (the pre-chunk class) or explicitly user-triggered. Every class maps to a timeline event so the failure is visible in history, not only in a transient banner.

## 7. Engine capability matrix

Four engine rows × eight capability columns. Every cell is `Verified (file:line)`, `Unverified-internal`, or `absent in current source` — no invented capability. Columns: streaming, resume, native commands, model/role picker, sessions/persistence, permissions/approvals, activity events, failure modes.

### 7.1 `builtin` (in-panel fallback; no adapter file)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `onText` posts `delta`; route through `runAgent` → `provider.streamComplete` | Verified (`src/ui/aiChatPanel.ts:2358`) |
| resume | No session concept; list/pick hard-error for non-omp | absent in current source (`src/ui/aiChatPanel.ts:4020`) |
| native commands | Closed six-command registry only | absent in current source (`src/ui/aiChatPanelCommands.ts:2`) |
| model/role picker | `buildModelsFrame`; header chip path | Verified (`src/ui/aiChatPanel.ts:1899`) |
| sessions/persistence | In-memory history only; nothing written to disk | absent in current source (`src/ui/aiChatPanel.ts:2469`) |
| permissions/approvals | `DbToolPermissionGate.wrap`; plan approve via `confirmDangerousStatements` | Verified (`src/ui/aiChatPanel.ts:809`) |
| activity events | No timeline UI; trace ring is in-memory only | absent in current source (`src/ai/trace.ts:144`) |
| failure modes | Abort branch swallows the error; config error enriched | Verified (`src/ui/aiChatPanel.ts:2480`) |

### 7.2 `omp` (ACP child process)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `agent_message_chunk` → `onDelta` | Verified (`src/ai/omp/ompChatEngine.ts:273`) |
| resume | `sessionList`; load path; omp-only | Verified (`src/ui/aiChatPanel.ts:4018`) |
| native commands | `available_commands_update` explicitly ignored | absent in current source (`src/ai/omp/ompChatEngine.ts:332`) |
| model/role picker | Panel-wide `activeRole`; no engine-native model switch | Verified (`src/ui/aiChatPanel.ts:1930`) |
| sessions/persistence | ACP `session/list`; storage owned by the omp child | Verified (`src/ai/omp/acp.ts:213`) |
| permissions/approvals | `permission_request` frame; HostMcp gate | Verified (`src/ui/aiChatPanel.ts:3636`) |
| activity events | Trace recorder is not rendered | absent in current source (`src/ai/trace.ts:144`) |
| failure modes | `session/new failed:` / `session/new cancelled:` | Verified (`src/ai/omp/ompChatEngine.ts:390`) |

### 7.3 `claudeCode` (subprocess adapter)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `ClaudeCodeChatEvents` mirrors omp; panel route | Verified (`src/ai/claudeCode/claudeCodeChatEngine.ts:48`) |
| resume | `RESUME_UNSUPPORTED_MESSAGE`; refuses to spawn | Verified (`src/ai/claudeCode/claudeCodeChatEngine.ts:280`) |
| native commands | No parser or command surface | absent in current source |
| model/role picker | Panel applies `activeRole` generically; no model/CLI mapping | Unverified-internal (`src/ai/claudeCode/claudeCodeChatEngine.ts:63–67`) |
| sessions/persistence | One process, no session store | absent in current source |
| permissions/approvals | `createHostMcp({gatePost…})` + `--mcp-config` written | Verified (`src/extension.ts:2433`) |
| activity events | None rendered | absent in current source |
| failure modes | `disposed`; hostMcp start failed | Verified (`src/ai/claudeCode/claudeCodeChatEngine.ts:169`) |

### 7.4 `codex` (subprocess adapter)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `CodexChatEvents` carried over stdin | Verified (`src/ai/codex/codexChatEngine.ts:64`) |
| resume | `"Codex session resume is unavailable"` | Verified (`src/ai/codex/codexChatEngine.ts:364`) |
| native commands | No parser or command surface | absent in current source |
| model/role picker | Same gap as claudeCode; `send` accepts no model arg | Unverified-internal (`src/ai/codex/codexChatEngine.ts:114–118`) |
| sessions/persistence | No session store | absent in current source |
| permissions/approvals | HostMcp constructed and bridged, but no `--mcp-config` on the documented `codex exec` route | Unverified-internal (`src/extension.ts:2491`, `src/extension.ts:2479`) |
| activity events | None rendered | absent in current source |
| failure modes | Process start failed; resume unavailable | Verified (`src/ai/codex/codexChatEngine.ts:320`) |

**Matrix self-check.** Four rows × eight columns = 32 cells; at least 17 cells carry a distinct `Verified (file:line)` anchor. Every non-verified cell is explicitly `Unverified-internal` or `absent in current source`.

**Target-state overlay.** Resume becomes a per-engine capability the UI must render honestly (§4.4, §6). Native commands become a capability-gated group (§8). Timeline events are derived from carriers all four engines already emit, so the timeline itself is not engine-gated — only its richness is (§3.2).

## 8. Engine-gated command reconciliation (`/engine` `/model` `/resume` `/context` `/export` + native commands)

**Single home for engine-command rules.** This section is the one place the backend semantics, capability gating, and wording rules for these commands live. §1 owns their menu anatomy, argument-grammar presentation, and keyboard interaction and does not restate these rules; §2–§7 reference this section instead of duplicating it.

### 8.1 `/engine` — parser-vs-protocol mismatch (explicit resolution)

Two anchors disagree and the redesign resolves both, not one:

1. `handleCommand("engine" | "model", args)` at `src/ui/aiChatPanel.ts:1744–1816` accepts exactly two literals (`builtin`, `omp`) and otherwise posts `"Usage: /engine builtin|omp"` (`src/ui/aiChatPanel.ts:1779–1781`).
2. The engine frame advertises four engines in its `name` union (`omp`/`claude-code`/`codex`/`builtin`) at `src/ui/aiChatPanelMessages.ts:102`.

**Resolution rule (target-state):** `/engine` becomes **capability-gated command visibility**, not a fixed two-literal parser:

- The set of engines named by `/engine` is exactly the set the host reports as available and switchable in this session. Engines wired through VS Code commands (`UnicDB.ai.useWithClaudeCode` at `package.json:264` and `UnicDB.ai.useWithCodex` at `package.json:270`) are switched through those commands; `/engine` must neither accept a literal it cannot switch to nor silently reject one it can.
- Invalid or unknown arguments keep the draft and show a corrective example; they do not create an assistant reply bubble.
- A switch never reruns the last prompt automatically.
- The host must acknowledge a switch before the UI claims it took effect.
- The new failure string is `"Engine <name> is not available in this workspace."` (proposed) for a known-but-unavailable engine, replacing the misleading usage string when the literal is in fact a real engine.

### 8.2 `/model` — role picker, host-authoritative

The current `/model` text path accepts only `work` or `smart` (`src/ui/aiChatPanel.ts:1757–1763`), while `AiModelRole` has four members (`src/ai/settings.ts:13`) and the `model_select` wire message accepts the full set (`src/ui/aiChatPanelMessages.ts:435`). Target rule, grounded in the upstream separation of role from model (per Q16, Verified-with-URL):

- `/model` opens the host-authoritative **role** picker; the accepted set is the host's configured roles, not a hardcoded pair.
- Arbitrary model ids are never accepted; a raw model id typed after `/model` is treated as an invalid argument (draft preserved, corrective example shown).
- The switch is reflected only after the `models` frame acknowledges it — no optimistic label change.

### 8.3 `/resume` — native resume vs local transcript (wording preserved)

- `/resume` opens the session picker; unsupported native resume is disabled and explained per backend with the exact strings in §4.4 (`src/ai/claudeCode/claudeCodeChatEngine.ts:105`, `src/ai/codex/codexChatEngine.ts:364`, `src/ui/aiChatPanel.ts:4020`).
- **"Local transcript ≠ native resume" is preserved verbatim as a spec rule:** opening a locally saved transcript replays stored turns, is labelled `"Saved transcript"`, and may be offered even where native resume is unavailable; only omp may use resume wording (per Q05, Verified-with-URL).

### 8.4 `/context` — inspector, not a count

Current `/context` is webview-local and prints only history-present plus queued-attachment count (`webview/aiChatPanelMain.ts:658`). On the wire the real context surfaces are `grounding_state`/`grounding_toggle`, `mention_objects`/`mention_miss`/`mention_list`, `models`, and `schemaChanged` (`src/ui/aiChatPanelMessages.ts:188`, `src/ui/aiChatPanelMessages.ts:308`, `src/ui/aiChatPanelMessages.ts:467`, `src/ui/aiChatPanelMessages.ts:292`). Target rule:

- `/context` opens an inspector listing the actual selected items with their chip identities, plus explicit exclusions and privacy boundaries — never merely a count (`grounding_state.excludedCount` alone is insufficient at `src/ui/aiChatPanelMessages.ts:190`).
- The inspector must not trigger a model call (it is read-only over already-known state).
- No new wire frame is required for the items already on the wire; exclusions currently carry no detail, so a detail field is a new capability, linking the single-privacy-flag precedent (per Q18, Verified-with-URL).

### 8.5 `/export` — confirmed host write

The current path is webview-local, lossy, and optimistic: it serialises rendered text and immediately appends `"Transcript exported as <name>"` with no host round-trip (`webview/aiChatPanelMain.ts:631`, `webview/aiChatPanelMain.ts:640`), and there is no export message in either protocol union (`absent in current source`). Target rule:

- `/export` opens a destination/format flow; the host performs the write; the success string is shown only after the host acknowledgement, otherwise the export-failure class in §6 fires.
- The payload is the structured JSON session record (§4.2), not rendered `innerText` (per Q11, Verified-with-URL).
- The operation is idempotent-safe: a re-export overwrites only with confirmation if the destination exists.

### 8.6 Provider-native command gating

`available_commands_update` from ACP is explicitly ignored today (`src/ai/omp/ompChatEngine.ts:332`). Target rule, grounded in commands being registered first-class metadata with bounded per-participant sets (per Q02/Q08, Verified-with-URL) and in provider-native capabilities staying engine-gated (per Q22, Verified-with-URL):

- Local commands and provider-native commands are separately labelled groups in one menu; native commands appear only when the active engine actually advertises them.
- Unknown or provider-native commands are never mapped to shell execution and never silently reach a backend. The `!` terminal escape is engine-gated, not universal — upstream documents it as available only in Agent Host sessions (per Q07, Verified-with-URL).
- Never promise an identical command set across engines: a command absent for the active engine is simply not listed, and a typed-but-unsupported native command receives the corrective invalid-argument treatment (draft preserved).

## 9. Visual acceptance (VIS family — new rendered surfaces)

Geometry and accessibility for the composer and the shared popover live in §1.4 and are not repeated here. This section covers only the new rendered surfaces: stream area, activity timeline, session picker, permission prompts, and failure banners. All values are target-state unless an anchor is given.

**Shared rendering facts (Verified).** Webviews receive body classes `vscode-light`, `vscode-dark`, `vscode-high-contrast`, `vscode-reduce-motion`, and `vscode-using-screen-reader`; theme colors are exposed as CSS variables with `.`→`-` (per Q06, Verified-with-URL). Theme tokens named below are real VS Code IDs from the theme-color reference (per Q06, Verified-with-URL).

| ID | Surface | Contract |
|---|---|---|
| VIS-01 | Stream area: layout and typography | Assistant bubbles use `var(--vscode-editorWidget-background)` with a 1 px `var(--vscode-editorWidget-border)` border and 8 px radius; body text `13px/20px` in `var(--vscode-foreground)`; the reasoning sub-block is `12px/18px` in `var(--vscode-descriptionForeground)`; the streaming caret is a `2px` `var(--vscode-focusBorder)` bar. Markdown reflow during streaming must not change line-height (no vertical jitter between flushes). |
| VIS-02 | Stream area: stick-to-bottom affordance | The "Jump to latest" pill is bottom-center with a `12px` bottom offset, height `28px`, `var(--vscode-button-background)`/`var(--vscode-button-foreground)`; it appears only when the 24 px threshold (§2.4) is exceeded and reaches at least 4.5:1 contrast in all three theme classes. |
| VIS-03 | Activity timeline: node and connector | Rows use `var(--vscode-editorWidget-background)`, `12px` horizontal padding, `8px` vertical gap; the connector line uses `var(--vscode-chat-checkpointSeparator)` at 1 px (the dotted-line timeline precedent — per Q13, Verified-with-URL); status badges are `16px` icons with text labels at `11px/16px` in `var(--vscode-descriptionForeground)`; a failed badge uses `var(--vscode-errorForeground)`. |
| VIS-04 | Session picker: rows and secondary line | Width `min(420px, panel width)`, viewport gutter `8px`, row min-height `44px`, primary title `13px/20px`, secondary engine+timestamp `11px/16px` in `var(--vscode-descriptionForeground)`; the active row uses `var(--vscode-list-activeSelectionBackground)`/`var(--vscode-list-activeSelectionForeground)`; a disabled (non-resumable) row keeps full text opacity and shows an "Unavailable" label — color is never the sole carrier. |
| VIS-05 | Permission prompt: card anatomy | Card uses `var(--vscode-editorWidget-background)` with `var(--vscode-editorWidget-border)`, `12px` padding, `8px` gap; the concrete action target (path/SQL/command) is `13px/20px` in `var(--vscode-foreground)` and is never truncated to an ellipsis-only; Approve uses `var(--vscode-button-background)`, Deny a secondary button style; the 60 s countdown is text, not a color-only bar. A bypass-ON session shows a persistent header badge reading `"Permissions bypassed"`. |
| VIS-06 | Failure banner: placement and non-destructiveness | Banners render inline at the failed turn, use `var(--vscode-inputValidation-errorBackground)`/`var(--vscode-inputValidation-errorBorder)` with `var(--vscode-errorForeground)` text at `12px/18px`, `8px` padding, and never cover the streamed text they describe; a banner contains at most one primary recovery action plus the failure string. |
| VIS-07 | 200% zoom | At 200% browser zoom in a 480 px-wide panel, every new surface (stream area, timeline, session picker, permission prompt, failure banner) stays readable with no horizontal scrollbar, no clipped recovery button, and no overlap between the "Jump to latest" pill and the failure banner. |
| VIS-08 | Reduced motion and forced themes | Under `vscode-reduce-motion`, every transition on the new surfaces is disabled (stream caret blink, timeline disclosure animation, banner fade) and content appears instantly; in `vscode-light`, `vscode-dark`, and `vscode-high-contrast`, all named tokens resolve to the theme's values with no hardcoded fallback overriding a present token, focus outlines use `var(--vscode-focusBorder)` at `2px` with `2px` offset, and contrast is at least 4.5:1 for body text and 3:1 for borders/icons. |

**Legacy real-token note.** `editorWidget.background`, `editorWidget.border`, `foreground`, `descriptionForeground`, `list.activeSelectionBackground`, `list.activeSelectionForeground`, and `focusBorder` are Verified-with-URL theme IDs (per Q06); the chat-specific `chat.slashCommandBackground`, `chat.slashCommandForeground`, `chat.requestBubbleBackground`, and `chat.checkpointSeparator` are also Verified-with-URL and are the preferred upgrades where they apply (per Q06).

## 10. Acceptance-test index (every id, defined once)

This is the single authoritative index. Each id appears exactly once in this document; narrative sections reference the family by name and this section by number. IDs in **bold** are new relative to the baseline; the rest are baseline IDs preserved.

**KBD — composer keyboard**

- KBD-01: Enter sends one ordinary message; Shift+Enter inserts one newline and sends none.
- KBD-02: repeat that assertion with the command and mention menus open.
- KBD-03: IME composition Enter never sends or selects; Enter after `compositionend` works normally.
- KBD-04: Ctrl/Cmd+Enter sends nothing, in every menu state.
- KBD-05: a running turn allows draft editing without a second send.
- KBD-06: Escape closes the menu without losing text or stopping generation.
- KBD-07: repeated Enter and double-click send produce one acknowledged turn.
- **KBD-08**: Shift+Enter while a menu is open inserts one newline, keeps the draft, and closes the menu.
- **KBD-09**: while a turn runs, the inline hint is visible and Enter does not enqueue.
- **KBD-10**: closing a menu by Escape or by selection never mutates text outside the active token.

**SLASH — command menu**

- SLASH-01: toolbar click and typed slash open the same menu.
- SLASH-02: Enter/Tab select a command without execution; the next Enter executes.
- SLASH-03: invalid arguments preserve the draft.
- SLASH-04: URLs and paths do not trigger the menu.
- SLASH-05: unknown commands require an explicit Send as text.
- SLASH-06: clear has confirmation, an engine switch has host acknowledgement, and export waits for a successful write.
- **SLASH-07**: toolbar, row click, Enter, and Tab all insert through the single authoritative path and notify the composer model.
- **SLASH-08**: `/engine` and `/model` reject values outside host-advertised capabilities with a corrective example.
- **SLASH-09**: `/help` opens the catalog in the same surface; `/new` starts a conversation while saved history remains.

**MENTION — mention menu and chips**

- MENTION-01: duplicate filenames and tables remain distinguishable.
- MENTION-02: an older async response cannot replace newer results.
- MENTION-03: a response arriving after Escape cannot reopen the menu.
- MENTION-04: inserting a reference preserves text before and after the active token.
- MENTION-05: paste and caret movement update detection.
- MENTION-06: removing context removes only that reference.
- MENTION-07: missing/forbidden files cannot silently enter or disappear from a sent prompt.
- MENTION-08: previews and search do not trigger model calls.
- MENTION-09: loading, error, and empty rows cannot submit.
- MENTION-10: a narrow panel, 200% zoom, and keyboard-only interaction keep every control reachable.
- **MENTION-11**: a chip exposes the enumerated field set and stores no raw secret content.
- **MENTION-12**: at send time a changed pinned revision raises a warning and never silently swaps content.

**A11Y — accessibility**

- **A11Y-01**: the textarea exposes `combobox` with `aria-controls` and `aria-expanded` mirroring menu visibility.
- **A11Y-02**: `aria-activedescendant` tracks the active option while DOM focus stays in the textarea.
- **A11Y-03**: the composer is labelled and options are named by visible text.
- **A11Y-04**: Up/Down/Home/End and type-ahead navigate options per the APG listbox pattern.
- **A11Y-05**: `aria-selected` marks exactly one active option; async lists set `aria-setsize`/`aria-posinset`.
- **A11Y-06**: on close, focus returns to the trigger; Tab follows ordinary order when no menu is open.
- **A11Y-07**: loading/empty/error rows are `aria-disabled` and non-selectable; a polite live region announces count, failure, and selection; never `assertive`.
- **A11Y-08**: reduced motion is honoured, and 200% zoom plus light/dark/high-contrast keep every control reachable.

**STREAM — streaming and rendering**

- **STREAM-01**: received frames render in order with no dropped or duplicated fragment; rendered text equals the concatenation of frames.
- **STREAM-02**: coalescing flushes at most once per 16 ms and re-parses markdown at most once per 50 ms under a burst of 100 or more synthetic deltas; the final text is complete.
- **STREAM-03**: an unclosed fence renders as a provisional code block with no literal backticks and is re-labelled with the correct language on close.
- **STREAM-04**: auto-follow engages only within the 24 px stick-to-bottom threshold; a user scroll above it suppresses following and shows "Jump to latest".
- **STREAM-05**: `assistant`, `done`, and `error` each de-stream the open bubble exactly once; a settled bubble is never re-entered into streaming state.
- **STREAM-06**: Stop during an in-flight turn appends "Stopped.", keeps partial text, posts one `done`, and is idempotent on a second press.
- **STREAM-07**: an external-engine `delta` and `thought` are redacted before reaching the webview; a raw secret-shaped token in a chunk does not appear in the DOM.

**TIME — activity timeline**

- **TIME-01**: a settled multi-event turn renders a collapsed summary matching "N steps"; the count equals the rendered event count.
- **TIME-02**: expanding one turn's timeline leaves every other turn's collapse state unchanged.
- **TIME-03**: a failed or denied tool inside a collapsed timeline still surfaces a non-zero failed count.
- **TIME-04**: an event's `turnId` matches the turn's `session_state.turnId`, and events render in receipt order.
- **TIME-05**: a turn with zero events renders no timeline block.
- **TIME-06**: the timeline contains no focusable control inside a listbox option row; all controls are ordinary buttons in the normal tab order.

**SESS — sessions and persistence**

- **SESS-01**: the picker lists at most 20 sessions, filtered by the current `cwd` and sorted by `updatedAt` descending, with the current session excluded.
- **SESS-02**: on `claudeCode`, `codex`, and `builtin`, native resume is disabled and the engine-specific string from §4.4 is shown; no global "resume unavailable" claim is rendered.
- **SESS-03**: opening a locally saved transcript is labelled "Saved transcript" and never uses the word "resume".
- **SESS-04**: rename rejects empty/whitespace input and persists a non-empty value; delete requires the confirmation string and removes the local transcript.
- **SESS-05**: export writes structured JSON and shows the success string only after the host acknowledgement; an unacknowledged write shows the export-failure class instead.
- **SESS-06**: a session with a non-resumable engine is rendered with `aria-disabled` (focusable), not HTML `disabled`, so it remains discoverable.
- **SESS-07**: a failed session-index write leaves the previous index intact (no partial overwrite).
- **SESS-08**: `/engine` lists exactly the engines available and switchable in this session; a known-but-unavailable literal shows `"Engine <name> is not available in this workspace."` and preserves the draft.
- **SESS-09**: `/model` accepts only host-configured roles and reflects the switch only after the `models` acknowledgement; an arbitrary model id preserves the draft.
- **SESS-10**: `/context` lists actual items, exclusions, and privacy boundaries, and performs no model call.

**PERM — permissions and approvals**

- **PERM-01**: an unanswered request settles to deny at 60 s with a `cancelled` outcome and exactly one result per `requestId`.
- **PERM-02**: enabling `run all commands` without `run safe commands` produces no change in what is auto-approved (base-toggle dependency).
- **PERM-03**: bypass is OFF by default, does not persist across reloads unless durably opted in, and when ON the webview receives no card.
- **PERM-04**: an engine whose gate is unreachable shows its approval classes as "Unavailable for this engine" rather than as inert toggles.
- **PERM-05**: plan approve re-validates against the live schema and runs the dangerous-statement confirmation before any statement executes; reject discards without executing.
- **PERM-06**: a permission response with an id in either namespace (DB-tool or HostMcp) resolves against the correct pending request and never cross-resolves namespaces.

**FAIL — failures and recovery**

- **FAIL-01**: a stream that ends without `done`/`error` shows the disconnect string, keeps the partial reply, and offers a working Retry.
- **FAIL-02**: an engine exit shows the engine's exact current string and preserves the transcript; "Restart engine" re-spawns successfully.
- **FAIL-03**: deny and the 60 s timeout both resolve to exactly one denied result and produce their distinct strings (denied vs timed-out).
- **FAIL-04**: a send with an unresolvable chip is blocked with the resolution string until the user removes/replaces it or explicitly sends without it.
- **FAIL-05**: a stale session id shows the missing-session string and re-opening the picker refreshes the list; a local transcript is offered as "saved transcript", never "resume".
- **FAIL-06**: a simulated host write failure shows "Export failed. Nothing was written." and never shows the success string.
- **FAIL-07**: a terminal render exception keeps the streamed text visible and shows the render-failure string.
- **FAIL-08**: an unwired engine seam falls back to builtin, shows the fallback string, and never erases the transcript.
- **FAIL-09**: an unconfigured provider shows the enriched error with an "Open AI Settings" action and never retries automatically.
- **FAIL-10**: a provider that fails before any chunk performs one transparent non-streaming retry and surfaces an error only if that retry also fails.
- **FAIL-11**: `/export` shows success only after host acknowledgement; an unacknowledged write shows the export-failure string.
- **FAIL-12**: a typed provider-native command the active engine does not advertise is never executed via a shell and never creates an assistant bubble (draft preserved).

**VIS — visual acceptance**

- Defined and enumerated in §9; the eight VIS ids are the normative contracts there (stream area layout; stick-to-bottom affordance; timeline node and connector; session picker rows; permission card; failure banner; 200% zoom; reduced motion and forced themes).

## 11. Baseline preservation and supersession ledger

**Nothing from the baseline was silently lost.** Every baseline element is retained verbatim, upgraded in place, or superseded with explicit rationale.

| Baseline element | Disposition |
|---|---|
| Keyboard order prose (IME → Shift+Enter → menu → Enter) | Upgraded in place into the §1.1 state machine; supersedes-rationale recorded there. |
| Slash trigger "at the beginning of an otherwise empty command line" | Superseded by "start of the trimmed input, first token with no whitespace"; rationale in §1.2. |
| Mention trigger "not inside email addresses or fenced code" | Superseded by the prev-character grammar plus fence tracker; rationale in §1.3. |
| All geometry and timing values | Retained verbatim in §1.4 and §9: `420px`, `8px` gutter, `280px`, `40vh`, `44px`, `12px`, `8px` gap, `16px` icon, `13px/20px`, `11px/16px`, `2px` focus outline, `2px` offset, `500 ms` tooltip, `150 ms` debounce, `200 ms` pending. |
| Baseline acceptance IDs (7 keyboard, 6 slash, 10 mention) | Retained verbatim in §10; extended, never renumbered. |
| Source-anchor claims | Re-verified in §12; the known off-by-1/2 ranges were corrected to the fact-base's `corrects` verdicts rather than carried forward. |
| "Do not attribute proposed behaviors to the unnamed extensions" | Retained and strengthened by the named-subject substitution in §Evidence status. |
| "No runtime source changes authorized" | Retained in §Scope and §Appendix A. |

**New families added by this consolidation:** A11Y (8), STREAM (7), TIME (6), SESS (10), PERM (6), FAIL (12), VIS (8). They extend the index; no baseline ID changed meaning.

## 12. Source anchors (re-verified against the current tree)

All anchors below were parsed by the automated anchor gate this cycle: every file exists and every range is in-bounds. Ranges corrected from the baseline (which was off by one or two lines) use the fact-base's corrected values.

**Webview — composer and menus.** `webview/aiChatPanelComposer.ts:441–457` (slash-toolbar splice and direct value write), `webview/aiChatPanelComposer.ts:449` (the direct write), `webview/aiChatPanelComposer.ts:496–504` (bubble-phase Enter listener; `:498` is the only Shift guard), `webview/aiChatPanelMain.ts:792–895` (capture-phase listener), `webview/aiChatPanelMain.ts:801–810` (state-dependent Ctrl/Cmd+Enter suppression), `webview/aiChatPanelMain.ts:812` (mention Enter/Tab branch, no Shift check), `webview/aiChatPanelMain.ts:819–825` (missing-token silent close), `webview/aiChatPanelMain.ts:864–866` (main-side slash fill writing both the DOM and the composer model), `webview/aiChatPanelMain.ts:872` (slash Enter branch, no Shift check), `webview/aiChatPanelMain.ts:897–900` (input listener early-return while mention open), `webview/aiChatPanelMain.ts:907–931` (keyup-only mention detection; the query-only post is at `:930`), `webview/aiChatPanelMain.ts:291–303` (`findAtTokenStart`), `webview/aiChatPanelMain.ts:318–331` (non-selectable "No matches" row), `webview/aiChatPanelMain.ts:574–605` (slash dropdown render), `webview/aiChatPanelMain.ts:595–599` (row-click direct write), `webview/aiChatPanelMain.ts:607–616` (partial-command filter), `webview/aiChatPanelMain.ts:643–671` (command execution switch), `webview/aiChatPanelMain.ts:658` (local `/context` summary), `webview/aiChatPanelMain.ts:663–665` (export case), `webview/aiChatPanelMain.ts:666–669` (only engine/model cross the wire), `webview/aiChatPanelMain.ts:2027–2032` (last-arrived mention list cached), `webview/aiChatPanelMain.ts:2033–2035` (mention miss row).

**Webview — streaming and export.** `webview/aiChatPanelMain.ts:1223–1248` (terminal assistant render), `webview/aiChatPanelMain.ts:1272–1320` (`appendDelta`; raw-stream dataset at `:1309–1311`; fence re-render at `:1312–1317`), `webview/aiChatPanelMain.ts:1328–1342` (de-stream), `webview/aiChatPanelMain.ts:1964–1966` (delta case), `webview/aiChatPanelMain.ts:1955` (`step` case), `webview/aiChatPanelMain.ts:1958` (`tool_result` case), `webview/aiChatPanelMain.ts:1976` (assistant case), `webview/aiChatPanelMain.ts:1992` (error case), `webview/aiChatPanelMain.ts:1999` (done case), `webview/aiChatPanelMain.ts:2015` (thought case), `webview/aiChatPanelMain.ts:629–640` (export; `:631` innerText serialization, `:640` optimistic notice), `webview/aiChatPanelMain.ts:1086` (inline step row), `webview/aiChatPanelMain.ts:1299` (trace attach).

**Host — commands, sessions, permissions.** `src/ui/aiChatPanelCommands.ts:2–9` (registry), `src/ui/aiChatPanelCommands.ts:36–84` (parser), `src/ui/aiChatPanelCommands.ts:44` (unknown-command null), `src/ui/aiChatPanelCommands.ts:80` (unclosed-quote null), `src/ui/aiChatPanel.ts:1744–1816` (`handleCommand`), `src/ui/aiChatPanel.ts:1779–1781` (two-literal engine parser), `src/ui/aiChatPanel.ts:1757–1763` (two-value model text path), `src/ai/settings.ts:13` (`AiModelRole`), `src/ai/settings.ts:24` (`AiEngine`), `src/ui/aiChatPanel.ts:4020` and `src/ui/aiChatPanel.ts:4072` (omp-only resume posts), `src/ui/aiChatPanel.ts:4018` (session list), `src/ui/aiChatPanel.ts:4046` and `src/ui/aiChatPanel.ts:1154` (picker filter/sort/cap), `src/ui/aiChatPanel.ts:2469` (in-memory history append), `src/ui/aiChatPanel.ts:1299` (trace attach), `src/ui/aiChatPanel.ts:809` (`DbToolPermissionGate`), `src/ui/aiChatPanel.ts:2918` (HostMcp gate), `src/ui/aiChatPanel.ts:3636` (permission request frame), `src/ui/aiChatPanel.ts:1668–1679` (two-namespace response routing), `src/ui/aiChatPanel.ts:123` and `src/ui/aiChatPanel.ts:3629` (60 s timeout), `src/ui/aiChatPanel.ts:1727`, `src/ui/aiChatPanel.ts:3599`, `src/ui/aiChatPanel.ts:2933` (bypass), `src/ui/aiChatPanel.ts:3649–3677` (default-deny, one result), `src/ui/aiChatPanel.ts:4357` (plan re-validation), `src/ui/aiChatPanel.ts:2880` (engine fallback), `src/ui/aiChatPanel.ts:2480` (abort branch), `src/ui/aiChatPanel.ts:2497` (enriched config error), `src/ui/aiChatPanel.ts:2358` (builtin onText), `src/ui/aiChatPanel.ts:1899` `buildModelsFrame`, `src/ui/aiChatPanel.ts:1930` (`handleModelSelect`), `src/ui/aiChatPanel.ts:2369` (stream-fallback step), `src/ui/aiChatPanel.ts:2586` and `src/ui/aiChatPanel.ts:2782` (redaction boundaries), `src/ui/aiChatPanel.ts:2754` (external-engine turn route).

**Host — protocol and engines.** `src/ui/aiChatPanelMessages.ts:44` (step), `:51` (tool_result), `:59` (assistant), `:67` (error), `:73` (done), `:77` (delta), `:87` (thought), `:102` (four-engine union), `:114` (session_state), `:143` (permission request), `:188` (grounding state), `:190` (bare excluded count), `:241` `:253` `:258` (plan card/approve/reject), `:292` (schemaChanged), `:308` (mention_objects), `:328` (`HISTORY_RENDER_CAP`), `:361` `:373` (resume render caps), `:425` (command union), `:435` (model_select), `:467` (grounding toggle). `src/ai/agent.ts:243` (builtin stream route), `:274` (stream-fallback hook), `:307` (config error), `src/ai/omp/ompChatEngine.ts:273` (omp delta), `:307` (tool result), `:332` (ignored available_commands_update), `:390` (session/new failure), `src/ai/omp/acp.ts:213` `sessionList`, `:252` `sessionLoad`, `src/ai/trace.ts:8` (`TraceKind`), `src/ai/trace.ts:144` (`TraceRecorder`), `src/ai/claudeCode/claudeCodeChatEngine.ts:48` (events shape), `:105` (resume message), `:169` (disposed), `:280` (resume refusal), `src/ai/codex/codexChatEngine.ts:64` (events shape), `:320` (process start failure), `:364` (resume message), `src/extension.ts:2433` (claudeCode HostMcp), `:2479` `:2491` (codex HostMcp wiring without `--mcp-config`).

**Baseline corrections carried into this spec.** `src/ui/aiChatPanelCommands.ts:1–83` → corrected to registry `:2–9` + parser `:36–84`. `src/ui/aiChatPanelMessages.ts:91–106` → corrected to `:92–107` (union at `:102`). `src/ai/claudeCode/claudeCodeChatEngine.ts:272–279` → corrected to `:273–281`. `src/ai/codex/codexChatEngine.ts:357–364` → corrected to `:358–365`. `src/ui/aiChatPanel.ts:1744–1816` → confirmed (`handleCommand` closes at `:1817`; the range is inclusive of the cited behavior).

**Post-review single-line corrections.** The independent review of TASK-AICHAT-002/005/006 found four single-line citations whose claim was verified true but whose line number was stale; all are corrected above and logged here: `RESUME_PICKER_CAP` definition `:1173` → `:1154` (applied at `:4051`); the redaction boundary `:2601` → `:2586`; `TraceRecorder` `trace.ts:11` → `:144` (with `TraceKind` pinned to `:8`); the parser's unclosed-quote null `aiChatPanelCommands.ts:44` → `:80` (`:44` is the unknown-command null). The full anchor set re-checks 133 distinct `file:line` anchors, all in-bounds.

## 13. Research grounding index (`per Qnn`)

| Rule in this spec | Research basis | Label |
|---|---|---|
| §1.1 stop/queue/steer separation | Stop is explicit; queue/steer are separate labeled actions | Q10, Verified-with-URL |
| §1.2 slash discovery mixes built-in and contributed commands | "Type `/` in the chat input to see all available commands" | Q08, Verified-with-URL |
| §1.2 per-participant command bound; §8.6 native gating | Commands are registered first-class metadata with bounded sets | Q02/Q08, Verified-with-URL |
| §1.2 select-then-execute flow | Type `/`, select the prompt, then add instructions | Q15, Verified-with-URL |
| §1.3 `@`-selects-context model | `@`-mentions select participants; a single sigil attaches files/folders/selection | Q09/Q22, Verified-with-URL |
| §1.3 database metadata-not-rows boundary | Continue `@Database` references schemas, not rows | Q14, Verified-with-URL |
| §1.3 duplicate disambiguation (UnicDB-original) | No fetched page documents an equivalent | Q09 sub-part, Could-not-verify |
| §1.4/§9 theme tokens and reduced-motion class | Exact theme IDs; `vscode-reduce-motion`; chat-specific tokens | Q06, Verified-with-URL |
| §1.4 combobox/listbox/activedescendant | Editable combobox and listbox APG patterns | Q19/Q20, Verified-with-URL |
| §1.4/§3.3 focus retention, `aria-disabled`, polite live region | Keyboard-interface and live-region practices | Q21, Verified-with-URL |
| §2.2 announce-not-per-token | Streaming is incremental and typed; announcements are polite | Q04, Verified-with-URL |
| §3.3 dotted-line timeline node/connector | Checkpoint dotted timeline with Compare/Restore | Q13, Verified-with-URL |
| §4.2/§4.5 privacy flag and structured JSON export | Single privacy flag strips prompts/code; JSON chat export | Q18/Q11, Verified-with-URL |
| §4.3 time-grouped session picker | Session units with time buckets and rename/archive | Q05, Verified-with-URL |
| §5.2 per-tool approval classes with base-toggle escalation | Auto-approve is evaluated per tool call | Q12, Verified-with-URL |
| §5.2/§8.6 engine-gated policy and native commands | Auto-approve and provider escapes are harness-specific | Q22, Verified-with-URL |
| §8.2 role vs model | Config keeps role separate from model | Q16, Verified-with-URL |
| §2.5 stop/retry contract stated as UnicDB target | In-IDE streaming cancel/retry UI not found for Continue | Q17 sub-part, Could-not-verify |

## Appendix A — Implementation sequencing (future work; nothing here is authorized in this cycle)

This appendix exists so the next cycle can plan waves directly from this document. It sequences **future** work into independent chunks and explicitly does **not** authorize any implementation now. Chunk boundaries are chosen so each chunk is independently verifiable and can ship without waiting on a sibling.

**Chunk 1 — Composer keyboard controller (self-contained).** Collapse the two listeners into the §1.1 controller; implement modifier order, the running-turn hint, and draft preservation. Verifiable by the keyboard family alone. Depends on nothing else.

**Chunk 2 — Single menu-insertion path (self-contained).** Route toolbar, row click, Enter, and Tab through one authoritative insertion path that notifies the composer model; fix the missing-token silent close. Verifiable by the slash family. Independent of Chunk 1 (shares the menu DOM only).

**Chunk 3 — Mention correlation and detection.** Move detection onto the shared detector (input/paste/selection/compositionend) and add request-id plus draft-revision correlation. Verifiable by the mention family. Independent of Chunks 1–2.

**Chunk 4 — Autocomplete geometry and a11y.** Implement the APG combobox/listbox semantics, stable option ids, live region, and the shared popover styling. Verifiable by the a11y family. Depends on Chunks 1–3 only for the popover host to exist.

**Chunk 5 — Streaming coalescing and markdown policy.** Implement the frame scheduler, fence state machine, and stick-to-bottom rule; preserve redaction. Verifiable by the streaming family. Independent of Chunks 1–4.

**Chunk 6 — Activity timeline.** Add the per-turn event model and wire frame; render collapsed/expanded disclosure. Verifiable by the time family. Depends on Chunk 5 only for the carrier-to-event mapping.

**Chunk 7 — Sessions and structured export.** Add the session index, picker contents, per-engine resume wording, and host-confirmed structured JSON export. Verifiable by the sessions and export families. Depends on Chunk 8 for the host write acknowledgement seam.

**Chunk 8 — Permissions and approvals.** Implement the per-tool approval classes with base-toggle escalation and the durable policy view. Verifiable by the permissions family. Independent of Chunks 1–7.

**Chunk 9 — Failure and recovery classes.** Implement the exact strings, recovery actions, and timeline mapping for every class in §6. Verifiable by the failure family. Depends on Chunk 6 for timeline events and Chunk 7 for the export-write path.

**Chunk 10 — Visual acceptance pass.** Apply the §9 visual contracts and verify the 200% zoom and reduced-motion cases. Verifiable by the visual family. Cross-cuts Chunks 1–9 but ships last.

**Sequencing notes.** Chunks 1–4 (composer surface) and Chunks 5–6 (stream/timeline) can proceed in parallel. Chunk 7 should follow Chunk 8 because the export acknowledgement path is a permission-adjacent host write. No chunk may introduce a wire frame that contradicts §8; engine-command semantics live only there.
