# TASK-001 (cycle AB) — Host message contract + buildMessages image-parts path

Wave: 1 (parallel with TASK-003 styles + TASK-005 pure helpers).
Owner files: `src/ui/aiChatPanelMessages.ts` + `src/ui/aiChatPanel.ts` + new test file.
Constraint: no same-wave file overlap (T-003 owns `webview/styles.css`; T-005 owns a new test only).

## §Spec

### Wire contract extensions (additive — backward compatible)

1. `AiChatPanelInit` (host → webview) gains `visionCapable: boolean`:
   - True iff the active AI role's `models.<role>.vision === true` at panel-ready time.
   - Source: `AiConfigStore.loadSettings()` → `settings.models[activeRole].vision`.
   - The webview reads this to (a) enable/disable the attach button and (b) accept/reject paste-image.

2. `AiChatPanelWebviewMessage["send"]` gains `attachments?: ImageAttachment[]`:
   - `ImageAttachment { id: string; mime: string; base64: string; bytes: number; }`
   - When present and length > 0, the host forwards them as `ChatContentPart[]` (image_url parts with `dataUrl`) attached to the user message via the new `userContentOverride` hook.
   - When absent OR empty array, legacy text-only path runs (cycle AA baseline).

3. New host → webview message kind `AiChatPanelAttachError`:
   - `{ type: "attach_error"; id: string; reason: "oversize"|"count_cap"|"unsupported_type"|"mime_mismatch"|"vision_unsupported"; message: string }`
   - Fires per-attachment rejection so the webview can name the offending file in its warning bubble.

### Host validation (in `handleSend`)

Before invoking `runAgent`:
- Count: `attachments.length > MAX_ATTACHMENTS_PER_TURN` (4) → emit one `attach_error` per overflowing item with `reason:"count_cap"`, drop them, proceed with the kept prefix. If ALL drop → return early (no runAgent call).
- Per-item bytes: `attachment.bytes > MAX_ATTACH_BYTES` (5 * 1024 * 1024) → emit `attach_error` with `reason:"oversize"`, drop.
- Per-item MIME: not in `{image/png, image/jpeg, image/webp, image/gif}` → emit `attach_error` with `reason:"unsupported_type"`, drop.
- Per-item MIME sniff (magic bytes): decode the first 12 bytes of base64 and compare against expected magic.
  - PNG: `89 50 4E 47 0D 0A 1A 0A` → image/png
  - JPEG: `FF D8 FF` → image/jpeg
  - GIF: `47 49 46 38` (37|39) → image/gif
  - WEBP: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` → image/webp
  - Mismatch (e.g. `25 50 44 46` = `%PDF`) → emit `attach_error` with `reason:"mime_mismatch"`, drop.
- Vision gating: if `currentRole.vision === false` AND `attachments.length > 0` after the above passes → emit ONE `attach_error` with `reason:"vision_unsupported"` PER attachment, drop ALL attachments, proceed with text-only turn. (User can still send the text prompt; image bytes are explicitly rejected, not silently dropped.)

### buildMessages image-parts path (the privacy-critical bit)

Add optional parameter to `buildMessages`:
```ts
userContentOverride?: ChatContentPart[]
```
When present, the user message is constructed as:
```ts
{ role: "user", content: userContentOverride }
```
The system message (DDL-only context) is computed exactly as today. The history chain is untouched.

`buildMessages` MUST keep its cycle-AA signature, default arg, and zero-behavior change when `userContentOverride` is undefined. Existing privacy sentinel test (`aiChatPanelPrivacy.test.ts`) stays green; this cycle adds the "with attachments" extension row (TASK-001 acceptance #6 below).

### runBuiltinTurn / runAcpTurn changes

Both engines already call `buildMessages(... , userMsg)`. The new code path is:
1. Compute `attachments` from `handleSend(msg.attachments)`.
2. If non-empty, build `userContentOverride` from base64 → dataURL (`data:${mime};base64,${base64}`) wrapped in `ChatContentPart[]` with text + image_url parts.
3. Pass `userContentOverride` to `buildMessages`. Text-only turn continues to use the legacy path.

### Logging hygiene

`console.log` / `console.warn` MUST NEVER receive base64 bytes. A `summarizeAttachmentsForLog(attachments)` helper returns `{count, totalBytes, mimes:[…]}` — this is the only log shape allowed. Pure helper lives in `src/ui/aiChatAttachments.ts` (new file, task-005 actually owns the helper file; task-001 imports it).

## §Interfaces (downstream contract)

```ts
// src/ui/aiChatPanelMessages.ts — additive extensions
export interface ImageAttachment {
  id: string;
  mime: string;
  base64: string;
  bytes: number;
}
export interface AiChatPanelInit {
  type: "init";
  hasHistory: boolean;
  visionCapable: boolean; // NEW — task-001
}
export interface AiChatPanelAttachError {
  type: "attach_error";
  id: string;
  reason: "oversize" | "count_cap" | "unsupported_type" | "mime_mismatch" | "vision_unsupported";
  message: string;
}
// union AiChatPanelHostMessage gains AiChatPanelAttachError

