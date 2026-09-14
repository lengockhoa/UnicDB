# AI Chat Redesign — External Research Ledger (TASK-AICHAT-003)

Status: Research complete. Network reachable via `WebFetch`; `WebSearch` unavailable this session
(see Tool-availability note). No `BLOCKED(network)` marker — the ≥15 target was met with real,
fetched primary sources. This note is comparative research input for
`docs/AI_CHAT_REDESIGN.md`; it is not final spec prose.

## Evidence-label taxonomy

- **Verified-with-URL** — the executor fetched the primary source page and observed the quoted
  behavior/wording/identifier on that page.
- **Reported-unverified** — credible secondary reporting, but the primary page was not fetched.
- **Could-not-verify** — no reachable source; the exact query/URL tried is recorded.

## Tool-availability note (read before trusting the ledger)

- **`WebFetch`: available.** Every `Verified-with-URL` row below was fetched during this session.
- **`WebSearch`: not returning results.** Two attempted queries returned an empty result block
  and an instruction to cite sources, with zero result entries — the same signature the baseline
  `docs/AI_CHAT_REDESIGN.md` "Evidence status" section recorded as blocked. Queries tried:
  `"VS Code Chat participant API slash commands documentation code.visualstudio.com"` and
  `"WAI-ARIA APG combobox pattern editable aria-activedescendant requirements"`.
  Because `WebFetch` worked, research continued by fetching known primary doc URLs directly and
  by reading each vendor's `sitemap.xml` to discover correct paths instead of guessing URLs.
- **Consequence:** every row is grounded in a page the executor actually opened, or is labeled
  `Could-not-verify` with the URL attempted. No remembered feature was promoted to
  `Verified-with-URL`, and no URL below was invented.

## Subject substitution

The baseline `docs/AI_CHAT_REDESIGN.md` Scope/Evidence section promises comparison against
"three requested Marketplace extensions" but never names them; it states they "have not yet been
inspected." A grep of the repository for the extension names returns no such list, so the three
originals remain genuinely unnamed here.

This task openly resolves that dangling promise: the "three requested Marketplace extensions"
are **replaced** by a named, inspectable substitute set — **GitHub Copilot Chat**, **Cline**, and
**Continue** — plus the **official VS Code chat/webview surfaces** and the **WAI-ARIA APG** as the
accessibility authority. These substitutes are chosen because each publishes public documentation
the executor can cite. They are **comparisons for design reasoning only**. They are **not** claims
about, nor reconstructions of, the original unnamed three: nothing in this note should be read as
attributing a behavior, repository, license, or maintenance status to whatever the baseline author
originally had in mind. If the original three are later named, this ledger must be re-checked
against them rather than silently reused.

---

## VS Code official surfaces

### Q01

- **Subject / question:** VS Code Chat UI surface and participant conventions.
- **Query/URL:** `https://code.visualstudio.com/api/extension-guides/chat` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** Chat participation is declared in `package.json` under
  `contributes.chatParticipants` with `id`, `name`, `fullName`, `description`, `isSticky`, and
  created at runtime with `vscode.chat.createChatParticipant('chat-sample.my-participant', handler)`.
  `vscode.ChatRequest` exposes `prompt`, `command`, `variables`, `model`, and `location`, where
  `location` is one of Chat view, Quick Chat, or inline chat — i.e. one participant serves three
  distinct UI surfaces. Participant disambiguation is declared via a `disambiguation` array with
  `category`, `description`, `examples`.
- **Relevance (final-spec):** confirms UnicDB's composer/participant model maps onto a single
  handler with surface-varying `location`; supports the spec's engine-boundary section and the
  `/engine` capability-negotiation requirement.

### Q02

- **Subject / question:** VS Code Chat participant slash commands.
- **Query/URL:** `https://code.visualstudio.com/api/extension-guides/chat` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** Slash commands are declared as a `commands` array on the participant,
  each entry carrying `name` and `description`; the handler distinguishes them by inspecting
  `request.command == 'teach'`. The docs name them users-invoked "with `/` syntax." Registration
  is per-participant, so command sets are explicitly bounded by which participant is active.
