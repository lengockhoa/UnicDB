# UnicDB AI Chat — Research & implementation specification

Status: Draft in progress. This document is a proposed redesign, not an implemented feature or a verified comparison of external extensions.

## Scope

Improve the existing VS Code AI Chat experience while retaining the OMP, Claude Code, Codex and builtin integration boundaries. Specify composer, slash commands, mentions, streaming, activity timeline, sessions, permissions, failures, accessibility and visual acceptance criteria. No runtime source changes are authorized by this research deliverable.

## Evidence status

Local source reading works. External research is currently blocked: the page-fetch tool reports that its safety service is unavailable; web searches returned no result blocks. The three requested Marketplace extensions have not yet been inspected. Do not attribute proposed behaviors to them or assume their repositories, licenses or maintenance status.

The source files already inspected include webview/aiChatPanelComposer.ts, webview/aiChatPanelHeader.ts, webview/aiChatPanelThread.ts, src/ui/aiChatPanelMessages.ts and src/ui/aiChatPanelCommands.ts. Further source verification and the full specification are pending.

## Composer interaction contract — proposed, mandatory for implementation

This section defines the target behavior, not an assertion that external extensions implement it identically. The implementation must reuse and consolidate existing slash/mention handlers rather than attach another competing key listener.

### Keyboard precedence

A single composer keyboard controller owns submission and autocomplete. First check IME composition (`isComposing` and composition lifecycle); Enter during composition must never send or select an item. Next handle Shift+Enter: always insert one newline at the current selection, close autocomplete, preserve surrounding text and resize the input. This rule applies even while `/` or `@` menus are open. Next handle the active autocomplete menu; only after that may plain Enter submit. Ctrl/Cmd+Enter preserves the existing no-send contract. Escape closes the topmost menu and preserves the draft; it never cancels generation implicitly.

Plain Enter with no menu submits one nonempty draft only when the turn is idle and selected context is valid. Repeated keydown or a double click must not create duplicate turns. While a turn runs, the textarea remains editable for the next draft, but Enter does not enqueue or send; an inline hint says “AI is responding. Your draft is kept.” Stop remains an explicit button. Queueing and steering are separate future capabilities, never inferred from typing.

### Slash menu

Typing `/` at the beginning of an otherwise empty command line opens a local command menu. A slash in a URL, file path, code fence, or normal sentence must not open it. The toolbar slash button focuses the composer and opens this same menu through the controller; it must not only mutate textarea.value without notifying the controller. If prose already exists, the button opens command browsing without silently replacing that prose.

The menu shows command name, a short description, argument hint and availability. Local commands appear immediately without a network spinner. Up/Down moves the active item and scrolls it into view. Enter, Tab or clicking an item selects and inserts its command template; selection never executes it. A second Enter with the menu closed executes a complete valid command. Escape preserves the typed prefix. Shift+Enter always inserts a newline. Unknown commands show an inline validation message with “Send as text” as an explicit alternative; they must not silently reach a backend as if supported.

`/clear` invokes confirmation before clearing an existing conversation and explains that it does not delete saved sessions. While a turn runs, confirmation explicitly says it will stop the turn first. `/resume` opens the session picker, with unsupported native resume disabled and explained per backend. `/engine` opens the engine picker; explicit arguments accept only capabilities advertised by the host, including OMP, Claude Code, Codex and builtin when available. A switch never reruns the last prompt automatically. `/model` opens the host-authoritative model/role picker; it must not accept arbitrary model IDs or claim a switch before acknowledgement. `/context` opens a context inspector showing the actual selected items, exclusions and privacy boundaries, not merely a count of pending images. `/export` opens an export destination/format flow and reports success only after the host confirms a successful write.

Proposed additions are `/help` for the command catalog and `/new` for a new conversation while preserving saved history. Provider-native commands form a separately labelled, capability-gated group. Do not fabricate native commands, map them to shell execution, or promise identical command sets across engines. Commands with missing arguments open their relevant picker. Invalid arguments keep the input and show a corrective example; they do not create an assistant reply bubble.

### Mention menu

Typing `@` at a token boundary opens context search. Do not trigger inside email addresses or fenced code. The initial categories are Files, Editor selection and Database objects. Existing database-object mention behavior must remain supported. Optional folders, diagnostics, git diff and terminal output are later capabilities and stay hidden until implemented with explicit content and privacy rules.

Each result has a kind icon, name, secondary disambiguating path or connection/schema, and availability. Two files named index.ts must show distinct workspace-relative paths. Two tables with the same name must show distinct connection/schema identifiers. A database mention initially includes metadata, not table rows; obtaining rows remains a separate governed tool action.

Debounce remote/host search by 150 ms. Every request and result carries a requestId plus draft revision; stale results must not replace a newer query or reopen a dismissed menu. Show “Searching…” only if the request is still pending after 200 ms. Empty results say “No matching context”; an error says “Could not search context” with Retry that preserves the query. No result, error or loading row is selectable.