// WebviewMessage.send extension (additive):
export interface AiChatPanelWebviewSend {
  type: "send";
  text: string;
  attachments?: ImageAttachment[]; // NEW — task-001
}
```

```ts
// src/ui/aiChatPanel.ts — new param on buildMessages
export async function buildMessages(
  factory: AdapterFactory,
  history: ChatMessage[],
  userMsg: ChatMessage,
  opts?: {
    contextBudgetChars?: number;
    contextTableLimit?: number;
    userContentOverride?: ChatContentPart[]; // NEW — task-001
  },
): Promise<ChatMessage[]>
```

```ts
// caps (export for tests + webview mirror)
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_ATTACHMENTS_PER_TURN = 4;
export const ATTACH_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
```

## §Verification Commands

```bash
cd .worktrees/task-001
npx vitest run src/ui/__tests__/aiChatPanelAttachments.test.ts
npx vitest run src/ui/__tests__/aiChatPanelPrivacy.test.ts
npm run typecheck
```

## §Acceptance Criteria

1. `handleSend({text, attachments:[…valid]})` forwards validated attachments via `userContentOverride` to `runAgent` (RED first against current code that has no `attachments` field, GREEN after).
2. `handleReady()` reads `loadSettings()` and posts `{type:"init", hasHistory, visionCapable}` matching the active role's vision flag.
3. `AiChatPanelAttachError` posted per rejected attachment with the named `reason` (oversize / count_cap / unsupported_type / mime_mismatch / vision_unsupported).
4. `buildMessages` with `userContentOverride` produces a user message carrying text + image_url parts; system message still DDL-only.
5. `buildMessages` without `userContentOverride` is byte-identical to cycle AA baseline (legacy call sites keep working).
6. Privacy sentinel test (cycle-AA `aiChatPanelPrivacy.test.ts`) extended: seed sentinel + 2 valid attachments → sentinel absent from system AND user parts; `runQuery` spy still 0.
7. `MAX_ATTACH_BYTES = 5 MB`, `MAX_ATTACHMENTS_PER_TURN = 4`, `ATTACH_ALLOWED_MIME` exactly the four MIMEs — exported and unit-tested.
8. No apiKey string appears anywhere in the new message shapes (grep test on the host file).
9. Image bytes NEVER enter the system prompt, the auto-context, or resume replay (TASK-001 regression row).
10. `summarizeAttachmentsForLog` is the ONLY function allowed to receive `attachments` for logging; all log call sites use it (static check).

## §Out of scope
- Webview UX (TASK-002)
- CSS (TASK-003)
- Pure helpers (TASK-005 — note: `summarizeAttachmentsForLog` is task-005, task-001 imports it)
