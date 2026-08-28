# Cycle AB Plan — AI Chat Image Attach + Clipboard Paste

Base: `main` @ v1.8.0 (cycle AA released). Executor: code-tier model. Reviewer: smart-tier (≠ executor).

Cycle AA plan/tasks: `docs/AI_HANDOFF/PLAN.md` and `docs/AI_HANDOFF/tasks/TASK-001.md` … `TASK-005.md`.
Queue spec for this cycle: `docs/AI_HANDOFF/queue/AI-CHAT-INPUT-UX-spec.md` reqs 3-5 (reqs 1-2 already shipped in cycle AA: Enter=send / Shift+Enter=newline).

## §1 Intent

The AI Chat composer is text-only. Users cannot send images with a prompt, which is the standard AI-chat affordance in ChatGPT/Claude/Cursor. Two input paths need to work:

- **Attach button** → OS file picker → multiple images → thumbnails above the textarea → send with the message.
- **Clipboard paste** → Cmd/Ctrl+V an image inside the input → same thumbnail → send with the message.

Images reach the model only when the **work model's `vision:true`** flag is on (per `src/ai/settings.ts` `AiModelConfig.vision`). When the **active role's vision is false**, the chat **blocks at attach time** with a clear warning — never pushes a broken image-only message and never silently drops the image.

### Privacy invariant (HARD, same as cycle AA §1)
> The chat feature must NEVER automatically pull database row/data content and push it to the AI. Auto-context is schema structure (DDL) only. Data sent to the AI must be only what the user explicitly pushes (typed prompt, attachments).

Image attach is **user-pushed** (the user explicitly selected or pasted it) — allowed. Auto-context (`buildMessages`) stays DDL-only; attachments are forwarded separately as `ChatContentPart[]` for the user message only. No image bytes ever enter the system prompt or DB context.

### User-locked choices (P0 batch, 2026-08-28)
- Scope: image attach + clipboard paste only (slash commands remain queued).
- Caps: **5 MB per file, max 4 per message**.
- Non-vision model: **block at attach with clear warning** (no silent fallback, no auto-switch).
- Release: **minor bump v1.8.0 → v1.9.0** (user-visible UI feature).

## §2 Scope

**In-scope (this cycle):**
1. **Host message contract**: extend `AiChatPanelWebviewMessage.send` with `attachments?: ImageAttachment[]` (id, mime, base64, bytes); host returns a per-turn `visionCapable: boolean` field on `init` (resolved once at panel ready, sourced from active role).
2. **Host validation**: per-attachment byte cap (5 MB), count cap (4), MIME sniff (`image/png|jpeg|webp|gif`). Reject non-image / oversize / overcount with structured `{type:"attach_error"}` webview message + visible warning.
3. **Webview attach button + clipboard paste**: file picker → `FileReader.readAsDataURL` → thumbnails in a strip ABOVE the textarea (above send row, inside composer card). Same strip for pasted images.
4. **Webview send-with-attachments**: `send` payload carries `attachments` (only base64/mime/bytes summary — no apiKey, no large blobs in logs). When vision unsupported by current model, the attach button is **disabled with tooltip** and paste-image is **rejected with inline warning**.
5. **Host runtime path**: `buildMessages` accepts a user-message override carrying `content: ChatContentPart[]` (text + image_url parts). Auto-context still DDL-only. Privacy sentinel test extended: `runQuery` seed must not leak even when attachments are present.
6. **CSS**: `.vsdb-chat-attachments` strip (horizontal scroll, 56×56 thumbnails, remove button overlay), `.vsdb-chat-attach-btn` (icon button next to send), `.vsdb-chat-attach-warning` (amber notice bubble).

**Out-of-scope (queued for later cycles):**
- Slash commands (`AI-CHAT-SLASH-COMMANDS-spec.md`).
- Camera capture / drag-and-drop image files (text-only paste covers req 4; OS file picker covers req 3 — DnD omitted to keep webview CSP-safe).
- PDF / DOCX / audio attachments (vision model scope may widen later — out of scope now).
- Resumable streaming of large attachments (5 MB cap renders chunking unnecessary).
- Image transcoding / EXIF strip (per-MIME validation only).

**CONSTRAINT honored:** no two same-wave tasks modify the same file. Wave plan in INDEX.md.

## §3 Approach (revised round 2)

