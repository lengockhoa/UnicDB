# UnicDB Professional AI Chat — Implementation Specification

**Status:** Design and implementation contract. This is a new target specification, not a claim that every item exists today.

**Owner:** UnicDB maintainers and AI implementors.

**Scope:** Replace the fragile current AI Chat webview experience with a professional, engine-aware chat surface. Preserve the existing OMP, Claude Code, Codex, builtin, database-tool, policy, trace and safety boundaries. Do not create a second chat stack.

**Visual reference:** the user-provided screenshot: a dark, rounded, two-row Claude-like composer. Its first row is an input surface with a contextual focus hint and microphone button. Its second row has compact action controls, a model chip, context chips, a visible bypass-permissions control and a square upward-arrow submit control. Reproduce its interaction quality and information hierarchy, not its branding or copyrighted assets.

## 1. Product decision

Build one **UnicDB AI Chat** experience with two layers:

1. **Universal shell.** Composer, transcript, slash menu, mentions, selected context, activity timeline, permission cards, status indicators, keyboard behavior, export, accessibility and error recovery look and behave identically regardless of backend.
2. **Engine capability layer.** OMP, Claude Code, Codex and builtin advertise actual capabilities. The UI must reveal only operations confirmed by the selected engine and host. It must never pretend that an engine supports native session resume, live thought streaming, images, tools, a provider command or a permission mode when it does not.

The desired result is a professional AI coding/chat extension: calm while idle, explicit while working, trustworthy when waiting for permission, and never visually jumps, blocks the user from drafting, silently drops context, or lies about completion.

## 2. Existing code and constraints to preserve

The target is an evolution of the current implementation. Do not discard the host/webview security boundary or rewrite the database/agent integrations merely to change presentation.

| Existing module | Confirmed responsibility | Required treatment |
|---|---|---|
| `src/ui/aiChatPanel.ts` | Owns webview panel, history, turns, policies, engines, permissions, grounding and host message dispatch. | Keep as host orchestration authority; split only pure state reducers/helpers if necessary. |
| `src/ui/aiChatPanelMessages.ts` | Typed host↔webview contract. Existing frames include `delta`, `thought`, `tool_result`, `permission_request`, `engine`, `session_state`, `usage`, models and grounding. | Version and extend deliberately; no untyped `unknown` payloads for new behavior. |
| `webview/aiChatPanelMain.ts` | Current DOM composition, message handling, slash and mention behavior. | Replace fragmented module-level mutable UI state with one controller/store. Preserve security restrictions. |
| `webview/aiChatPanelThread.ts` | Escaped bubbles, Markdown path, thinking/tool cards. | Reuse safe render primitives. Continue escaping all untrusted values. |
| `src/ai/omp/*`, `src/ai/claudeCode/*`, `src/ai/codex/*` | Engine adapters declare a shared delta/thought/tool/error/done callback surface, but not every adapter emits every kind today (verified: omp emits delta/thought/tool at `src/ai/omp/ompChatEngine.ts:279,288,299`; claude-code declares `onThought` at `src/ai/claudeCode/claudeCodeProcess.ts:63` with no emit site; codex declares `onToolStart`/`onToolEnd` at `src/ai/codex/codexProcess.ts:87` with no emit site). | Adapt into a common capability and event envelope; advertise only emitted kinds; do not parse provider-specific UI text in webview. |
| `webview/styles.css` | Theme-aware current styles and VS Code CSS variable fallbacks. | Replace chat selectors incrementally under a new `.UnicDB-ai-chat-v2` root; do not change other webviews. |

### Non-negotiable safety and privacy rules

The webview never receives API keys, database credentials, raw permission tokens, unredacted process stderr or raw trace dumps. Host-generated opaque permission IDs are echoed verbatim only. User text, mention labels, paths, tool summaries and model output must be rendered through `textContent` or the existing escape-first Markdown renderer. A model tool action remains subject to the existing policy and SQL/DML safety gates; a visual “Bypass permissions” switch may change a permitted session policy only through host validation and never bypasses destructive SQL confirmation or workspace trust.

No localStorage, sessionStorage or browser persistence API is permitted. Persisted chat records belong to the host-side VS Code storage layer, never the webview.

### 2.1 Cutover status (TASK-CHATV2-017, 2026-09-16)

V2 is the **authoritative boot**: `webview/aiChatPanelMain.ts` acquires the API once, mounts the `.UnicDB-ai-chat-v2` shell + `createChatController` once, posts `ready_v2`, routes typed V2 frames and disposes cleanly. The controller (the single keyboard/transport owner) also mounts the keyed transcript, activity timeline, scroll viewport and live announcer. The host emits the V2-native streaming family (`text_delta` / `reasoning_delta` / `tool_started` / `tool_finished` / `turn_finished`) from its central session choke points.

**Deleted (cutover complete):** `webview/aiChatPanelHeader.ts` and `webview/aiChatPanelComposer.ts` no longer exist; every V2 surface (composer, transcript, header/engine pill, model menu, schema chip, context chips, autocomplete, attach menu, sessions, change plan, errors, permissions) is mounted by the controller, and the dead `.UnicDB-chat` CSS was retired from `webview/styles.css`. Non-V2 host frames are still rendered by the legacy bridge in `aiChatPanelMain.ts` through the controller's single message listener.

## 3. Technical architecture

### 3.1 Recommended architecture

Use a thin, typed, event-sourced UI model.

```text
AI provider / CLI / ACP
        │ normalized callbacks
        ▼
Engine adapter ──► EngineCapabilitySnapshot
        │                    │
        ▼                    ▼
AiChatPanel host turn coordinator ──► Versioned host→webview frames
        │                                      │
        │ host persistence / trace / policy    ▼
        └──────────────────────────────► Webview ChatController store
                                                   │
                                                   ├─ TranscriptRenderer
                                                   ├─ ActivityTimeline
                                                   ├─ ComposerController
                                                   ├─ AutocompletePopover
                                                   ├─ PermissionSheet
                                                   └─ SessionSidebar / inspector
```

