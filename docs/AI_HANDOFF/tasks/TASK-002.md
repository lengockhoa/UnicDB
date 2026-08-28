# TASK-002 (cycle AB) — Webview image attach + clipboard paste UX

Wave: 2 (depends on TASK-001 for `init.visionCapable` and `send.attachments`).
Owner files: `webview/aiChatPanelMain.ts` + new test file.
Constraint: no same-wave file overlap (this is the only wave-2 task).

## §Spec

### UI additions to the composer

1. **Attach button** (icon, left of the send button): renders only when `visionCapable === true`. When `false`, the button is rendered but with `disabled` attribute and tooltip "Current model does not support images".

2. **Hidden file input** (`<input type="file" accept="image/*" multiple>`) appended to `<body>` once. The attach button click opens it. The `change` event reads every file via `FileReader.readAsDataURL`, then runs the local-cap validator. Rejection → warning bubble without host send.

3. **Attachments strip** above the textarea (inside `.vsdb-chat-input`, before the textarea row):
   - Horizontal flex row, gap 8px, max-height 80px, scroll-x overflow.
   - One thumbnail per attachment: 56×56, object-fit cover, border-radius 6px.
   - Each thumbnail has a small remove button overlay (top-right, 16×16).
   - Empty strip removes the DOM node.

4. **Paste handler** on the textarea (`paste` event):
   - Iterate `e.clipboardData.items`.
   - For each item with `kind === "file"` and `type.startsWith("image/")`: read via `FileReader.readAsDataURL`, run through the same thumbnail pipeline as the attach button.
   - If `visionCapable === false`: do NOT add to the strip; instead render an amber `.vsdb-chat-attach-warning` inline bubble with the message: "Current model does not support images. Remove attachment to send text only."
   - Text paste (`kind === "string"`) is unaffected — let the browser default behavior insert the text.

### Send-with-attachments

When the user clicks Send:
- Build `attachments: ImageAttachment[]` from the current strip.
- Read every `dataUrl` and split into `{mime, base64, bytes = base64.length * 3/4}`. (Webview doesn't have a `File` here in the strip — strip keeps `dataUrl` + computed bytes.)
- Post `{type:"send", text, attachments}` to the host.
- Clear the strip locally.
- The host's `attach_error` reply drives the warning bubble.

When `attachments` are absent (legacy text-only), the payload is exactly `{type:"send", text}` — additive only.

### Webview defense

- FileReader errors (read failure) → drop that file with a console warning, do NOT post host.
- dataURL exceeds `MAX_ATTACH_BYTES` → reject locally with the same warning shape (avoid round trip). Cross-check: webview mirrors the cap.
- No `innerHTML` for any host text. Warning bubbles use `textContent` only.

### Mirror caps from host

The webview imports the constants from a small webview-safe module:
```ts
// webview/attachLimits.ts (no vscode import)
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 4;
export const ATTACH_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
```
Test asserts webview mirror matches host export values.

## §Interfaces (downstream contract)

TASK-001 owns the wire types. TASK-002 consumes:
- `AiChatPanelInit.visionCapable` — drives attach button enabled state.
- `AiChatPanelAttachError` — drives the warning bubble.
- `AiChatPanelWebviewSend.attachments` — outgoing payload.

TASK-003 (CSS) consumes the class names TASK-002 emits:
- `.vsdb-chat-attach-btn` — attach button.
- `.vsdb-chat-attachments` — strip container.
- `.vsdb-chat-thumb` — each thumbnail.
- `.vsdb-chat-thumb-remove` — remove button overlay.
- `.vsdb-chat-attach-warning` — warning bubble.

## §Verification Commands

```bash
cd .worktrees/task-002
npx vitest run src/ui/__tests__/aiChatPanelWebviewTask002.test.ts
npm run typecheck
```

## §Acceptance Criteria

1. Attach button click opens a hidden file picker (multiple, image/*); selected files appear as thumbnails in the strip (RED first — current code has no attach button).
2. Cmd/Ctrl+V an image inside the textarea → same thumbnail pipeline.
3. Each thumbnail has a working remove control that drops it from the strip.
4. Send with thumbnails → posted `{type:"send", text, attachments:[{id, mime, base64, bytes}]}` — base64 verified present, bytes field verified correct (test inspects the actual post).
5. `visionCapable=false` → attach button has `disabled` attribute + tooltip; paste-image rejected with warning bubble; text paste still works (regression-pins cycle AA keybind).
6. Legacy `send` payload (`attachments` absent) still works — cycle AA tests stay green.
7. FileReader errors degrade silently (no unhandled rejection, no host post).
8. Caps mirrored from host: `MAX_ATTACH_BYTES`, `MAX_ATTACHMENTS_PER_TURN`, `ATTACH_ALLOWED_MIME` — test asserts equality.
9. CSP-safe: no inline `on*=` handlers; addEventListener only.
10. Enter=send / Shift+Enter=newline behavior unchanged with attachments in the strip (cycle AA keybind regression).

## §Out of scope
- Host validation (TASK-001)
- CSS (TASK-003)
- Drag-and-drop file attach (intentional CSP scope cut)