### Plan review findings applied (cycle AB round 2 — BLOCKING)

- **CSP `img-src data:`** is required for thumbnails to render. Current `buildHtml` at `src/ui/aiChatPanel.ts:2091-2095` only declares `default-src 'none'`, `style-src …`, `script-src …`. Without an `img-src` directive, every `<img src="data:image/png;base64,…">` is blocked. TASK-001 now owns adding `img-src 'self' data:` plus a source-text test that pins the exact CSP string.
- **omp / ACP engine gate** must mirror the non-vision gate. Current `handleSend` ACP branch coerces `userMsg.content` to a string — silently dropping image parts. TASK-001 now owns treating `engine === "omp"` as a vision-unsupported case: emit one `attach_error` per attachment, drop ALL images, proceed with text-only. The text-only turn still uses the legacy ACP path.
- **`userContentOverride` removed.** Cycle-AA `buildMessages(factory, history, userMsg, …)` already accepts `userMsg.content: ChatContentPart[]`. The handler constructs the user message directly — no new parameter. TASK-001 acceptance rows #1, #4, #5 updated.

### Plan review minor findings applied

- **T3 dependency direction** declared explicitly: T3 (wave 1) asserts the CSS source as text, fulfilling the contract that T2 (wave 2) will use at runtime. T3 declares; T2 fulfils.
- **T3 edge rows added** — overflow scroll, theme-token fallback, focus-visible, dark-theme variants. Self-audit item 9 now passes for T3.



Research convergence (ChatGPT / Claude / Cursor observed image-attach UX) yields the design pillars:
- **Attachments strip above textarea, not inline** — standard pattern; survives text edits, easy to remove individually.
- **Block at attach on non-vision model** — never silently drop a user-pushed image (rejected: auto-route to vision model — costs surprise, hides model selection; rejected: send with warning text — violates "no broken messages").
- **Per-attachment bytes + count validation up-front** — fails fast before the model call; error message names the offending attachment.
- **MIME sniff via magic bytes** — defense against `image/jpeg` files that are actually `application/octet-stream`; reject with "unsupported image type" notice.
- **Privacy boundary**: `ImageAttachment` is a host-side type the webview must build explicitly (no apiKey paths); host echoes back only `{id, mime, bytes, status}` for log summarization, never the base64 bytes.

Rejected alternatives:
- *Pass image bytes as workspace URIs* — rejected; VS Code webview cannot fetch `vscode-resource://` for arbitrary blobs at message-build time (CSP / async race). Inline dataURL is the established OpenAI-vision pattern.
- *Reuse `@-mention` picker for image candidates* — rejected; picker is DB-object/file-text scoped, semantically wrong surface.
- *Stream images into the running turn* — rejected; turns are atomic (handleSend → runAgent). Attach before send, send with the prompt.
- *Block paste entirely on non-vision model* — too restrictive; we should warn + still allow text paste. Paste handler distinguishes clipboard kinds: `image/*` rejected with warning; text content still allowed.

Supersession note (cycle AA pins that this cycle retires):
- **No existing pins retire** in this cycle. Cycle AA's privacy lock stays intact (TASK-004 suite). The `send` payload change is **additive** (`attachments` is optional; absent → legacy text-only path).

Key grounded facts driving the design:
- `ChatMessage.content` already typed as `string | ChatContentPart[]` (`src/ai/provider.ts:24`) — `ChatContentPart { type: "text" | "image_url"; text?; imageUrl? }` already exists. The vision lane is wired at the type level.
- `AiConfigStore.loadSettings()` returns `{models: {work: {vision}, smart: {vision}}}` (`src/ai/config.ts:27-48`); vision flag is per-role, configurable.
- Cycle AA `send` payload: `{type:"send", text}` (`webview/aiChatPanelMain.ts:442`); extension is `{type:"send", text, attachments?}` — additive.
- `buildMessages` is the single auto-context funnel (`src/ui/aiChatPanel.ts:186-325`) — TASK-004 cycle-AA lock pins it. This cycle passes `userContentOverride?: ChatContentPart[]` through `buildMessages` so the user message can carry parts; auto-context unchanged.
- Composer DOM: `<div class="vsdb-chat-input">` contains `<textarea id="prompt">` + buttons (`renderInitial` + `wireControls` in webview). The attachment strip inserts **above** the prompt row but **inside** `.vsdb-chat-input` so the flex column renders it above the textarea.

