# PLAN — CHATV2: Complete professional AI Chat UI replacement

## 1. Intent and authority

The user authorizes a specification-and-task cycle only. Do not implement runtime code in this cycle. The future executor must replace the full V1 chat interface rather than patching isolated CSS, while retaining the proven extension-host engine, database, tool, policy, permission, attachment, trace-redaction and cancellation paths.

Source of product behavior: `docs/AI_CHAT_PROFESSIONAL_SPEC.md`. Source of current implementation truth: current TypeScript and tests. If they disagree, the executor records the discrepancy in the task Discussion and follows this plan unless it would weaken security or break a verified host contract.

Success means a coder can execute one task at a time without inventing technology, geometry, button meaning, keyboard precedence, wire contracts, loading copy, error handling, tests, or deletion scope.

## 2. Technical choices — locked

| Concern | Required technology / decision |
|---|---|
| Runtime | VS Code extension host TypeScript + browser TypeScript webview; keep current Node/VS Code APIs. |
| UI framework | Native DOM components; no React/Vue/Svelte, no component framework, no runtime dependency. |
| Build | Existing esbuild entry `webview/aiChatPanelMain.ts` → `dist/aiChatPanel.js`; CSS stays in existing webview bundle pipeline. |
| State | One serializable `ChatViewState`, pure reducer, semantic actions; DOM classes are rendering output, never authority. |
| Controller | One capture-phase composer keyboard controller; components emit callbacks and never independently send. |
| Protocol | Discriminated TypeScript unions in `src/ui/aiChatPanelMessages.ts`; V2 envelope carries protocol version, sessionId, sequence and turnId where applicable. |
| Capabilities | Host-produced `EngineCapabilitySnapshot`; UI does not branch on provider names for features. |
| Rendering | `document.createElement`, `textContent`, `replaceChildren`; assistant Markdown uses existing escape-first renderer only. |
| Icons | Local inline SVG factory, 16/18/20px glyphs, `currentColor`; no CDN, webfont, remote assets or copied brand icons. |
| Styling | Scoped under `.UnicDB-ai-chat-v2`; VS Code theme variables first, documented hex fallback second. |
| Persistence | Host-side VS Code storage/session service only; never localStorage/sessionStorage/IndexedDB. |
| Tests | Vitest reducer/unit + jsdom component/controller + host protocol tests + bundle checks + real webview screenshot/smoke checklist. |
| Dependencies | Add none unless separately approved. Use npm only. |

## 3. Global visual contract

Root is a vertical grid: 40px header, optional 28–40px banner, `minmax(0,1fr)` transcript, max-72px context strip when non-empty, sticky composer, 20px keyboard hint. Normal root padding is 10px vertical/12px horizontal. At width <420px labels may visually hide but accessible names remain. At <320px composer actions wrap into two rows. Every actionable control is at least 32×32px; send/stop is 40×40px.

Colors are theme-first: canvas `--vscode-editor-background/#0d1117`; surface `--vscode-editorWidget-background/#161b22`; input `--vscode-input-background/#10151c`; border `--vscode-panel-border/#3b434d`; focus `--vscode-focusBorder/#5f9eff`; text `--vscode-foreground/#e6edf3`; muted `--vscode-descriptionForeground/#8b949e`; primary `--vscode-button-background/#2f81f7`; success `--vscode-testing-iconPassed/#3fb950`; warning `--vscode-editorWarning-foreground/#d29922`; danger `--vscode-testing-iconFailed/#f85149`.

Typography uses VS Code UI font, except code/path/SQL/usage uses editor font. Composer 14/21px; message 13/20px; chips 12/18px weight 600; title 13/18px weight 600; metadata 11/16px. Radii: 6/10/16px. Spacing scale: 4/8/12/16px. Focus ring: 2px focus color + 2px offset. Interaction transitions <=150ms; disabled under reduced motion where animated.

Composer is a two-row 16px-radius shell. Top region is 64–160px with 14px 16px 10px padding and auto-growing borderless textarea, max seven visual lines. Bottom is min 48px, 7px 10px padding, 6px gaps. It is sticky in layout, never viewport-fixed. Focus/open-popover shadow is `0 8px 24px var(--chat-shadow)`; idle has no heavy shadow.

## 4. Global interaction contract

Keyboard precedence is immutable: composition/229 → Shift+Enter newline → focused permission sheet → open autocomplete navigation/selection → Ctrl/Cmd+Enter no-op → plain Enter send only in idle/completed/failed → native textarea behavior. Shift+Enter inserts exactly one newline and closes autocomplete even when slash/mention is open. While busy the user can edit a next draft, but cannot send or queue it implicitly.

Slash and mention use one anchored, non-modal popover. Focus remains in textarea. Rows are 44px; max eight visible rows; listbox semantics with stable option IDs and `aria-activedescendant`. Selection inserts/accepts only; it never sends. Mention search debounce is 150ms; spinner delay 200ms; stale requestId or draftRevision responses are ignored.

Host is authoritative for engine, model, permission policy, session persistence, context identity/resolution, exports and final turn state. Webview is authoritative only for draft/caret, open popover, focused element, collapsed panels and scroll position.

## 5. Button inventory — locked behavior