- **Relevance (final-spec):** grounds the spec's "local command catalog + capability-gated
  provider-native group"; confirms commands are first-class registered metadata, not free text,
  matching the spec's requirement that unknown commands never silently reach a backend.

### Q03

- **Subject / question:** VS Code Chat context variables and attachments.
- **Query/URL:** `https://code.visualstudio.com/api/extension-guides/chat` and
  `https://code.visualstudio.com/docs/chat/copilot-chat-context` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** The API delivers attachments through `request.variables`, passed to
  the handler (e.g. `doTeaching(request.prompt, request.variables)`). The user-facing docs state
  that `#`-mentions open a picker covering "files, folders, code symbols, tools, terminal output,
  source control changes, and more," with `#codebase` and `#fetch` named explicitly; context can
  also be added by dragging files/folders onto the Chat view or via the **Add Context** button
  (options **Files & Folders** and **Symbols**). Automatic context uses "workspace indexing" to
  include relevant files.
- **Relevance (final-spec):** validates the spec's mention menu (Files / Editor selection /
  Database objects) and its chip model; the API's separate attachment channel supports the spec's
  "structured identity separate from displayed label."
- **Note:** `#file` / `#terminalSelection` appear in `docs/copilot/chat/copilot-chat` but the
  context page itself defers the full list to a cheat sheet — recorded rather than asserted.

### Q04

- **Subject / question:** VS Code Chat streaming and markdown/progress API.
- **Query/URL:** `https://code.visualstudio.com/api/extension-guides/chat` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** Streaming is performed through a `vscode.ChatResponseStream` object
  passed as the third handler argument. Named stream methods: `stream.markdown(...)` (CommonMark
  text/code), `stream.progress('...')` (progress messages), `stream.button({ command, title,
  arguments })`, `stream.filetree(tree, baseLocation)`, and `stream.reference(fileUri)` /
  `stream.anchor(symbolLocation, 'MySymbol')`. Command links require a `vscode.MarkdownString` with
  `isTrusted = { enabledCommands: [...] }`, with arguments JSON-then-URI-encoded.
- **Relevance (final-spec):** confirms streaming is incremental and typed (progress vs markdown vs
  button), supporting the spec's separation of streaming tokens from discrete progress and its
  "announce selection, not every streaming token" accessibility rule.

### Q05

- **Subject / question:** VS Code Chat session, history, and resume concepts.
- **Query/URL:** `https://code.visualstudio.com/api/extension-guides/chat` and
  `https://code.visualstudio.com/docs/copilot/chat/chat-sessions` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** The API exposes `context: vscode.ChatContext` carrying `history`, whose
  items are `ChatRequestTurn` or `ChatResponseTurn` (filterable with
  `h instanceof vscode.ChatRequestTurn`); crucially, "A participant can only access messages where
  it was mentioned," and history "will not be automatically included in the prompt." The UI docs
  define a "session" as "the unit of work with an agent," renamed via tab context-menu **Rename**,
  grouped by time (**Today**, **Last Week**), and archived vs active via an **Archived** filter.
- **Relevance (final-spec):** directly informs the spec's `/resume`, `/new`, and session-picker
  contract, and the rule that viewing a saved transcript must not be labelled native resume —
  history visibility here is participant-scoped and opt-in, not automatic replay.

### Q06

