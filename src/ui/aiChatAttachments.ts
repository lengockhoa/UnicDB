// src/ui/aiChatAttachments.ts — TASK-005 pure attachment helpers.
//
// This module is deliberately pure:
//   - no `vscode` import
//   - no filesystem access
//   - no network access
//
// It owns the canonical constants + validation + small data-URL helpers
// for image attachments used by the AI chat composer. Host and webview
// layers are expected to consume these helpers (re-exporting or wrapping
// them), never to define parallel constants.
//
// Exports:
//   - MAX_ATTACH_BYTES, MAX_ATTACHMENTS_PER_TURN, ATTACH_ALLOWED_MIME
//   - AttachRejectReason union
//   - AttachmentValidationOk / AttachmentValidationErr discriminated union
//   - MinimalAttachment interface
//   - validateImageAttachment(input, existing)
//   - validateAttachmentsForVision(attachments, visionCapable)
//   - summarizeAttachmentsForLog(attachments)
//   - imageBytesToDataUrl(bytes, mime)
//   - attachmentBytesFromBase64(base64)
//
// Magic-byte table is local to this file (kept in sync with §3 of
// PLAN_AB and the queue spec req 3-5). Twelve bytes covers every format
// we sniff — WEBP needs the WEBP marker to appear within bytes 8..11.

/** Hard cap on bytes per single attachment (5 MB). */
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

/** Hard cap on attachments per chat turn. */
export const MAX_ATTACHMENTS_PER_TURN = 4;

/** Whitelisted MIME types for image attachments. */
export const ATTACH_ALLOWED_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// ---- Reject reason + result unions --------------------------------------

export type AttachRejectReason =
  | "oversize"
  | "count_cap"
  | "unsupported_type"
  | "mime_mismatch"
  | "vision_unsupported";

export interface AttachmentValidationOk {
  ok: true;
}

export interface AttachmentValidationErr {
  ok: false;
  reason: AttachRejectReason;
  attachmentId?: string;
}

export type AttachmentValidationResult =
  | AttachmentValidationOk
  | AttachmentValidationErr;

/** Minimal shape needed to validate + summarize an attachment. The host
 * owns the full `ImageAttachment` type; helpers below only require the
 * four fields used in validation / logging so the same helpers work from
 * either side of the webview/host wire. */
export interface MinimalAttachment {
  id: string;
  mime: string;
  base64: string;
  bytes: number;
}

// ---- Magic-byte table --------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_WEBP = [0x57, 0x45, 0x42, 0x50];

/** Decode the first 12 bytes of a base64 attachment. We never need more
 * than 12 bytes for any whitelisted format (WEBP needs the WEBP marker
 * within bytes 8..11). Throws on malformed base64 so the caller surfaces
 * a structured reject reason. */
function sniffFirstBytes(base64: string): Uint8Array {
  // Buffer.from tolerates whitespace and missing padding.
  const full = Buffer.from(base64, "base64");
  return new Uint8Array(full.subarray(0, 12));
}

/** Returns true when the first `prefix.length` bytes of `bytes` match the
 * given magic prefix. */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** WEBP signature: RIFF at bytes 0..3 AND WEBP at bytes 8..11. The four
 * bytes between (4..7) are the file size (little-endian) — they do NOT
 * participate in the magic-byte check. */
function isWebp(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, WEBP_RIFF)) return false;
  // Offset 8 (RIFF 4 + size 4) is where the WEBP marker lives.
  if (bytes.length < 8 + WEBP_WEBP.length) return false;
  for (let i = 0; i < WEBP_WEBP.length; i++) {
    if (bytes[8 + i] !== WEBP_WEBP[i]) return false;
  }
  return true;
}

/** Magic-byte sniff → matches the declared MIME. Returns true for any
 * valid combination; false on mismatch. */