The host remains the source of truth for engine selection, turns, permissions, context resolution, session record and export write result. The webview is source of truth only for ephemeral visual state: draft text, caret, popover state, focus target, current scroll position, collapsed sections and unsent selected context IDs.

Create these focused modules rather than another large `aiChatPanelMain.ts`:

| New/changed module | Role |
|---|---|
| `src/ai/capabilities.ts` | Closed `EngineCapabilitySnapshot`, normalizes feature availability from engine adapter plus host policy. |
| `src/ui/aiChatSessionStore.ts` | Host-side persisted session metadata and transcript model; no secret values; retention and export operations. |
| `src/ui/aiChatPanelMessages.ts` | V2 discriminated frames and webview intent frames. Keep compatibility adapter only during migration. |
| `webview/aiChat/store.ts` | Pure reducer for a serializable `ChatViewState`; unit-test without DOM. |
| `webview/aiChat/controller.ts` | Single owner of event wiring, focus, keyboard precedence, drafts, popover requests and host post calls. |
| `webview/aiChat/transcript.ts` | DOM renderer with stable message IDs, safe Markdown and update-in-place streaming. |
| `webview/aiChat/composer.ts` | Composer DOM, auto-grow, chips, controls and accessibility attributes. It must not independently post sends. |
| `webview/aiChat/autocomplete.ts` | One shared command/mention popover with keyboard behavior, positioning and stale response protection. |
| `webview/aiChat/activity.ts` | Collapsible operation timeline: thinking, tool calls, permissions, connection/retry and completion. |
| `webview/aiChat/overlays.ts` | Confirmation dialogs, permission sheet, model/engine menu and toast region. |
| `webview/aiChat/styles.css` | New scoped styles and design tokens. |

### 3.2 State model

Use explicit state rather than relying on DOM classes as state.

```ts
type TurnPhase =
  | "idle"
  | "validating"
  | "connecting"
  | "waiting_for_first_event"
  | "streaming"
  | "awaiting_permission"
  | "stopping"
  | "completed"
  | "failed";

type ComposerMode = "draft" | "slash" | "mention" | "model-menu" | "engine-menu";

type MentionKind = "file" | "selection" | "table" | "view" | "routine" | "schema";

interface ComposerDraft {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  revision: number;
  attachments: DraftAttachment[];
  context: ContextRef[];
}

interface ChatViewState {
  sessionId: string;
  capability: EngineCapabilitySnapshot;
  turn: { id: string | null; phase: TurnPhase; startedAt?: number };
  messages: RenderableTranscriptItem[];
  draft: ComposerDraft;
  autocomplete: AutocompleteState | null;
  layout: { isNearBottom: boolean; unreadActivityCount: number };
  banners: ChatBanner[];
}
```

A reducer receives host frames sequentially. Each frame has `sessionId`, a monotonic `sequence` and, when applicable, `turnId`. The reducer ignores a frame for another session and ignores stale sequence numbers. Mention search frames additionally include the `draftRevision` and `requestId` that initiated the query. A response can never reopen a dismissed menu or overwrite a newer query.

### 3.3 Capability contract

Do not hard-code `if engine === "omp"` throughout the webview. The host sends one `capabilities` frame after it resolves the engine and again when policy, connection or active role changes.

```ts
interface EngineCapabilitySnapshot {
  engine: "omp" | "claude-code" | "codex" | "builtin";
  displayName: string;
  status: "ready" | "starting" | "unavailable" | "fallback";
  supports: {
    streamText: boolean;
    streamThought: boolean;
    toolTimeline: boolean;
    imageInput: boolean;
    nativeSessionResume: boolean;
    savedTranscriptResume: boolean;
    engineCommands: boolean;
    permissions: boolean;
    bypassPermissions: boolean;
    modelRoles: boolean;
    workspaceMentions: boolean;
    dbMentions: boolean;
    exportTranscript: boolean;
  };
  commands: ChatCommandDescriptor[];
  modelRoles: ChatModelRole[];
  reasonUnavailable?: string;
}
```

The screenshot-like model chip shows the active configured role and quality label, such as `unic-sonnet High`, not a guessed provider model. The host must provide the display label and icon semantic. If no configured role exists, show `Choose model`; pressing it opens settings/picker, not an empty menu.

### 3.4 Provider event normalization

Every engine adapter maps provider events into these event kinds: `turn_started`, `phase`, `text_delta`, `reasoning_delta`, `tool_started`, `tool_finished`, `permission_requested`, `warning`, `error`, `turn_finished`. Provider-specific payload parsing happens on host. The webview receives semantic presentation data, not raw CLI JSON.

Tool events include a stable ID, human action label, kind icon semantic, allowed detail level, status and duration. Detail may be omitted by policy. A `tool_finished` event must not silently become a natural-language assistant message. The UI represents it in the activity timeline.

### 3.5 Persistence and recording

Persist a structured session record host-side after every terminal event and after a debounced 750 ms streaming checkpoint. A saved transcript contains user-visible prompts, assistant final text, safe activity summaries, selected context identities, engine/model metadata and timestamps. It does not contain hidden thought text unless a future explicit setting allows it, attachment base64, raw tool output, credentials, opaque permissions or raw trace payloads.

On reopening the panel, hydrate recent transcript items immediately and lazy-load older history in pages of 50. Render a maximum of 200 DOM transcript nodes; virtualize earlier items with a “Load earlier messages” button. Export writes structured Markdown or JSON from host storage; the webview does not scrape `innerText` and cannot announce success until host returns `export_completed`.

## 4. Visual system

### 4.1 Design direction