- **Subject / question:** VS Code webview accessibility and workbench theme-color guidance.
- **Query/URL:** `https://code.visualstudio.com/api/extension-guides/webview` and
  `https://code.visualstudio.com/api/references/theme-color` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** Webviews receive body classes `vscode-using-screen-reader` and
  `vscode-reduce-motion`, plus per-theme-category classes `vscode-light`, `vscode-dark`,
  `vscode-high-contrast`; theme colors are exposed as CSS variables with `.`→`-`
  (e.g. `editor.foreground` → `var(--vscode-editor-foreground)`). The theme-color reference lists
  the exact IDs the spec proposes: `editorWidget.background`, `editorWidget.border`, `foreground`,
  `descriptionForeground`, `list.activeSelectionBackground`, `list.activeSelectionForeground`,
  `focusBorder` — and, notably, chat-specific keys `chat.slashCommandBackground`,
  `chat.slashCommandForeground`, `chat.requestBubbleBackground`, `chat.checkpointSeparator`.
- **Relevance (final-spec):** the spec's theme-token list is confirmed real and exact; the
  `vscode-reduce-motion` body class confirms the reduced-motion requirement, and the chat-specific
  tokens are a concrete upgrade path over the spec's generic widget/list tokens.
- **Could-not-verify (sub-part):** the webview page contains no explicit focus-management or
  keyboard-navigation guidance (recorded as a docs gap, not extrapolated).

### Q07

- **Subject / question:** Copilot composer multiline/send and keyboard behavior.
- **Query/URL:** `https://code.visualstudio.com/docs/copilot/chat/copilot-chat` and
  `https://code.visualstudio.com/docs/reference/default-keybindings` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** The composer sends on "press Enter or select the **Send** button."
  The command reference gives exact Chat keybindings: **New chat session** `workbench.action.chat.newChat`
  (⌘N / Ctrl+N), **Open Chat view** `workbench.action.chat.open` (⌃⌘I), **Open chat in agent mode**
  `workbench.action.chat.openagent`, **Open agent picker** `workbench.action.chat.openModePicker`
  (⌘.), **Open language model picker** `workbench.action.chat.openModelPicker` (⌥⌘.). Prefixing a
  message with `!` (e.g. `!npm test`) runs a terminal command directly "without sending the message
  to the agent or asking for approval" — and this is "only available in Agent Host sessions."
  In-session search is ⌘F/Ctrl+F with Enter/Shift+Enter to navigate.
- **Relevance (final-spec):** the agent/model/mode pickers are separate commands, not one merged
  menu — supporting the spec's distinct `/engine` and `/model` contracts; the `!` terminal escape
  is a capability-gated behavior the spec should treat as provider-native, not universal.
- **Could-not-verify (sub-part):** the default-keybindings page does **not** list a "send message"
  or "new line in chat input" binding; the reference explicitly omits them. Not asserted.

### Q08

- **Subject / question:** Copilot slash commands and command discovery.
- **Query/URL:** `https://code.visualstudio.com/docs/copilot/chat/copilot-chat` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** "Type `/` in the chat input to see all available commands," described
  as "shortcuts for frequently used prompts or to invoke agent skills." The page also shows `/clear`
  in the context of clearing a conversation, `/agents` to switch agents, and `/create-agent` in
  Agent mode; `/fork` forks full history. This confirms discovery is typing `/` to open a menu that
  mixes built-in prompts and user/extension-contributed commands in one surface.
- **Relevance (final-spec):** matches the spec's single slash menu ("/help", "/clear", "/resume",
  "/new") and its requirement that the toolbar slash button opens the *same* menu; confirms the
  list mixes built-in and contributed entries, so the spec's "separately labelled, capability-gated
  provider-native group" is the correct differentiator.

### Q09

- **Subject / question:** Copilot @-mentions, context attachment, and duplicate disambiguation.
- **Query/URL:** `https://code.visualstudio.com/docs/chat/copilot-chat-context` and
  `https://code.visualstudio.com/docs/copilot/chat/copilot-chat` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** The context page states that `@`-mentions invoke chat participants
  ("such as `@vscode` or `@terminal`") while `#`-mentions attach context items — the two sigils are
  deliberately split by role. `#codebase` and `#fetch` are named; `#file`, `#terminalSelection`, and
  `#fetch` are named on the main copilot-chat page. Drag-and-drop from Explorer/Search/editor tabs
  and an **Add Context** button are alternate attachment paths.