function magicMatchesMime(bytes: Uint8Array, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(bytes, PNG_MAGIC);
    case "image/jpeg":
      return startsWith(bytes, JPEG_MAGIC);
    case "image/gif":
      return startsWith(bytes, GIF_MAGIC);
    case "image/webp":
      return isWebp(bytes);
    default:
      return false;
  }
}

// ---- validateImageAttachment -------------------------------------------

/** Validate a single candidate attachment against the per-turn caps and
 * the magic-byte whitelist. Pure — does not mutate the input or any
 * `existing` array. The order of checks is: count_cap → oversize →
 * unsupported_type → mime_mismatch. */
export function validateImageAttachment(
  input: MinimalAttachment,
  existing: readonly MinimalAttachment[],
): AttachmentValidationResult {
  if (existing.length >= MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, reason: "count_cap", attachmentId: input.id };
  }
  if (input.bytes > MAX_ATTACH_BYTES) {
    return { ok: false, reason: "oversize", attachmentId: input.id };
  }
  if (!ATTACH_ALLOWED_MIME.has(input.mime)) {
    return { ok: false, reason: "unsupported_type", attachmentId: input.id };
  }
  let head: Uint8Array;
  try {
    head = sniffFirstBytes(input.base64);
  } catch {
    return { ok: false, reason: "mime_mismatch", attachmentId: input.id };
  }
  if (!magicMatchesMime(head, input.mime)) {
    return { ok: false, reason: "mime_mismatch", attachmentId: input.id };
  }
  return { ok: true };
}

// ---- validateAttachmentsForVision --------------------------------------

/** Gate the whole turn on the active model's vision flag. Pure. Empty
 * attachments always pass — nothing to gate. Non-empty + vision=false
 * surfaces a single `vision_unsupported` reject with no per-attachment
 * id (the gate applies to the turn, not to a single blob). */
export function validateAttachmentsForVision(
  attachments: readonly MinimalAttachment[],
  visionCapable: boolean,
): AttachmentValidationResult {
  if (!visionCapable && attachments.length > 0) {
    return { ok: false, reason: "vision_unsupported" };
  }
  return { ok: true };
}

// ---- summarizeAttachmentsForLog ----------------------------------------

/** Compact summary safe to log: count + total bytes + MIME list. NEVER
 * includes base64 bytes (defense against log leakage / telemetry
 * redaction regressions). */
export function summarizeAttachmentsForLog(
  attachments: readonly MinimalAttachment[],
): { count: number; totalBytes: number; mimes: string[] } {
  let totalBytes = 0;
  const mimes: string[] = [];
  for (const a of attachments) {
    totalBytes += a.bytes;
    mimes.push(a.mime);
  }
  return { count: attachments.length, totalBytes, mimes };
}

// ---- imageBytesToDataUrl ----------------------------------------------

/** Build a `data:<mime>;base64,<payload>` URL from raw bytes. Pure —
 * no Buffer round-trip; uses `btoa` over a binary string so the result
 * is reproducible in any modern runtime. Throws TypeError if `mime` is
 * not in the allowed set. */
export function imageBytesToDataUrl(
  bytes: Uint8Array,
  mime: string,
): string {
  if (!ATTACH_ALLOWED_MIME.has(mime)) {
    throw new TypeError(
      `imageBytesToDataUrl: unsupported mime '${mime}'; allowed: ${[
        ...ATTACH_ALLOWED_MIME,
      ].join(", ")}`,
    );
  }
  // Encode Uint8Array → binary string in chunks (btoa is O(n) and
  // very large strings can blow the call stack on some engines).
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return `data:${mime};base64,${b64}`;
}

// ---- attachmentBytesFromBase64 ----------------------------------------

/** Pure byte-length from a base64 string. Wraps `Buffer.byteLength`
 * with `encoding:'base64'` so callers don't need to know the encoding
 * is base64 (vs. the more common utf8 default). */
export function attachmentBytesFromBase64(base64: string): number {
  return Buffer.byteLength(base64, "base64");
}