| Control | Placement / size | Required behavior |
|---|---|---|
| Product/session | header left, 16px mark | Session title inline rename: click/F2 edit, Enter save after host ack, Esc revert. Product mark decorative unless session list exists. |
| Engine pill | header center/right, >=32px high | Provider-neutral plug icon; truthful Ready/Starting/Working/Unavailable. Click opens engine menu; busy switch requires stop confirmation; old label remains until ack. |
| Overflow | header right, 32×32 | Menu: New chat, Rename, Export, Clear, Diagnostics, Settings; each capability-gated. |
| Attach context | composer lower-left, 32×32 plus | Opens 300–420px menu: Current file, Selection, Files, Database object, Image when supported. Remains usable for next draft while busy. |
| Slash | beside attach, 32×32 `/` | Opens same command popover as eligible typed `/`; never directly mutates textarea outside controller. |
| Model chip | center, >=36px high | Shows host display role/model; opens 44px-row listbox; no model opens settings; no optimistic state. |
| Context chips | center scrolling lane | Structured refs; click preview, x removes; amber Changed/Missing states require resolution before send. |
| Schema chip | after context, >=36px | Opens existing active-schema host picker; future draft only while busy. |
| Permission | right, >=36px | Shield + current policy; opens policy sheet. Unsupported means hidden. Bypass requires warning and never bypasses SQL/workspace-trust gates. |
| Send | lower-right, 40×40 radius 10 | Local upward arrow 18px; valid idle draft sends exactly once. Disabled state tooltip states exact reason. |
| Stop | same slot, 40×40 | Red stop-square 16px; cancel once, 250ms lock; failed cancel returns to working and remains stoppable. |
| Microphone | top-right, 32×32 | Omit until real voice support exists. Never render a coming-soon/dead control. |

## 6. Turn/status/error contract

Phases: idle, validating, connecting, waiting_for_first_event, streaming, awaiting_permission, stopping, completed, failed. Copy is fixed: `Preparing your request…`, `Connecting to <engine>…`, `Working… Ns`, `Responding…`, `Waiting for your permission`, `Retrying connection (n of m)…`, `Stopped`, `Completed in Ns`. At 12s without visible event show `Still working. You can stop this turn.`; at 30s show `Still waiting for <engine>. Check engine status or stop.` without declaring failure.

Error card has 3px danger left border, 10×12px padding, title `Could not complete this response`, safe mapped message, short diagnostic ID, collapsed safe details, and Retry/Copy details/Change engine actions. Raw stderr/provider JSON/secrets/connection strings never enter its frame. Stop failure copy is `Could not stop yet. The engine may still be working.` and does not fake a stopped state.

Transcript user bubble: max-width 78%, 8×12px, radius `12px 12px 4px 12px`. Assistant is unboxed, max 880px/92%, 4px 0. Message action buttons are 28×28 and appear on hover or keyboard focus. Streaming updates one stable messageId, coalesced <=100ms; stopping preserves partial text. Auto-scroll only when distance <=48px. Otherwise show a min-28px `↓ n new response(s)/activities` button.

## 7. Delivery waves and tasks

Wave 0: CHATV2-001 baseline/cutover map. Wave 1: 002 capabilities, then 003 protocol. Wave 2: 004 reducer, 005 shell/icons/tokens. Wave 3: 006 transcript, 007 activity/status, 008 composer. Wave 4: 009 keyboard, 010 slash, 011 mentions/context. Wave 5: 012 engine/model, 013 attachments/schema, 014 permissions/plans. Wave 6: 015 sessions/export/diagnostics, 016 errors/scroll/accessibility. Wave 7: 017 cutover/deletion/hardening.

A task is complete only after its focused tests, `npm run typecheck`, and `npm run compile` pass. Run the full `npm test` at each wave boundary. No release/version bump/publish in these tasks.

## 8. Test strategy

The executor writes tests first and records RED then GREEN in each task. Security fixtures include HTML/script payloads in user text, assistant text, file paths, database names, tool labels/details and errors. Race fixtures cover stale sequence, wrong session, wrong turn, duplicate send, late mention response, cancel/terminal overlap and host ack arriving after menu close. Visual smoke covers widths 320/420/480/768/1200, dark/light/high-contrast, 200% zoom, reduced motion, long path/model/schema text, RTL message text and 200 transcript items.

No jsdom assertion can claim pixel-perfect geometry. Geometry acceptance requires a real bundled webview/browser screenshot checklist in CHATV2-017.

## 9. Acceptance and prohibited shortcuts

All 17 task files must be `ready`, have concrete files/interfaces/tests/dependencies, and remain independently executable. Final V2 must contain no V1 competing keyboard/send listener, dead microphone, hard-coded always-streaming banner, DOM-scraped export, provider-assumed command, browser persistence, raw unsafe tool/trace detail, or global chat CSS leakage.

The compatibility bridge is temporary and deleted in CHATV2-017 after host/webview V2 contract tests pass. Do not keep two live UI trees behind a permanent flag. Do not rename unrelated DOM/classes or restyle console/results webviews. Do not publish.

## Planner self-audit

PLANNER_MODEL: UNIC SUPER. The plan is intentionally more granular than the prior documentation cycle: technology, geometry, control semantics, state ownership, failure copy, test lanes, migration dependencies and final deletion scope are fixed. External extension claims remain evidence-gated; implementation does not depend on copying third-party code.