## §4 Test Plan

| Type | Test | Expected | Task |
|------|------|----------|------|
| happy | host accepts `send.attachments` | `handleSend` with `{text, attachments:[{id, mime, bytes, base64}]}` — attachments validated, passed to `runAgent` via `userContentOverride` | T1 |
| happy | vision capability advertised on init | `init {hasHistory, visionCapable:true}` when current role's `vision:true`; `false` when not | T1 |
| happy | attach button opens file picker | click on `.vsdb-chat-attach-btn` → `<input type=file accept="image/*" multiple>` change → thumbnails render | T2 |
| happy | clipboard image paste | `paste` event with `clipboardData.items[i].type.startsWith("image/")` → same thumbnail pipeline as file picker | T2 |
| happy | send includes attachments | composer has 2 valid thumbnails + text → click send → posted `{type:"send", text, attachments:[…base64…]}` (base64 verified present, bytes field verified correct) | T2 |
| edge (non-vision) | attach button disabled | init `{visionCapable:false}` → `.vsdb-chat-attach-btn` has `disabled` attribute + tooltip "Current model does not support images" | T2 |
| edge (omp mode) | attach rejected in omp mode | `engine === "omp"` + 2 valid attachments → 2 `attach_error { reason: "vision_unsupported" }` posted, ALL images dropped, text sent only (no silent drop) | T1 |
| CSP | img-src data: present | `buildHtml` output's CSP meta contains `img-src 'self' data:` | T1 |
| CSP (regression) | legacy CSP string still present | `default-src 'none'`, `style-src …`, `script-src …` all preserved when `img-src` is added | T1 |
| mention × attachment | mention block + images coexist | user message has 1 text part (prompt + referenced-context block) + N image_url parts; text is augmented, images are siblings | T1 |
| edge (CSS overflow) | >4 thumbnails scroll | `.vsdb-chat-attachments { overflow-x: auto }` declared; no flex overflow breaks composer | T3 |
| edge (CSS theme) | warning uses theme tokens | `.vsdb-chat-attach-warning` references `var(--vsdb-warning-bg)` (no hardcoded hex) | T3 |
| edge (CSS focus) | attach button focus-visible | `.vsdb-chat-attach-btn:focus-visible` declares a focus ring via theme token | T3 |
| edge (CSS dark) | dark theme variants | `[data-theme="dark"]` block declares dark variants of the new tokens | T3 |
| edge (non-vision paste) | clipboard image paste rejected | vision=false + paste image → host receives no send; webview shows amber `.vsdb-chat-attach-warning`; text paste still works | T2 |
| edge (oversize) | 5 MB cap exceeded | 6 MB blob → host never called, single `{type:"attach_error", id, reason:"oversize"}` posted, warning bubble names the file | T1 + T2 |
| edge (overcount) | 4 cap exceeded | 5 attachments → 5th rejected with `reason:"count_cap"`, first 4 kept | T1 + T2 |
| edge (mime) | non-image MIME | `text/plain` blob → rejected with `reason:"unsupported_type"`, no thumbnail, no host send | T2 |
| edge (mime sniff) | image/jpeg with PDF magic bytes | bytes `25 50 44 46` + mime `image/jpeg` → rejected with `reason:"mime_mismatch"`, defense-in-depth | T1 |
| happy | buildMessages carries user parts | `buildMessages({…, userContentOverride: [{type:"text", text:"hi"},{type:"image_url", imageUrl:"data:image/png;base64,…"}]})` → user message has 2 content parts; system message still DDL-only; `runQuery` spy call count 0 | T1 |
| happy | privacy sentinel extends to attachments | `buildMessages` with seed sentinel + attachment → sentinel absent from system AND user parts; `runQuery` spy still 0 | T1 (regression against cycle-AA lock) |
| edge (large base64) | attachment bytes > 5 MB | validateImageAttachment throws `AttachmentError("oversize", 6_000_000)` — pure, unit-testable | T5 |
| edge (zero attachments) | send with empty attachments | `handleSend({text:"x", attachments:[]})` → treated as `text`-only; user message `content: "x"`; legacy path | T1 |
| regression (cycle AA lock holds) | buildMessages auto-context | DDL-only system prompt unchanged when attachments are absent OR present; spy `runQuery` 0 | T1 |
| regression (cycle AA UX holds) | Enter=send / Shift+Enter=newline | unchanged with attachments (keybind path independent of attachments array) | T2 |
| regression (cycle AA privacy) | no apiKey in wire | `send.attachments[i].base64` is image bytes only — no apiKey string in payload via grep | T1 |
| happy | CSS contract: thumbnail strip | `.vsdb-chat-attachments { display: flex; gap: 8px }`, `.vsdb-chat-thumb { width: 56px; height: 56px; object-fit: cover }`, `.vsdb-chat-attach-btn { cursor: pointer }` present | T3 |
| happy | CSS contract: warning | `.vsdb-chat-attach-warning { background: var(--vsdb-warning-bg) }` present, uses theme tokens | T3 |
| regression (cycle AA layout) | body.vsdb-chat-body height chain | still present, attachment strip inserts inside composer column without breaking flex chain | T3 |
| happy | pure helper: validateImageAttachment | unit-testable: 5 valid / 6 oversize / 1 wrong mime / 1 mime-mismatch / count cap | T5 |
| happy | pure helper: summarizeAttachmentsForLog | returns `{count, totalBytes, mimes:[…]}` — never includes base64 (defense against log leakage) | T5 |
| happy | pure helper: imageBytesToDataUrl | `Uint8Array([0x89,0x50,0x4E,…])` → `data:image/png;base64,iVBORw0KGgo…` | T5 |