- **Relevance (final-spec):** the `@`-vs-`#` split is a real precedent for the spec's choice to
  keep `@` for context search; it also warns the spec not to overload one sigil. The spec's
  duplicate-disambiguation requirement ("two `index.ts` must show distinct paths") has no direct
  upstream wording here, so it stays a UnicDB-original requirement (see Q22).
- **Could-not-verify (sub-part):** no fetched page documents how VS Code disambiguates two
  identically-named files in the picker; not asserted.

### Q10

- **Subject / question:** Copilot streaming/stop/edit acceptance presentation.
- **Query/URL:** `https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode`,
  `https://code.visualstudio.com/updates/v1_104` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** While a request runs, the **Send** button becomes a dropdown with three
  labeled options: **Add to Queue**, **Steer with Message**, and **Stop and Send**. Steer "signals
  the current request to yield after finishing the current tool execution"; **Stop and Send**
  "cancels the current request entirely and sends your new message right away." Default action is
  set by `chat.requestQueuing.defaultAction` (`steer` default, or `queue`), and pending messages are
  reorderable via drag handles. The 1.104 notes add **Skip tool calls** ("skip the tool call and let
  the agent continue") and note that stopping "doesn't undo file edits, terminal commands, or other
  actions that already completed."
- **Relevance (final-spec):** this is the strongest precedent for the spec's "queueing and steering
  are separate future capabilities, never inferred from typing." Upstream makes them explicit
  button/dropdown actions; the spec's Stop-as-explicit-button rule matches **Stop and Send** while
  deliberately deferring queue/steer.

### Q11

- **Subject / question:** Copilot chat history/session/export/privacy affordances.
- **Query/URL:** `https://code.visualstudio.com/docs/copilot/chat/chat-sessions` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** **Chat: Export Chat...** from the Command Palette saves all prompts and
  responses as a JSON file. Per-message right-click offers **Copy**, **Copy All**, and **Copy Final
  Response** (output after the last tool call). Checkpoints are reached via **Fork Conversation**
  (forks only requests up to that checkpoint) or `/fork` (full history); forked titles are prefixed
  `Forked:`. External sessions from Copilot CLI, the Copilot app, Claude Code, and Codex surface via
  an **External** filter (`None`, `Recent`, `Last 24 Hours`, `Last 7 Days`, `All`). Notification
  behavior is `chat.notifyWindowOnResponseReceived` / `chat.notifyWindowOnConfirmation`
  (`off` / `windowNotFocused` / `always`).
- **Relevance (final-spec):** the structured JSON export is exactly the spec's "structured transcript
  export" replacement for serializing rendered innerText; the **External** filter and Claude
  Code/Codex discovery directly support the spec's multi-engine session model.

---

## Cline

### Q12

- **Subject / question:** Cline Plan/Act and approve/reject permission UX.
- **Query/URL:** `https://docs.cline.bot/features/plan-and-act` and
  `https://docs.cline.bot/features/auto-approve` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** **Plan** mode "can read your codebase, run searches, and discuss
  strategy, but cannot modify any files"; **Act** mode "can modify files, run commands, and execute
  your strategy," and "The conversation history carries over when you switch modes." Auto-approve is
  "evaluated per tool call" across labeled toggles: **Read project files**, **Read all files**,
  **Edit project files**, **Edit all files**, **Execute safe commands**, **Execute all commands**,
  **Use the browser**, **Use MCP servers**, **Enable notifications** — where "all files" and "all
  commands" require their base toggle or "do nothing." Terminal approval is not a fixed allowlist:
  "The model marks each command with a `requires_approval` flag," with `git status`/`ls -la` as safe
  and `rm -rf <path>`/`npm install <pkg>` requiring approval.
- **Relevance (final-spec):** Plan/Act with carried-over history is the reference model for the
  spec's engine/mode boundaries; the per-tool-call approval matrix is the concrete shape the spec's
  permission section should mirror (base toggle + escalation, rather than one global switch).

### Q13

- **Subject / question:** Cline activity/timeline/checkpoint/task presentation.
- **Query/URL:** `https://docs.cline.bot/features/checkpoints` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** After every file edit or command Cline snapshots the project into a
  "shadow Git repository separate from your project's actual Git history." In the task it renders
  "a bookmark icon labeled 'Checkpoint' with a dotted line connecting to **Compare** and **Restore**
  buttons" — the dotted line is the timeline visual. **Compare** opens the editor diff view;
  **Restore** opens three options: **Restore Files** (files only, conversation kept), **Restore Task
  Only** (drops later messages, files untouched), and **Restore Files & Task**. Checkpoints are on by
  default and toggle via "Enable Checkpoints" under "Feature Settings."
- **Relevance (final-spec):** this is the clearest upstream precedent for the spec's activity
  timeline. The dotted-line connector between checkpoint nodes and the separate Compare/Restore
  affordances are concrete, copy-able interaction patterns for the spec's timeline section.

### Q14

- **Subject / question:** Cline context attachment and terminal/file/database-relevant boundaries.
- **Query/URL:** `https://docs.cline.bot/core-workflows/working-with-files` and
  `https://docs.continue.dev/reference/deprecated-context-providers` (both fetched; the Continue
  page documents the `@Database` provider).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** Typing `@` selects a file or folder, or the **+** button bottom-left.
  Syntax is `@/path/to/file` (file contents plus "imports, related functions, and surrounding
  context") and `@/path/to/folder/` where "the trailing slash matters"; multi-root uses
  `@workspace-name:/path/to/file`. Files can be dragged into the chat input (**Shift**-drag in VS
  Code), including "images, PDFs, CSVs, and Excel files." Terminal context is captured by
  right-clicking the terminal and choosing **"Add to Cline"**. Context-menu commands **Add to
  Cline**, **Fix with Cline**, **Explain with Cline**, **Improve with Cline** "automatically include
  the selected text and its file location as context." For databases, Continue's (deprecated)
  `@Database` provider "Reference[s] table schemas from Sqlite, Postgres, MSSQL, and MySQL
  databases" — schemas, not rows.
- **Relevance (final-spec):** Cline's `@/path` prefix and folder-trailing-slash convention are a
  direct comparator for the spec's mention token grammar; the found boundary (schema, not rows) in
  Continue's DB provider is evidence *for* the spec's rule that "a database mention initially
  includes metadata, not table rows."

---

## Continue

### Q15

- **Subject / question:** Continue slash commands and @-mentions / context providers.
- **Query/URL:** `https://docs.continue.dev/customize/deep-dives/prompts`,
  `https://docs.continue.dev/ide-extensions/chat/quick-start`, and
  `https://docs.continue.dev/reference/deprecated-context-providers` (all fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** A markdown prompt with frontmatter `name`, `description`,
  `invokable: true` becomes "available when you type / in Chat, Plan, and Agent mode" — you
  "open Chat / Agent / Edit, type /, select the prompt, and type out any additional instructions."
  Chat quick-start names `@Files` ("Reference specific files") and `@Terminal` ("Include terminal
  output") as mention examples. The deprecated provider list catalogs the historical `@` namespace:
  `@Greptile`, `@Commits`, `@Discord`, `@Jira`, `@Gitlab Merge Request`, `@Google`, `@Database`,
  `@Issue`, `@Url`, `@Search`, `@Web` — now superseded by MCP.
- **Relevance (final-spec):** confirms the spec's "select-then-type-arguments" slash flow (selection
  never executes; a second Enter runs) is a real, shipped pattern. It also warns the spec that a
  broad `@` provider namespace is costly to maintain — Continue deprecated most of it in favor of
  MCP, supporting the spec's decision to keep optional providers hidden until implemented.

### Q16

- **Subject / question:** Continue model selection/roles and provider capabilities.
- **Query/URL:** `https://docs.continue.dev/customize/models` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** "Models can have various roles like `chat`, `edit`, `apply`,
  `autocomplete`, `embed`, and `rerank`," each with a defined purpose (e.g. `chat` "Power
  conversational interactions about code"; `apply` "Execute targeted code modifications with high
  accuracy"). Configuration is file-driven — after editing, "Click `Reload config` in the config
  selector in the Continue IDE extension." The docs distinguish the config role names (`embed`,
  `rerank`) from the UI labels ("Embedding", "Reranker").
- **Relevance (final-spec):** role-based routing is the direct comparator for the spec's
  host-authoritative `/model` picker. Upstream separates *role* (what the slot is for) from *model*
  (what fills it); the spec's `/model` "role picker" wording matches this two-level model.

### Q17

- **Subject / question:** Continue streaming/cancel/error/retry UI.
- **Query/URL:** `https://docs.continue.dev/ide-extensions/chat/quick-start` and
  `https://docs.continue.dev/cli/quickstart` (both fetched).
- **Evidence label:** Verified-with-URL (code-response actions) / Could-not-verify (in-IDE streaming
  cancel control).
- **Concrete observation:** The chat quick-start documents per-code-block action buttons only:
  "Apply to current file" (replaces selected code), "Insert at cursor", and "Copy". The CLI
  quickstart documents approval controls `--auto` ("Allow all tools without prompting") and
  `--readonly` ("Plan mode — read-only tools only"), with TUI sessions where you "approve tool
  calls." Neither fetched page describes a streaming **cancel/retry** control inside the IDE chat.
- **Could-not-verify (sub-part):** a Continue-specific in-IDE "Stop generation" / retry-error
  affordance was not found on the fetched pages. Tried:
  `https://docs.continue.dev/ide-extensions/features/chat` (HTTP 404),
  `https://docs.continue.dev/chat/overview` (HTTP 404), `https://docs.continue.dev/cli/tui` (HTTP
  404). The in-IDE streaming UI may appear only in a running build, so it is recorded as unverified
  rather than asserted from memory.
- **Relevance (final-spec):** the Apply/Insert/Copy triad is a concrete comparator for the spec's
  response-acceptance affordances; the unresolved cancel question is exactly the kind of gap the
  spec must define for UnicDB rather than inherit.

### Q18

- **Subject / question:** Continue sessions/history/data handling.
- **Query/URL:** `https://docs.continue.dev/reference` and
  `https://docs.continue.dev/cli/quickstart` (both fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** The config reference has **no** session-history or chat-storage key; the
  closest is the `data` section, which streams "development data" to a `destination` (HTTP endpoint
  or a file URL where "events will be dumpted to `.jsonl` files") with `schema` (`"0.1.0"` /
  `"0.2.0"`), `events` (e.g. `autocomplete`, `chatInteraction`), and `level` (`"all"` / `"noCode"`,
  the latter excluding file contents, prompts, and completions). On the CLI side, `cn --resume`
  "Resume[s] the most recent session," and `cn login` + `CONTINUE_API_KEY` handle auth.
- **Relevance (final-spec):** `level: "noCode"` is a concrete precedent for the spec's "do not store
  raw secret content / privacy boundary" requirement — a single flag that strips prompts and code
  from captured data. Local, resumable sessions live in the IDE/CLI, not the config schema.

---

## WAI-ARIA APG

### Q19

- **Subject / question:** WAI-ARIA APG editable combobox required roles/properties.
- **Query/URL:** `https://www.w3.org/WAI/ARIA/apg/patterns/combobox/` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** The input gets role **combobox** and the popup gets role **listbox**
  (or grid/tree/dialog). Required/expected properties: **aria-controls** referencing the popup
  (needed when visible; legacy `aria-owns` discouraged), **aria-expanded** (`false` hidden,
  `true` visible, default `false`), **aria-activedescendant** — "DOM focus stays on the combobox
  while this attribute points to the focused element inside the popup," **aria-haspopup** when the
  popup is not a listbox, **aria-selected** on the current option, and **aria-autocomplete**
  (`none` / `list` / `both`). Labeling prefers an HTML `label`, else `aria-labelledby` / `aria-label`.
- **Relevance (final-spec):** the spec's exact claim — "textarea exposes combobox semantics with
  aria-expanded, aria-controls and aria-activedescendant" while "DOM focus stays in the textarea" —
  is confirmed verbatim in intent by the APG; `aria-autocomplete` is an addition the spec should
  adopt.

### Q20

- **Subject / question:** WAI-ARIA listbox keyboard behavior/selection and live announcements.
- **Query/URL:** `https://www.w3.org/WAI/ARIA/apg/patterns/listbox/` (fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** Container role **listbox**, each item role **option** (directly or in a
  `group` with an accessible name). Single vs multi is `aria-multiselectable`; use `aria-selected`
  **or** `aria-checked` but never both. Keyboard: on focus, single-select puts focus on the selected
  option (or first); Up/Down move focus; Home/End are "strongly recommended" for lists over five
  options; type-ahead is "recommended for all lists, especially those with more than seven options."
  For async/dynamic option sets, set **`aria-setsize`** and **`aria-posinset`** "so position is
  announced correctly," and the role supports **aria-activedescendant** for virtual focus.
- **Relevance (final-spec):** type-ahead and `aria-setsize`/`aria-posinset` are concrete additions
  the spec's mention-listbox section should include; the "options can't expose interactive elements"
  limitation (role is a flat string) constrains the spec's chip/row design.

### Q21

- **Subject / question:** APG guidance relevant to async results / disabled loading rows / focus
  retention.
- **Query/URL:** `https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/`,
  `https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/`, and
  `https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live`
  (all fetched).
- **Evidence label:** Verified-with-URL.
- **Concrete observation:** On focus: "It is essential that there is always a component within the
  user interface that is active"; when closing a dialog or deleting a list item, move focus to the
  trigger or the following item, else "the browser shifts focus to body, effectively causing a loss
  of focus." On async content: if a focus move "causes a network request and possibly a page
  refresh," selection-follows-focus "can be devastating to the experience for keyboard and screen
  reader users" — prefer confirm-with-Enter. On disabled rows: keep them focusable with
  `aria-disabled="true"` (rather than HTML `disabled`) "so that it will remain focusable," because
  "screen reader users discover elements largely by moving focus." Names: options are named by
  visible text, and using `aria-label`/`aria-labelledby` "will hide any descendant content from
  assistive technologies." Live regions: `aria-live="polite"` presents "at the next graceful
  opportunity" without interrupting; `assertive` "should be presented immediately" and may clear the
  speech queue — "don't use the `assertive` value unless the interruption is imperative";
  `role="alert"` is implicitly assertive, `role="status"` is the polite counterpart; `aria-atomic`
  reads the whole region, `aria-busy` "prevent[s] announcements while updates are still being made."
- **Relevance (final-spec):** this directly validates three spec rules: (1) keep DOM focus in the
  textarea and use `aria-activedescendant` (focus retention); (2) loading/error/empty rows must not
  be selectable — APG's guidance to prefer `aria-disabled` for discoverability refines the spec;
  (3) announce via a **polite** live region, not `assertive`, and not every streaming token — the
  spec's "polite live region, not every keystroke or streaming token" wording is APG-correct.
  `aria-setsize`/`aria-posinset` from Q20 and `aria-busy` here are concrete additions.

---

## Cross-product synthesis

### Q22

- **Subject / question:** What is consistent across products, what must stay engine-gated, and what
  is uniquely proposed for UnicDB.
- **Query/URL:** Synthesis of all fetched sources above:
  `https://code.visualstudio.com/api/extension-guides/chat`,
  `https://code.visualstudio.com/docs/copilot/chat/copilot-chat`,
  `https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode`,
  `https://code.visualstudio.com/docs/copilot/chat/chat-sessions`,
  `https://code.visualstudio.com/api/extension-guides/webview`,
  `https://code.visualstudio.com/api/references/theme-color`,
  `https://docs.cline.bot/features/plan-and-act`,
  `https://docs.cline.bot/features/auto-approve`,
  `https://docs.cline.bot/features/checkpoints`,
  `https://docs.cline.bot/core-workflows/working-with-files`,
  `https://docs.continue.dev/customize/deep-dives/prompts`,
  `https://docs.continue.dev/customize/models`,
  `https://docs.continue.dev/reference`,
  `https://www.w3.org/WAI/ARIA/apg/patterns/combobox/`,
  `https://www.w3.org/WAI/ARIA/apg/patterns/listbox/`,
  `https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/`.
- **Evidence label:** Verified-with-URL (every constituent claim traces to a fetched page above).
- **Concrete observation — consistent (all / most products):**
  - **Composer:** Enter sends; a send control exists; running turns expose stop/queue/steer.
    (Copilot **Add to Queue** / **Steer with Message** / **Stop and Send**; Cline and Continue TUI
    "approve tool calls" mid-run.)
  - **Commands:** `/` opens a discovery menu mixing built-in and contributed entries (VS Code,
    Continue `invokable`, Cline skills-as-slash-commands).
  - **Context:** a single sigil (Cline/Continue `@`, VS Code `@`participants + `#`items) attaches
    scoped context; files/folders/selection are the base set everywhere.
  - **Streaming:** incremental, typed output (VS Code `markdown`/`progress`/`button`).
  - **Sessions/history:** first-class session units with rename/filter and some export path
    (VS Code **Chat: Export Chat...** JSON; Continue `--resume`).
  - **Approvals:** per-tool-call granularity with escalating auto-approve (Cline's matrix; VS Code
    `chat.tools.*` + permission levels).
  - **Activity/timeline:** explicit, optionally-collapsed step/checkpoint presentation (VS Code
    "Completed N steps" + Agent Logs; Cline's Checkpoint dotted timeline + **Compare**/**Restore**).
- **Concrete observation — must remain engine-gated (capability, not universal):**
  - Provider-native terminal escape (`!`) is documented as "only available in Agent Host sessions"
    (VS Code) — never promise it across engines.
  - Auto-approve modes and `autoApprove`/`allowDangerouslySkipPermissions` are harness-specific
    (VS Code enterprise policy keys vs Cline's per-tool matrix).
  - Resume semantics differ: VS Code has **External** session discovery for Claude Code/Codex, but
    the baseline records native resume as unavailable in UnicDB's Claude Code and Codex adapters —
    so the spec must gate `/resume` per backend, not assume parity.
  - Model **role** vs **model** (Continue's `chat`/`edit`/`apply`/…) is a host authority; the spec
    must not accept arbitrary model IDs.
- **Concrete observation — proposed only for UnicDB (no upstream equivalent found):**
  - Duplicate disambiguation in the mention list ("two `index.ts` show distinct workspace-relative
    paths"; two same-named tables show distinct connection/schema). No fetched page documents an
    equivalent; keep it as a UnicDB requirement.
  - The combined `requestId` + draft-revision staleness guard for async mention search (upstream
    docs describe search but not this correlation contract).
  - Database mentions carrying **metadata only, never rows** — Continue's deprecated `@Database`
    stops at "table schemas," which is evidence the boundary is reasonable, but the governed
    "rows only via a separate tool action" rule is UnicDB's.
  - A single keyboard controller with explicit IME `isComposing` precedence — no upstream page
    documents composition handling; this stays a UnicDB-original, APG-informed requirement.
- **Relevance (final-spec):** this row is the bridge the downstream spec tasks (TASK-AICHAT-004/005/
  006) consume: it separates (a) behaviors UnicDB can safely mirror, (b) behaviors that must be
  capability-negotiated per engine, and (c) behaviors that are UnicDB-originals and therefore carry
  no upstream safety net.
