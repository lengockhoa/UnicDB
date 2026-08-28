# TASK-005 (cycle AB) — Pure helpers for attachment validation + log redaction

Wave: 1 (parallel with TASK-001 host + TASK-003 CSS).
Owner files: `src/ui/aiChatAttachments.ts` (new) + new test file.
Constraint: no same-wave file overlap (T-001 owns .ts host modifications; T-003 owns CSS).

## §Spec

Pure, unit-testable helpers. NO `vscode` import. NO network. NO filesystem. All exported for use by TASK-001 and TASK-002 (webview mirror subset).

### `validateImageAttachment(input, existing): { ok: true } | { ok: false, reason, message }`

Pure function. Validates a single attachment against:
- `existing.length + 1 <= MAX_ATTACHMENTS_PER_TURN` (else `count_cap`).
- `input.bytes <= MAX_ATTACH_BYTES` (else `oversize`).
- `ATTACH_ALLOWED_MIME.has(input.mime)` (else `unsupported_type`).
- Magic-byte sniff matches declared mime (else `mime_mismatch`).

Returns a discriminated union. The host's `handleSend` loops over attachments, calling this once per item, accumulating the kept list + the dropped list (each drop fires `attach_error`).

### `validateAttachmentsForVision(attachments, visionCapable)`

If `visionCapable === false` and `attachments.length > 0`, returns `{ok: false, reason:"vision_unsupported", message:"Current model does not support images"}`. Else `{ok: true}`.

### `summarizeAttachmentsForLog(attachments)`

Returns `{count: number, totalBytes: number, mimes: string[]}`. Never includes base64. NEVER logs the returned object as a single concatenation with bytes — only count + names. Used at every log site that would otherwise dump `attachments`.

### `imageBytesToDataUrl(bytes, mime)`

Pure: `Uint8Array` + mime string → `data:${mime};base64,${base64}`. Throws `TypeError` if mime is not in `ATTACH_ALLOWED_MIME`. Used by TASK-001 host to build `ChatContentPart.image_url.url`.

### `attachmentBytesFromBase64(base64)`

Pure: base64 string → byte length (using `Buffer.byteLength(base64, "base64")`). The webview mirror computes bytes independently to cross-check the host's count.

## §Exports

```ts
// src/ui/aiChatAttachments.ts
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 4;
export const ATTACH_ALLOWED_MIME: ReadonlySet<string> = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
]);
export type AttachRejectReason =
  | "oversize" | "count_cap" | "unsupported_type"
  | "mime_mismatch" | "vision_unsupported";

export interface AttachmentValidationOk { ok: true }
export interface AttachmentValidationErr {
  ok: false;
  reason: AttachRejectReason;
  message: string;
}

export interface MinimalAttachment {
  id: string;
  mime: string;
  base64: string;
  bytes: number;
}

export function validateImageAttachment(
  input: MinimalAttachment,
  existing: readonly MinimalAttachment[],
): AttachmentValidationOk | AttachmentValidationErr;

export function validateAttachmentsForVision(
  attachments: readonly MinimalAttachment[],
  visionCapable: boolean,
): AttachmentValidationOk | AttachmentValidationErr;

export function summarizeAttachmentsForLog(
  attachments: readonly MinimalAttachment[],
): { count: number; totalBytes: number; mimes: string[] };

export function imageBytesToDataUrl(
  bytes: Uint8Array,
  mime: string,
): string;

export function attachmentBytesFromBase64(base64: string): number;
```

## §Verification Commands

```bash
cd .worktrees/task-005
npx vitest run src/ui/__tests__/aiChatPanelAttachments.test.ts
npm run typecheck
```

## §Acceptance Criteria

1. `validateImageAttachment` happy path: 1 valid PNG, 1 valid JPEG, 1 valid WEBP, 1 valid GIF → all pass.
2. Edge oversize: 6 MB blob → returns `{ok:false, reason:"oversize"}`.
3. Edge count cap: passing 5 attachments where 1 is being validated with 4 existing → `{ok:false, reason:"count_cap"}`.
4. Edge unsupported mime: `image/svg+xml` → `{ok:false, reason:"unsupported_type"}`.
5. Edge mime mismatch: `image/jpeg` declared + PDF magic bytes → `{ok:false, reason:"mime_mismatch"}`.
6. `validateAttachmentsForVision`: visionCapable=false + non-empty → `{ok:false, reason:"vision_unsupported"}`; visionCapable=true → `{ok:true}`.
7. `summarizeAttachmentsForLog`: never returns base64; returns `{count, totalBytes, mimes}` (test inspects the object's keys).
8. `imageBytesToDataUrl`: `Uint8Array([0x89,0x50,0x4E,…])` + `"image/png"` → `"data:image/png;base64,iVBORw0KGgo…"`.
9. `attachmentBytesFromBase64`: known base64 strings produce the right byte count (cross-check with `Buffer.byteLength`).
10. No `vscode` import in this file (grep test).
11. Constants exported match TASK-001 host's local copies and TASK-002 webview mirror exactly (test asserts equality by reading the import sites).

## §Out of scope
- Host wire handling (TASK-001)
- Webview DOM construction (TASK-002)
- CSS (TASK-003)

## Reviewer Verdict — R3 [TASK-005] (unic-smart)
- TASK: TASK-005
- VERDICT: APPROVED-WITH-MINOR
- VERIFICATION_RERUN: `npx vitest run src/ui/__tests__/aiChatAttachments.test.ts` → 23/23 pass; `npx vitest run src/ui/__tests__/aiChatPanelAttachments.test.ts` (spec §Verification) → 10/10 pass; `npm run typecheck` → exit 0. Hygiene grep: zero imports (no vscode/fs/net/http) in aiChatAttachments.ts. Constants (5MB/4-cap/4-mime Set), all 5 AttachRejectReason reasons, check order count_cap→oversize→unsupported_type→mime_mismatch, PNG-8B/JPEG-3B/GIF-4B-prefix/WEBP RIFF+marker@8-11 sniff, exact-keys `{count,totalBytes,mimes}`, and `imageBytesToDataUrl` TypeError throw all verified in source + tests. Cycle-AA intact: buildMessages(factory,history,userMsg) @ aiChatPanel.ts:556, CSP default-src 'none'/style-src/script-src @ aiChatPanel.ts:2212-2219.
- BLOCKING: none
- NOTES: (1) src/ui/__tests__/aiChatPanelAttachments.test.ts:106 imports `type { ImageAttachment }` from ../aiChatAttachments but no such export exists anywhere — latent only, because tsconfig excludes **/*.test.ts and vitest erases type imports; fix: import `MinimalAttachment` instead (TASK-001 territory, logged for owner). (2) Comment at aiChatAttachments.ts:74 "Throws on malformed base64" is inaccurate — Buffer.from never throws; the try/catch at :157 is dead but harmless.


## Executor Metadata (cycle AB)
- EXECUTOR_MODEL: unic-code
- EXECUTOR_TOOL: task agent (general-purpose)

## Reviewer Metadata (cycle AB)
- REVIEWER_MODEL: unic-smart
- REVIEWER_TOOL: code-reviewer (agent type)