## §5 Verification Commands

Per task in `tasks/TASK-00N.md`; house pattern:

```bash
npx vitest run src/ui/__tests__/<task-test>.test.ts
npm run typecheck
```

- Webview tests bundle the real `webview/aiChatPanelMain.ts` via esbuild inside the test (dist-independent).
- Full `npm test` at wave boundary is the regression net.
- No new npm deps; no new VS Code API surface.

## §6 Acceptance Criteria

- [ ] User can click an attach button, pick ≥1 image (OS file picker, multi-select), see thumbnails above the textarea, remove individually, and send with the prompt (T1+T2+T3+T5).
- [ ] User can Cmd/Ctrl+V an image inside the input and see it as a thumbnail (same pipeline as the attach button) (T2+T5).
- [ ] Non-vision model: attach button disabled with tooltip; paste-image rejected with inline amber warning; text paste still works; no broken send (T1+T2).
- [ ] Caps enforced: 5 MB / file, 4 / message, `image/png|jpeg|webp|gif` only; over-cap / wrong-type / MIME-mismatch surface a clear warning naming the offending attachment (T1+T2+T5).
- [ ] Image bytes reach the model via `ChatContentPart[]` only — never as text, never via system prompt, never mixed with DB context (T1).
- [ ] Privacy invariant preserved: `runQuery` spy still 0; buildMessages auto-context still DDL-only when attachments are absent OR present (T1 regression vs cycle-AA lock).
- [ ] `summarizeAttachmentsForLog` proves base64 is never logged (T5).
- [ ] No apiKey ever appears in any new message shape (T1 regression grep).
- [ ] Cycle AA UX (Enter=send, Shift+Enter=newline, pinned composer, mention dropdown) unchanged when attachments are present (T2 regression).
- [ ] `npm run typecheck` passes and affected suites green for every task; full `npm test` green at wave boundary.

## §7 Global Constraints (inherited by every TASK-xxx.md by reference)

- No new npm dependencies; webview stays CSP-safe (no inline `on*=` handlers — addEventListener only).
- `engines.vscode` stays `^1.75.0`; no new VS Code API surface.
- NO apiKey material ever enters any new message shape (both directions); image bytes are user-pushed data, not secrets, but the same belt-and-braces rule applies (logs / telemetry MUST be redacted).
- Privacy invariant §1 (HARD, verbatim from cycle AA): auto-context = DDL only; no row/data sampling anywhere in the chat path. Attachments are USER-PUSHED and forwarded only as `ChatContentPart[]` in the user message; they never alter the auto-context baseline.
- Enter must never insert a newline in the chat composer; Shift+Enter must never send (cycle AA invariant, still holds).
- Image bytes MUST NOT enter the system prompt, the auto-context, or resume replay.
- Unknown message kinds stay silently ignored on both sides (additive contract evolution).
- `engines.vscode` and `dist/vsdb-*.vsix` packaging rules unchanged (cycle AA established pattern).

