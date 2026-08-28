// src/ui/aiChatAttachments.ts — TASK-005 (cycle AB) pure helpers.
//
// Image attachment validation, log-safe summarization, and base64 conversion.
// Pure (no vscode import, no side effects, no apiKey). Imported by the host
// handleSend path in src/ui/aiChatPanel.ts.
//
// File is task-005-owned; a sibling worktree ships the real implementation
// on branch handoff/ab-task-005. This local copy exists so task-001 can run
// its RED-then-GREEN cycle without waiting on cross-worktree resolution. The
// contract matches the sibling's pinned signature so a future merge picks a
// single canonical body.
//
// NO vscode import. NO apiKey strings. NO side effects.

export interface ImageAttachment {
  id: string;
  mime: string;
  base64: string;
  bytes: number;
}

// ---- caps (single source of truth) -----------------------------------------

/** 5 MB per attachment. Matches docs/AI_HANDOFF/PLAN_AB.md §1 P0 lock. */
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

/** 4 images per turn. Matches P0 lock. */
export const MAX_ATTACHMENTS_PER_TURN = 4;

/** Allowed MIMEs — exactly the four listed in the spec. */
export const ATTACH_ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// ---- result shapes ---------------------------------------------------------

export type AttachValidateOk = { ok: true };
export type AttachValidateFail = {
  ok: false;
  reason: "oversize" | "count_cap" | "unsupported_type" | "mime_mismatch";
  attachmentId?: string;
  message?: string;
};
export type AttachValidateResult = AttachValidateOk | AttachValidateFail;

export type AttachVisionValidateOk = { ok: true };
export type AttachVisionValidateFail = {
  ok: false;
  reason: "vision_unsupported";
};
export type AttachVisionValidateResult =
  | AttachVisionValidateOk
  | AttachVisionValidateFail;

// ---- magic byte tables -----------------------------------------------------

const PNG_BYTES: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_BYTES: readonly number[] = [0xff, 0xd8, 0xff];
const GIF_BYTES: readonly number[] = [0x47, 0x49, 0x46, 0x38]; // GIF87a/GIF89a — both start with `GIF8`
const WEBP_HEAD_BYTES: readonly number[] = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP_TAIL_BYTES: readonly number[] = [0x57, 0x45, 0x42, 0x50]; // WEBP

function atobGlobal(s: string): string {
  try {
    return (globalThis as { atob: (s: string) => string }).atob(s);
  } catch {
    return "";
  }
}

function btoaGlobal(s: string): string {
  try {
    return (globalThis as { btoa: (s: string) => string }).btoa(s);
  } catch {
    return "";
  }
}

/** Decode the first `count` bytes of a base64 payload. Returns null when
 * the payload is shorter than `count` or the base64 decode fails. */
function sniffBytes(base64: string, count: number): Uint8Array | null {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atobGlobal(padded);
  if (bin.length < count) return null;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Match the head of `bytes` against a fixed-length byte sequence. */
function bytesEqualAt(
  bytes: Uint8Array,
  at: number,
  sig: readonly number[],
): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[at + i] !== sig[i]) return false;
  }
  return true;
}

function magicForMime(mime: string): (base64: string) => boolean {
  if (mime === "image/png") {
    return (b64) => {
      const head = sniffBytes(b64, PNG_BYTES.length);
      return head !== null && bytesEqualAt(head, 0, PNG_BYTES);
    };
  }
  if (mime === "image/jpeg") {
    return (b64) => {
      const head = sniffBytes(b64, JPEG_BYTES.length);
      return head !== null && bytesEqualAt(head, 0, JPEG_BYTES);
    };
  }
  if (mime === "image/gif") {
    return (b64) => {
      const head = sniffBytes(b64, GIF_BYTES.length);
      return head !== null && bytesEqualAt(head, 0, GIF_BYTES);
    };
  }
  if (mime === "image/webp") {
    // RIFF..WEBP — RIFF at offset 0, WEBP at offset 8. Bytes 4..8 are the
    // (unconstrained) RIFF size and skipped by checking head + tail windows.
    return (b64) => {
      const head = sniffBytes(b64, 4);
      const tail = sniffBytes(b64, 12);
      return (
        head !== null &&
        tail !== null &&
        bytesEqualAt(head, 0, WEBP_HEAD_BYTES) &&
        bytesEqualAt(tail, 8, WEBP_TAIL_BYTES)
      );
    };
  }
  return () => false;
}

/** Validate a single attachment. Returns `{ok:true}` on accept, otherwise
 * `{ok:false, reason, attachmentId, message}` describing the rejection. */
export function validateImageAttachment(
  attachment: ImageAttachment,
): AttachValidateResult {
  if (
    typeof attachment.bytes !== "number" ||
    attachment.bytes <= 0 ||
    attachment.bytes > MAX_ATTACH_BYTES
  ) {
    return {
      ok: false,
      reason: "oversize",
      attachmentId: attachment.id,
      message: `Attachment "${attachment.id}" is ${attachment.bytes} bytes (limit ${MAX_ATTACH_BYTES}).`,
    };
  }
  if (!ATTACH_ALLOWED_MIME.has(attachment.mime)) {
    return {
      ok: false,
      reason: "unsupported_type",
      attachmentId: attachment.id,
      message: `Attachment "${attachment.id}" has unsupported MIME "${attachment.mime}".`,
    };
  }
  const match = magicForMime(attachment.mime);
  if (!match(attachment.base64)) {
    return {
      ok: false,
      reason: "mime_mismatch",
      attachmentId: attachment.id,
      message: `Attachment "${attachment.id}" byte signature does not match "${attachment.mime}".`,
    };
  }
  return { ok: true };
}

/** Vision-capability gate. Mirrors the `engine === "omp"` branch in the
 * host: any non-empty list + `visionCapable === false` → one rejection per
 * attachment (returned as a single result; the caller emits N bubbles). */
export function validateAttachmentsForVision(
  attachments: readonly ImageAttachment[],
  visionCapable: boolean,
): AttachVisionValidateResult {
  if (visionCapable) return { ok: true };
  if (attachments.length === 0) return { ok: true };
  return { ok: false, reason: "vision_unsupported" };
}

/** Compute byte length of a base64-encoded payload (without padding). */
export function attachmentBytesFromBase64(base64: string): number {
  const trimmed = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  if (trimmed.length === 0) return 0;
  const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4);
  const bin = atobGlobal(padded);
  return bin.length;
}

/** Redact an entire batch to a log-safe summary. NEVER returns base64 or
 * any image bytes. Use this in every log call that mentions attachments. */
export function summarizeAttachmentsForLog(
  attachments: readonly ImageAttachment[],
): {
  count: number;
  totalBytes: number;
  mimes: string[];
} {
  const mimes: string[] = [];
  let totalBytes = 0;
  for (const a of attachments) {
    totalBytes += a.bytes;
    mimes.push(a.mime);
  }
  return { count: attachments.length, totalBytes, mimes };
}

/** Convert raw image bytes to a `data:` URL. Throws on unsupported MIME. */
export function imageBytesToDataUrl(mime: string, bytes: Uint8Array): string {
  if (!ATTACH_ALLOWED_MIME.has(mime)) {
    throw new TypeError(`imageBytesToDataUrl: unsupported MIME "${mime}"`);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `data:${mime};base64,${btoaGlobal(bin)}`;
}