Up/Down changes selection; Enter/Tab/click inserts the selected reference without submitting. Escape preserves literal text. Shift+Enter inserts a newline and closes the menu. Replacement affects only the active @ token, never the rest of the draft. Preserve text after the caret and restore focus and caret after insertion. Pasting text and editing with mouse selection must trigger the same token detector as typing; do not rely only on keyup.

Selected context appears in removable chips above the textarea. Keep a structured identity separate from the displayed label: kind, stable URI/object ID, range where applicable, source revision and resolution state. Do not store raw secret content in chip datasets. Removing a chip removes its reference from the outgoing context, not the user's unrelated prose. Unresolvable references show a warning and require removal, replacement or an explicit “Send without this context” action; never silently omit them. Previewing a chip does not send its content to a model. Refresh context at send time and warn when a pinned selection/file revision changed.

### Autocomplete geometry and accessibility

Use one shared popover surface for slash and mention search. Width is min(420px, available composer width), viewport gutter 8px, maximum height min(280px, 40vh), row minimum height 44px, horizontal padding 12px, row gap 8px, icon 16px, primary text 13px/20px and secondary text 11px/16px. Anchor above the composer by default; reposition into available space on resize and never clip behind an overflow container. Long paths truncate visually but remain available in the accessible name and tooltip.

Use VS Code theme colors: editorWidget.background, editorWidget.border, foreground, descriptionForeground, list.activeSelectionBackground, list.activeSelectionForeground and focusBorder. Fallbacks are for missing theme tokens only, not a forced dark theme. Keep a visible 2px focus outline with 2px offset. Tooltips appear on hover after 500 ms and on keyboard focus; they must not contain essential instructions unavailable elsewhere. Respect reduced motion and maintain readable contrast in light, dark and high-contrast themes.

The textarea exposes combobox semantics with aria-expanded, aria-controls and aria-activedescendant. Results use listbox/option semantics with stable IDs. Keep DOM focus in the textarea while moving the active result. Announce result count, search failure and selection via a polite live region, not every keystroke or streaming token. Tab selects a valid active result only while autocomplete is open; otherwise it follows the ordinary focus order.

### Required interaction acceptance tests

KBD-01: Enter sends one ordinary message; Shift+Enter inserts one newline and sends none. KBD-02: repeat that assertion with slash and mention menus open. KBD-03: IME composition Enter never sends or selects; Enter after composition works normally. KBD-04: Ctrl/Cmd+Enter sends nothing. KBD-05: a running turn allows draft editing without a second send. KBD-06: Escape closes the menu without losing text or stopping generation. KBD-07: repeated Enter and double-click send produce one acknowledged turn.

SLASH-01: toolbar click and typed slash open the same menu. SLASH-02: Enter/Tab select a command without execution; the next Enter executes. SLASH-03: invalid arguments preserve the draft. SLASH-04: URLs and paths do not trigger. SLASH-05: unknown commands require explicit Send as text. SLASH-06: clear has confirmation, engine switch has host acknowledgement and export waits for successful write.

MENTION-01: duplicate filenames and tables remain distinguishable. MENTION-02: an older async response cannot replace newer results. MENTION-03: a response arriving after Escape cannot reopen the menu. MENTION-04: inserting a reference preserves text before and after the active token. MENTION-05: paste and caret movement update detection. MENTION-06: removing context removes only that reference. MENTION-07: missing/forbidden files cannot silently enter or disappear from a sent prompt. MENTION-08: previews and search do not trigger model calls. MENTION-09: loading, error and empty rows cannot submit. MENTION-10: narrow panel, 200% zoom and keyboard-only interaction keep every control reachable.

### Source anchors and existing gaps

The existing command registry and argument parser are in `src/ui/aiChatPanelCommands.ts:1–83`. Current host `/engine` handling accepts only builtin/omp at `src/ui/aiChatPanel.ts:1744–1816`, even though the panel protocol includes all four engines in `src/ui/aiChatPanelMessages.ts:91–106`. The redesign must reconcile this rather than merely expose four labels in a menu.

Composer keyboard behavior is split between `webview/aiChatPanelComposer.ts:496–504` and capture-phase handling in `webview/aiChatPanelMain.ts:792–895`. The current menu Enter branches do not exclude Shift, so the proposed always-newline contract needs a specific regression test and controller change. Mention discovery currently uses keyup and sends query-only requests in `webview/aiChatPanelMain.ts:907–931`; add request correlation rather than assume responses arrive in order. Slash toolbar insertion currently changes textarea.value directly at `webview/aiChatPanelComposer.ts:441–457`.

Current export serializes rendered thread innerText and immediately announces success at `webview/aiChatPanelMain.ts:629–640`; replace that path with a structured transcript export and confirmed host write. Native resume is explicitly unavailable in the existing Claude Code adapter (`src/ai/claudeCode/claudeCodeChatEngine.ts:272–279`) and Codex adapter (`src/ai/codex/codexChatEngine.ts:357–364`). Viewing a locally saved transcript must not be labelled native resume.