Use **VS Code-native graphite**, not a generic web SaaS theme and not a forced black clone. The design is compact and technical: a soft near-black field, restrained cool-gray boundaries, one blue action accent, warning amber, red stop/error and green success. It must adapt to all VS Code themes using CSS theme variables first. Hard-coded values are fallback colors and reference tokens only.

The target composer mirrors the reference image: broad rounded shell, thin cool-gray border, an upper text region separated by a horizontal rule, and a lower compact command bar. It is anchored at the bottom with 12px side gutters, not floating over transcript content.

### 4.2 CSS tokens

Declare below `.UnicDB-ai-chat-v2` only. Use `var(--vscode-...)` first.

```css
.UnicDB-ai-chat-v2 {
  --chat-canvas: var(--vscode-editor-background, #0d1117);
  --chat-surface: var(--vscode-editorWidget-background, #161b22);
  --chat-surface-raised: var(--vscode-quickInput-background, #1c2128);
  --chat-input: var(--vscode-input-background, #10151c);
  --chat-border: var(--vscode-panel-border, #3b434d);
  --chat-border-strong: var(--vscode-focusBorder, #5f9eff);
  --chat-text: var(--vscode-foreground, #e6edf3);
  --chat-muted: var(--vscode-descriptionForeground, #8b949e);
  --chat-placeholder: var(--vscode-input-placeholderForeground, #7d8590);
  --chat-hover: var(--vscode-list-hoverBackground, #21262d);
  --chat-selected: var(--vscode-list-activeSelectionBackground, #264f78);
  --chat-selected-text: var(--vscode-list-activeSelectionForeground, #ffffff);
  --chat-primary: var(--vscode-button-background, #2f81f7);
  --chat-primary-hover: var(--vscode-button-hoverBackground, #4090ff);
  --chat-primary-text: var(--vscode-button-foreground, #ffffff);
  --chat-success: var(--vscode-testing-iconPassed, #3fb950);
  --chat-warning: var(--vscode-editorWarning-foreground, #d29922);
  --chat-warning-bg: var(--vscode-inputValidation-warningBackground, #3b2f0d);
  --chat-danger: var(--vscode-testing-iconFailed, #f85149);
  --chat-danger-bg: var(--vscode-inputValidation-errorBackground, #3c1518);
  --chat-shadow: var(--vscode-widget-shadow, rgba(0, 0, 0, .42));
  --chat-radius-sm: 6px;
  --chat-radius-md: 10px;
  --chat-radius-lg: 16px;
  --chat-space-1: 4px;
  --chat-space-2: 8px;
  --chat-space-3: 12px;
  --chat-space-4: 16px;
  --chat-control: 32px;
  --chat-transition-fast: 100ms ease-out;
}
```

The visual fallback palette matches the image context: canvas `#0d1117`, composer input `#10151c`, border `#3b434d`, primary send `#8e3b43` only when the user explicitly chooses a Claude-inspired crimson accent mode. Default UnicDB accent remains VS Code blue. Do not force orange/red brand colors in all themes.

### 4.3 Typography

Use `var(--vscode-font-family)` for UI, `var(--vscode-editor-font-family)` for code, path, SQL, token/usage data and command syntax.

| Element | Size / line height | Weight |
|---|---:|---:|
| App/session title | 13px / 18px | 600 |
| Model and context chips | 12px / 18px | 600 |
| Composer text | 14px / 21px | 400 |
| Message body | 13px / 20px | 400 |
| Menu title | 13px / 18px | 500 |
| Menu description/detail | 11px / 16px | 400 |
| Tool/usage metadata | 11px / 16px | 400 |
| Code block | 12px / 18px | 400 |

Never uppercase labels solely for decoration. Use sentence case: “Bypass permissions”, “Attach context”, “Show activity”.