## Planner Report
PLANNER_MODEL: unic-code (orchestrator-applied after cycle-AA planner infra precedent; spec is bounded enough to be planned at code tier; reviewer at smart tier provides the rigor gate)

## Planner Self-Audit
Checklist: 12/12 pass
1. §6 criteria each trace to tasks: attach/picker→T2; paste→T2; non-vision policy→T1+T2; caps→T1+T2+T5; vision parts→T1; privacy regression→T1; log redaction→T5; cycleAA keybind hold→T2; typecheck gate→all tasks.
2. Every task traces to §1/§2: T1 (contract+validation+buildMessages parts), T2 (webview UX), T3 (CSS), T5 (pure helpers). T4 merged into T1 — no separate privacy task because cycle-AA TASK-004 lock is the standing invariant; this cycle only extends its suite.
3. Together they deliver §1's success definition: attach button + paste + thumbnails + cap policy + vision gating + privacy preservation.
4. Unhappy path planned: oversize/overcount/wrong-mime/mime-mismatch (T1+T2+T5); non-vision model attach+paste (T2); zero-attachments backward compat (T1); apiKey-leak guard (T1); log-redaction guard (T5).
5. Target Files verified against live tree (aiChatPanel.ts 2110 lines, aiChatPanelMain.ts 1254 lines, aiChatPanelMessages.ts 247 lines, styles.css ~1500 lines all read); new test files marked (new).
6. Verification commands are real scripts: `npx vitest run` + `npm run typecheck` (no lint script — stated explicitly per cycle AA pattern).
7. No same-wave file overlap: wave 1 = T1(.ts host + .ts messages) / T3(styles.css + new test) / T5(new test only); wave 2 = T2(webview main + new test). T2 consumes T1's `send.attachments` payload + `init.visionCapable` field; T3 consumes T2's class names.
8. No task depends on symbols no earlier task creates: T2 consumes exactly T1 §Interfaces (`attachments`, `visionCapable`); T3 consumes exactly T2 DOM ids/classes.
9. Test quality: each task ≥1 happy + ≥2 edges of distinct kinds (oversize/overcount/mime/paste/vision-gating/apiKey-grep/log-redaction — enumerated in each table).
10. Every Expected is concrete (exact post shape, exact CSS declaration, exact sentinel string, exact call count).
11. Regression tests: T1 #12 extends cycle-AA privacy sentinel (attachments variant); T2 #14 pins Enter=send still works with attachments; T3 #9 pins body class height chain holds; T5 #3 pins log redaction. T1 #1 / T2 #3 are RED against current code (no attachments payload + no visionCapable field).
12. Tests cannot pass against an empty implementation: each asserts real behavior (posted messages, DOM state, MIME rejection, log string absence, vision flag presence).

Fixed during audit: T4 (privacy regression task) merged into T1 because cycle-AA TASK-004 lock is the standing invariant; this cycle extends its suite in T1's task file with the explicit "attachments variant" test row. Wave count drops 5→4 tasks; review load drops correspondingly.

Known gaps: (a) real browser probe of thumbnail strip in CI is impractical — CSS contract test + jsdom render assertion cover the surface. (c) Drag-and-drop image files is intentionally out-of-scope (CSP safer to use OS picker + paste only). (d) Image EXIF strip is out-of-scope (privacy stance: user pushed, model receives).

## Plan Review Log

### Round 1 — 2026-08-28 — unic-code (orchestrator-applied; reviewer in R1-R4 cycle replaces this self-audit)
Status: drafted.
PLANNER_MODEL disclosed above (unic-code). Reviewer in the regular cycle (R1-R4, parallel `code-reviewer` agents at unic-smart tier) is the gate; this self-audit is the orchestrator's pre-cycle check.

NOTES: Scope matches queue spec exactly (reqs 3-5; reqs 1-2 shipped in cycle AA). Caps and non-vision policy chosen via P0 ask (4 questions batched, all recommended chosen). No existing pins retire (additive contract). Wave plan file-disjoint (T1+T3+T5 in wave 1, T2 in wave 2). Build path reuses cycle AA patterns (esbuild webview test, single `buildMessages` funnel, additive `attachments?` field).