### 4.4 Global layout

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Header: [UnicDB] [session title] [engine status]              [⋯ menu]      │ 40px
├────────────────────────────────────────────────────────────────────────────┤
│ Optional context/status banner                                               │ 28–40px
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│                     Scrollable transcript / activity                      │ flex 1
│                                                                            │
│                                           [↓ 3 new activities]             │
├────────────────────────────────────────────────────────────────────────────┤
│ Context chips / attachment strip, only when non-empty                      │ max 72px
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ Composer text area / focus hint                              [mic*]   │ │ 64–160px
│ ├────────────────────────────────────────────────────────────────────────┤ │
│ │ [+] [slash] [model chip] [file chip]       [permissions]     [send]   │ │ 48px
│ └────────────────────────────────────────────────────────────────────────┘ │
│ “Enter to send · Shift+Enter for new line”                                 │ 20px
└────────────────────────────────────────────────────────────────────────────┘
```

Header height is 40px. Root has 12px horizontal and 10px vertical padding at normal panel widths. The transcript has 8px horizontal padding and 16px vertical gap around message turns. Composer stays `position: sticky; bottom: 0` within the panel shell and uses `flex: 0 0 auto`; do not use `position: fixed` relative to the viewport.

At widths below 420px, hide non-essential label text but retain accessible names; model and context chips horizontally scroll instead of overlapping. At below 320px, action toolbar becomes two rows: primary `[+] [/ ] [model]` then safety/send row. No control may become narrower than 32×32 CSS pixels; touch-friendly hit targets get a 40×40 invisible target where layout permits.

## 5. Component specification

### 5.1 Header

Header children are: product mark (16px), editable session title, engine status pill, optional unsaved indicator and overflow menu.

| Control | Icon | Visible label / tooltip | Click behavior | Disabled/loading/error behavior |
|---|---|---|---|---|
| Product mark | `database` or existing UnicDB mark, 16px | `UnicDB AI` | Opens session list only if the session sidebar ships; otherwise no button behavior. | Decorative if no session list; `aria-hidden=true`. |
| Session title | none | e.g. `Explain index.vue` | Click or F2 opens inline rename; Enter saves; Esc reverts. | During rename show 1px focus border; host failure retains title and toast. |
| Engine pill | `plug` / provider-neutral glyph, 14px | `Claude Code · Ready` | Opens engine picker if idle; otherwise shows current engine details. | Starting has 12px spinner; unavailable is amber and opens fix instructions. |
| Overflow | `ellipsis`, 16px | `More chat actions` | Menu: New chat, Rename, Export, Clear, View diagnostics, Open settings. | Items are individually capability-gated. |

Use a 1px bottom border and no full-width colored banner. Engine status must say “Ready”, “Connecting”, “Working”, “Stopped” or “Unavailable”; it must not always claim “streaming”.

### 5.2 Transcript and message turns

A turn is a 100% width block with three logical sections: user request, compact activity timeline, assistant answer. User bubbles align right and use `--chat-primary` at 14% maximum visual dominance. Assistant content does not need a large rounded box for plain text; use an unboxed readable column with code blocks and cards only where structure is needed. This avoids the noisy “every paragraph in a card” appearance.

User bubble: max width 78%, padding 8px 12px, border radius `12px 12px 4px 12px`, 13px text. Assistant text: max width 880px or 92% available width, padding 4px 0, 13px/20px. On a narrow panel use 100% width for both except 8px margins. Every user message gets a hover-only action row: Copy, Edit, Retry. Every final assistant response gets Copy, Regenerate, Insert SQL (when a SQL block is present), and More. Actions are button elements, 28×28px, with `title`, `aria-label`, focus ring and no icon-only action exposed without tooltip.

Never mutate an assistant bubble from raw stream to an unrelated final node. Keep the same stable `messageId`, maintain raw text separately, progressively render safe Markdown on a 100ms animation-frame/debounce cadence, and finalize once. On Stop, retain partial text with a muted “Stopped” footer and enable Regenerate.

### 5.3 Activity timeline, thinking and tools

Do not call private model reasoning “Thinking” unless the engine explicitly emits an allowed reasoning event. When reasoning is unavailable, show a neutral state row: `Working…` and elapsed seconds. When it is allowed, name it `Reasoning` and make it collapsed by default.

The activity timeline appears between user request and assistant response. Its collapsed header is 28px high: chevron, state icon, a truthful summary such as `Read 2 files · 1.4s`, and duration. Expanded rows are 30px minimum. Each row shows an icon semantic, label, status, duration and accessible detail button.

Tool states: queued is muted gray dot; running is blue 12px spinner; succeeded is green check; denied is amber shield; failed is red x; cancelled is gray stop-square. Tool results default collapsed. A tool card may show an allowlisted summary, not raw giant output. Copy detail is available only when host marks it safe. The user must see a tool began before it completes; no silent work.

A stalled-warning timer triggers after 12 seconds with no user-visible event: `Still working. You can stop this turn.` At 30 seconds show `Still waiting for <engine>. Check engine status or stop.` Do not fabricate failure. A host may send retry status; UI shows `Retrying (1/2)…` and remains stoppable.

### 5.4 Composer shell

Composer outer shell: border 1px `--chat-border`, radius 16px, background `--chat-input`, `box-shadow: 0 8px 24px var(--chat-shadow)` only while focused or popover open. Idle has no heavy shadow. It has two fixed visual regions separated by 1px `--chat-border`.

Top text region: min-height 64px, max-height 160px, inner padding 14px 16px 10px. The textarea is borderless, resize disabled, transparent background, `width:100%`, max 7 visual lines, overflow-y auto after limit, and auto-grows using measured `scrollHeight`; never use `rows` as its behavior model. Placeholder when panel focus is inactive: `⌘ Esc to focus or unfocus UnicDB AI`. Placeholder when focused: `Ask about this workspace or database…`. On Windows/Linux dynamically display `Ctrl+Esc` if the host supports the shortcut. Focus/blur controls are host commands, not fake text.

Bottom action region: min-height 48px, padding 7px 10px, `display:flex`, gap 6px, align center. Left group contains attach and command controls; center group scrolls context/model chips; right group contains permission control and primary action. Use `min-width:0` on flex children and no hidden overlap.

### 5.5 Composer control inventory

| ID | Position | Icon / dimensions | Label and tooltip | Idle behavior | Busy behavior | Error / unavailable behavior |
|---|---|---|---|---|---|---|
| `attachContextBtn` | bottom left | `plus`, 20px glyph, 32×32 target | `Attach context` | Opens context menu: Current file, Selection, Files…, Database object…, Image… only when allowed. | Still enabled for next draft; never changes active turn context. | Disabled entries explain why in menu. |
| `slashCommandBtn` | left of model | `/`, 16px, 32×32 | `Commands` | Opens the same slash autocomplete as typing `/`; focuses textarea. | Enabled for drafting; selection does not submit. | Never a gray fake/dead affordance. |
| `modelChipBtn` | left/center | provider-neutral 14px glyph; min 36px high | e.g. `unic-sonnet High`; `Choose model` | Opens configured role/model menu; keyboard select uses host ack. | Disabled only while a host prohibits switch mid-turn; tooltip says why. | `No model configured` opens AI settings. |
| `contextChipList` | center | file/database glyphs, 16px | Each has full accessible path/source | Selected refs appear as scrollable removable chips. Click previews, x removes. | Existing chips belong to unsent next draft and remain editable. | Failed/changed refs get amber outline and a Resolve menu. |
| `schemaChipBtn` | center, after context chips | `database`, 14px | `Active schema: public` | Opens existing host schema picker. | Current turn not mutated; selection applies to future turns. | Disabled with exact connection explanation. |
| `permissionBtn` | right, before send | `shield-check` or `shield-alert`, 16px | `Permissions: Ask every time` | Opens permission policy sheet. | Remains enabled; does not auto-apply to current pending prompt without confirmation. | If not supported, hidden rather than disabled. |
| `micBtn` | upper right, optional | `mic`, 18px, 32×32 | `Voice input` | Ship only after supported; otherwise omit entirely. | Stops only voice capture, not AI turn. | Never render “coming soon” as a control in primary chrome. |
| `sendBtn` | bottom right | upward arrow, 18px, 40×40 square / radius 10px | `Send message (Enter)` | Validates then sends once; background primary blue. | Replaced in place by Stop. | Disabled when draft empty/invalid, tooltip named exact cause. |
| `stopBtn` | bottom right replacement | stop square, 16px, 40×40 | `Stop generating` | Hidden. | Visible red `--chat-danger`; immediate cancel intent, then 250ms pending lock. | If cancel fails, return to Working with non-blocking toast; no false “Stopped”. |

The screenshot’s upward-arrow send button is adopted as an upward arrow, not a paper plane. In VS Code it remains an SVG created locally, `aria-hidden=true`, inside an accessible `button`. Bypass is not the default primary label: show `Permissions: Ask` with a shield. “Bypass permissions” exists in the menu only after an explicit warning and only when engine/policy says it is valid.

### 5.6 Attach context menu

The plus button opens a 300px minimum / 420px maximum menu, left-aligned to the button. Rows are 40px high with 16px icon, title and 11px descriptive detail.

| Menu row | Shortcut | Result |
|---|---|---|
| Current file | `@file` | Adds active document identity; if dirty, badge says Unsaved. |
| Selection | `@selection` | Adds active selection range and source revision; unavailable with no selection. |
| Files… | `@` | Opens mention/file search mode, never native browser file picker by default. |
| Database object… | `@db` | Opens database object mention mode using active connection/schema. |
| Image… | none | Opens image picker only if active model supports images. Enforce existing host limits. |
| Paste image | `⌘V` / `Ctrl+V` | Only when clipboard has supported image and image capability is true. |

Every menu row that cannot run remains present only if it teaches a meaningful capability; it has a disabled state and descriptive detail such as `Select a database connection first`. Do not show options that cannot exist for the selected engine merely as a tease.

### 5.7 Model and engine menus

Model chip menu supports Up/Down, Enter/Tab selection, Escape close, click selection, `aria-controls`, `role=listbox`, `aria-activedescendant` and 44px rows. Each model row shows role (`Work`, `Smart`, `Lite`, `Autocomplete`), friendly model display name, quality/latency badge and image capability icon when applicable. The active row uses a left check icon, not a full blue rectangle only.

Engine changes occur from header engine pill or `/engine`, not accidental model chip selection. Engine rows: OMP, Claude Code, Codex, Builtin; each has `Ready`, `Starting`, `Unavailable` or `Not installed` status and a one-line resolution. Choosing a new engine opens confirmation if a turn is active: `Stop the current response and switch to Codex? Your unsent draft is preserved.` Engine switch is host acknowledged. The UI retains the old engine badge until `capabilities` confirms the new engine.

### 5.8 Permission sheet

A permission request is an anchored sheet above composer, 360px–560px wide, with a semantic label such as `Allow tool action?`, tool name, exact safe detail, scope selector and actions. Required buttons: `Allow once` (primary), `Always allow for this chat` only when host/policy supports it, and `Deny` (secondary). The active default must be Deny/no selection; Enter must not implicitly allow. Escape denies only after the user sees a confirmation for destructive/high-impact requests; for ordinary requests Escape simply returns `Deny` if host timeout policy defines it.

The top composer permission menu describes current policy only. It cannot resolve a pending tool request invisibly. Bypass shows a warning panel: `This may let the selected AI run supported tools without asking in this chat. Destructive SQL and workspace trust rules still apply.` User must choose `Enable for this chat` intentionally. Reset on chat close and engine change.

## 6. Keyboard, `/` commands and `@` mentions

### 6.1 One keyboard controller

There must be one capture-phase composer keyboard controller. Component modules may expose semantic callbacks but may not add competing `keydown`, `keyup` or `input` send logic. Follow this precedence in exactly this order:

1. If IME composition is active (`event.isComposing`, compositionstart/compositionend state, or keyCode 229), do not send, select a menu item or close autocomplete.
2. If `Shift+Enter`, insert exactly one newline at current selection; close slash/mention menu; preserve text before and after selection; auto-grow. This is mandatory even when a menu is open.
3. If a permission sheet owns focus, let its keyboard handling run.
4. If autocomplete is open: Up/Down moves active selectable row; PageUp/PageDown moves by visible rows; Enter/Tab accepts active selectable item; Escape closes it. No accepted item sends a chat turn.
5. If `Cmd/Ctrl+Enter`, do not submit. Reserve it for host/editor commands unless explicitly assigned later.
6. If plain Enter and the composer draft is valid and turn phase is idle/completed/failed, submit exactly once.
7. Otherwise leave browser/textarea behavior alone.

Plain Enter never sends while a turn is connecting, waiting, streaming, awaiting permission or stopping. The draft stays editable and its button changes to `Send when ready` disabled, with inline hint `AI is responding. Your next draft is saved here.` A future deliberate queue feature may add a Queue button; do not accidentally invent queue semantics now.

### 6.2 Slash command behavior

Typing `/` opens command autocomplete only when it begins the current logical line after optional whitespace. It does not open in URLs, paths, Markdown code fences or ordinary prose. Clicking the `/` button opens the identical popover state through the shared controller.

Menu layout: header `Commands`, maximum 8 results before scrolling, 44px selectable rows, 12px vertical padding. Each row has slash glyph, command name, description and optional argument syntax. The top row defaults active. Filter on input with no host round trip for universal commands. Engine-specific commands are supplied in `capabilities.commands` and visibly tagged with engine name.

| Universal command | Inserted template | Execute behavior | Notes |
|---|---|---|---|
| `/new` | `/new` | Creates fresh saved transcript/session after confirmation if draft/history exists. | Does not erase old session. |
| `/clear` | `/clear` | Confirms then clears visible current transcript and host session messages. | Stops active turn first only after confirmation. |
| `/help` | `/help` | Opens built-in command help in a local panel/card. | Does not call provider. |
| `/engine` | `/engine ` | Opens engine picker; optional validated engine argument. | Must support all host-advertised engines, not only legacy builtin/omp. |
| `/model` | `/model ` | Opens model/role picker or shows active model. | Host authoritative. |
| `/context` | `/context` | Opens context inspector. | Shows exact selected refs and policy exclusions. |
| `/export` | `/export ` | Opens export format/destination request. | Announce success only after host write confirmation. |
| `/resume` | `/resume` | Opens saved UnicDB transcript picker. | Label provider-native resume only if `nativeSessionResume=true`. |

Engine-specific commands are never copied from another tool by assumption. OMP/Claude Code/Codex provider command descriptors are registered by host only when adapter has a verified semantic implementation. If a command name collides, show universal command first and disambiguate provider command as `Claude Code: <name>`.

Selection behavior: mouse click, Enter or Tab inserts `/command ` and moves caret after the trailing space. It does not execute. On the next Enter with no menu, parse and execute only a complete valid local command. Invalid arguments preserve input and show inline error with one example. Unknown slash input offers `Send as message` as an explicit action; it must not silently reach an engine as a command nor be discarded.

### 6.3 Mention behavior

Typing `@` at an eligible token boundary opens a unified context search. It does not trigger inside email-like words, code spans/fences or an escaped `\@`. Use a robust parser based on current value and caret on every `input`, `selectionchange`, paste and pointer selection change, not only `keyup`.

Initial groups: `Files`, `Selection`, `Database`. For a new empty `@`, show group suggestions. With a query, debounce host search 150ms. Host search includes `requestId`, `draftRevision`, query and current context scope. Show a spinner only after 200ms. Results use stable `ContextRef` identities and have no raw content in DOM attributes.

| Kind | Icon | Primary label | Secondary detail | Inserted display token |
|---|---|---|---|---|
| File | `file-code` / matching file icon | `index.vue` | `src/pages/index.vue` | `@index.vue` rendered as a chip/reference span |
| Current selection | `selection` | `Selection in index.vue` | `Lines 22–48 · unsaved` | `@selection(index.vue:22–48)` |
| Table | `table` | `orders` | `production.public.orders` | `@table(orders)` |
| View | `eye` | `monthly_sales` | `analytics.public.monthly_sales` | `@view(monthly_sales)` |
| Routine | `symbol-method` | `calculate_total()` | `public.calculate_total(integer)` | `@routine(calculate_total)` |
| Schema | `database` | `public` | `Active database connection` | `@schema(public)` |

Rows are 44px, with 16px icon, title and one truncated detail line. Duplicate names always show distinct paths or connection/schema. Database mentions add schema metadata only; table rows require a separately governed tool action and visible permission.

On acceptance, replace only the active `@query` range, preserve every other character and caret, then represent the reference structurally in selected context chips. The visible textual reference can remain in the textarea for transparency, but outbound request uses structured identities. The chip shows 16px kind icon, truncated label, status and remove x. Clicking chip previews safely; it does not call the model. If the underlying file changed, show amber `Changed` status at send and offer Refresh, Keep snapshot, Remove. If a reference is unavailable/forbidden, prevent ambiguous send with a Resolve dialog; user may explicitly choose Send without it.

If no results, show non-selectable `No matching context`. If search fails, show non-selectable `Could not search context` plus a clickable Retry button. Results from stale request IDs/revisions are ignored. A response arriving after Escape or removal cannot reopen the popover.

## 7. Loading, errors and recovery

### 7.1 Honest status vocabulary

Use one precise status at a time:

| State | UI copy | Visual | Allowed actions |
|---|---|---|---|
| Validating | `Preparing your request…` | muted spinner in activity row | Stop; edit next draft |
| Connecting | `Connecting to Claude Code…` | blue spinner + engine pill | Stop; open engine status |
| Working, no text | `Working… 4s` | timeline row | Stop; edit next draft |
| Streaming | `Responding…` | assistant stream caret, timeline | Stop; copy partial disabled until content exists |
| Permission | `Waiting for your permission` | amber shield + permission sheet | Allow/Deny, Stop |
| Retrying | `Retrying connection (1 of 2)…` | amber spinner | Stop |
| Stopped | `Stopped` | muted square icon/footer | Regenerate, copy partial |
| Completed | `Completed in 4.2s` | muted success meta | Copy, regenerate |
| Failed | exact safe error summary | red card | Retry, copy diagnostics ID, switch engine |
| Unavailable | `Codex is not available` | amber engine pill | View setup, choose engine |

No automatic “Done” toast after a stream unless user initiated a background/long operation. Completion status must not replace output or obscure errors.

### 7.2 Error card

Error card min width equals assistant content width, padding 10px 12px, left border 3px danger, background `--chat-danger-bg`, title `Could not complete this response`, safe message, a stable short diagnostics ID and actions: Retry, Copy details, Change engine. Detail defaults collapsed. Never expose API keys, connection strings, raw provider JSON, raw shell command or raw stderr by default. If a provider returns a known actionable error, host maps it to user copy and an optional troubleshooting command only when safe.

A Stop failure is not a completion. Show `Could not stop yet. The engine may still be working.` retain the active Stop button and poll/accept terminal host event. A disconnected database cancels database-dependent tool work and shows `Database connection changed. Start a new request when it is ready.` Existing host recovery/policy rules retain authority.

### 7.3 Scroll discipline

Auto-scroll only when bottom distance is <= 48px at the moment a user-visible response frame arrives. If the user reads older content, preserve scroll and increment a `New activity` pill in bottom right. Pill text is `↓ 1 new response` or `↓ 4 new activities`, has min height 28px, clicking scrolls to bottom, then hides. Reasoning-only chunks do not force a scroll. Smooth scroll only when `prefers-reduced-motion` is not reduce. On keyboard focus in composer, do not jump transcript unless a user sent a message.

## 8. Accessibility and quality requirements

Meet keyboard-only operation and WCAG AA contrast as a release criterion. Use real button/input/textarea elements, not clickable divs. Every icon-only control has matching `aria-label` and `title`; tooltip delay is 500ms mouse hover and immediate focus description where useful. CSS focus ring is 2px `--chat-border-strong`, 2px offset, never removed. Use no color alone for statuses: icon + text + color.

Use one polite live region for status changes and one assertive region only for permission/error needing immediate attention. Do not announce every token or thinking chunk. Autocomplete uses textarea/combobox linking, `aria-expanded`, `aria-controls`, stable listbox/option IDs and `aria-activedescendant`; focus remains in textarea during navigation. Popovers trap focus only when modal (permission confirmation); normal slash/mention popovers do not.

Support 200% browser zoom, 320px panel width, high-contrast themes, right-to-left text in messages, long unbroken SQL/path strings, screen readers and reduced motion. CSS animation duration is <= 150ms for user-triggered expand/collapse; spinners/caret stop animation under reduced motion.

## 9. Implementation roadmap

Each phase is a separately reviewable PR/task. An AI implementor must finish test/verification of one phase before starting the next. No phase may regress host security or change unrelated database UI.

### Phase 0 — Baseline and design lock

**Input:** existing chat sources and tests. **Output:** screenshots/recorded baseline of idle, streaming, error, permission, slash, mention and narrow layout; a capability matrix from actual adapters. **Tasks:** read every adapter and confirm exact features; inventory legacy element IDs/tests; create a migration decision record. **Verify:** baseline tests pass; no source behavior change. **Exit:** product owner approves capability matrix and draft visual tokens.

### Phase 1 — Typed capability and event contract

**Input:** existing message protocol and engines. **Output:** `EngineCapabilitySnapshot`, versioned frames with session/sequence/turn correlation and compatibility bridge. **Tasks:** create closed types, adapter capability providers, host post wrapper, reducer fixtures. **Verify:** unit tests cover every engine, unknown engine fallback, stale frame rejection, no sensitive fields in frame schemas. **Exit:** webview can render a static capability snapshot from each engine fixture.

### Phase 2 — State store and transcript renderer

**Input:** phase 1 frames. **Output:** pure reducer, stable DOM transcript rendering and activity events. **Tasks:** split safe Markdown/thread primitives, support stream updates in place, timeline items, terminal states, explicit scroll policy. **Verify:** reducer tests for all state transitions; DOM tests prove no raw HTML injection; browser smoke proves stream, Stop and error do not create orphan bubble. **Exit:** new transcript renders behind a feature flag with current composer retained.

### Phase 3 — Composer v2 visual shell

**Input:** screenshot reference and design tokens. **Output:** rounded two-row composer matching specification, auto-grow textarea and reflow-safe toolbar. **Tasks:** add scoped CSS, create semantic buttons, remove dead microphone placeholder, preserve theme tokens. **Verify:** visual screenshots in dark/light/high-contrast at 320/480/768px, keyboard focus audit, no overlapping buttons at long model/schema labels. **Exit:** idle composer is usable and visually approved.

### Phase 4 — Single keyboard controller and universal commands

**Input:** composer v2 and current local commands. **Output:** one controller that enforces Enter/Shift+Enter/IME behavior and a full accessible slash menu. **Tasks:** remove duplicate key handlers, add command descriptors/help/validation, wire confirmation for clear/new/export. **Verify:** KBD and SLASH acceptance suite below in jsdom plus VS Code browser smoke. **Exit:** Shift+Enter has zero known accidental send paths.

### Phase 5 — Structured `@` context system

**Input:** existing mention resolution and grounding. **Output:** `ContextRef` identities, context chips, correlated search frames and unified mention popover. **Tasks:** add requestId/revision, host resolver categories, stale/changed/error state, safe preview, context inspector. **Verify:** MENTION suite below, including duplicate name and late response races. **Exit:** no unresolved mention can silently disappear from a sent request.

### Phase 6 — Engine/model/permissions integration

**Input:** capabilities and v2 UI. **Output:** model/engine menus, truthful status, permission sheet and safe bypass policy UI. **Tasks:** reconcile legacy `/engine builtin|omp` with all advertised engines; hide unsupported actions; native vs saved resume labels; host ack controls. **Verify:** per-engine contract tests, permission denial/default tests, engine switching while busy, policy/security review. **Exit:** every displayed action has a verified host action or is not displayed.

### Phase 7 — Sessions, export and diagnostics

**Input:** terminal events and structured transcript records. **Output:** session list, rename/new/clear, paged history, confirmed Markdown/JSON export and safe diagnostics ID. **Tasks:** host storage, data retention migration, export writer and UI responses. **Verify:** restart/reload tests, export content test, secret/base64 exclusion test, no native resume claim for unsupported engine. **Exit:** chat history survives panel closure without DOM scraping.

### Phase 8 — Hardening, performance and release gate

**Input:** complete v2 behind flag. **Output:** feature flag removal after quality gates, documentation and release notes. **Tasks:** full regression, browser smoke, manual accessibility pass, 10-minute streaming soak, theme/resize performance profile, release packaging checks. **Verify:** no unbounded DOM growth, no listener duplication after repeated panel open/close, all focused and full tests pass. **Exit:** version bump/release process only after user-visible completion evidence.

## 10. Test and acceptance matrix

### Keyboard tests

- **KBD-01:** plain Enter sends exactly one non-empty request.
- **KBD-02:** Shift+Enter inserts exactly one newline and sends no request.
- **KBD-03:** KBD-02 remains true with slash and mention popover open.
- **KBD-04:** Ctrl/Cmd+Enter sends no request.
- **KBD-05:** IME composition Enter never sends or selects an option.
- **KBD-06:** Escape closes slash/mention without changing text, stopping a turn or reopening on stale response.
- **KBD-07:** repeated Enter and double send click do not duplicate a turn.
- **KBD-08:** while busy, typing edits next draft but cannot send/queue implicitly.

### Slash tests

- **SLASH-01:** typed `/` and button click invoke same controller/popover.
- **SLASH-02:** slash in URL/path/code does not open popover.
- **SLASH-03:** arrows, PageUp/PageDown, Tab, Enter and Escape behave as specified.
- **SLASH-04:** selecting command inserts only; next valid Enter executes.
- **SLASH-05:** invalid argument preserves draft and explains syntax.
- **SLASH-06:** unknown command needs explicit Send as message.
- **SLASH-07:** command availability changes when host capabilities change.
- **SLASH-08:** clear/new/export confirmation and host acknowledgement behavior are correct.

### Mention tests

- **MENTION-01:** `@` eligibility excludes email/code/escaped contexts.
- **MENTION-02:** duplicate filenames/database names have distinct detail.
- **MENTION-03:** old request ID/draft revision cannot replace newer response.
- **MENTION-04:** late result after Escape/remove cannot show menu.
- **MENTION-05:** selection preserves text before and after caret.
- **MENTION-06:** paste, mouse/caret and input events refresh active token.
- **MENTION-07:** context chip removal affects only that structured reference.
- **MENTION-08:** unavailable/changed reference requires explicit resolution at send.
- **MENTION-09:** preview/search do not send model request.
- **MENTION-10:** loading/error/empty rows cannot be selected.

### Engine, status and safety tests

- **ENGINE-01:** OMP, Claude Code, Codex and builtin fixtures render their exact advertised capability state.
- **ENGINE-02:** unsupported native resume is labelled saved transcript resume, never provider resume.
- **ENGINE-03:** engine switch waits for host acknowledgement and preserves unsent draft.
- **ENGINE-04:** all engine lifecycle phases produce truthful status and stoppable state.
- **SAFE-01:** webview message schemas never include secrets/base64 trace/raw credentials.
- **SAFE-02:** XSS payloads in message, filename, tool name/detail and error remain text.
- **SAFE-03:** bypass policy never removes destructive SQL/workspace trust gating.
- **SAFE-04:** permission default is deny; Enter does not implicitly approve.

### Visual/browser tests

- **VISUAL-01:** dark/default, light and high contrast snapshots at 320, 480, 768 and 1200 CSS pixels.
- **VISUAL-02:** 200% zoom has no clipped/overlapping visible control.
- **VISUAL-03:** composer stays visible when transcript overflows and attachment strip grows.
- **VISUAL-04:** 200 messages leaves <=200 rendered message DOM units and scrolling remains responsive.
- **VISUAL-05:** reduced motion disables caret/spinner/pulse animation.

## 11. Explicit implementation instructions for AI coding agents

1. Read this document, current `src/ui/aiChatPanel.ts`, current `src/ui/aiChatPanelMessages.ts`, current composer/main/thread modules and their tests before editing. Do not assume source comments are current behavior.
2. First make the capability/event types and their tests. Do not begin CSS clone work until the host can communicate real capabilities.
3. Preserve old webview protocol behind an adapter only for one migration phase. Do not mix V1 and V2 `type` frame meanings under the same discriminator.
4. Build controller/reducer tests before DOM test. The controller is the only location allowed to send a turn from keyboard or button activation.
5. Keep all user/provider strings in `textContent`; use the existing escape-first Markdown renderer for assistant Markdown only. Add regression tests before touching rendering.
6. Do not ship a disabled microphone, disabled slash button or fake `streaming` label. Hide unsupported optional controls; show a truthful explanation where the missing feature impacts a user decision.
7. Do not use third-party UI framework, CDN, remote icon font or browser storage. Use local inline SVG/icons and existing esbuild/webview setup.
8. Keep all CSS scoped below `.UnicDB-ai-chat-v2`. Use VS Code theme variables. Do not alter SQL console/results panel styles.
9. After each phase, run focused Vitest tests and browser smoke. Test the extension host bundle, not just raw TypeScript, before claiming visual behavior works.
10. Do not publish or bump version unless the user explicitly requests a release. When release is requested, follow repository release protocol exactly.

## 12. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| UI rewrite duplicates event/keyboard handlers | Current composer/main already split key logic; duplicate handlers cause accidental sends. | Single controller, remove legacy listener path in same migration, test duplicate send. |
| Provider parity is assumed instead of verified | Claude Code/Codex/OMP do not necessarily share resume, thought or command semantics. | Capability snapshot produced host-side; hidden unsupported UI; adapter-level tests. |
| Fancy timeline exposes sensitive data | Tool/trace payloads may carry paths, secrets or large data. | Host creates allowlisted safe summary; webview never receives raw trace/credentials. |
| Layout regresses only in real webview | jsdom cannot catch clipping/height/overflow issues. | Screenshot/browser smoke at widths/themes/zoom, explicit visual test gate. |
| Session persistence corrupts context/privacy | DOM text and attachments are not safe durable record formats. | Structured host storage; redaction and migration tests; no webview storage. |

## 13. External-reference research gate

The requested Marketplace extensions are useful visual/function references, but their source/feature claims must be verified before copying any code or calling a behavior “the same as extension X.” During initial research, automated Marketplace/Web fetch access was unavailable in this environment. Before Phase 0 is approved, record for each extension: official Marketplace URL, source repository URL, license, current maintenance signal, actual command/mention implementation files, and a list of code-confirmed reusable patterns. Do not download/execute third-party extension code inside UnicDB until license and security review are complete.

The product requirement remains: match the quality of a professional AI Chat extension and respect the currently selected engine. This specification supplies the behavior contract independently of unverified third-party claims.
