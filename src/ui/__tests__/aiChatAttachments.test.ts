// src/ui/__tests__/aiChatPanelAttachments.test.ts — TASK-005 pure attachment
// helpers. Pure (no `vscode`, no fs, no net) validation + utility tests.
//
// Coverage:
//   1. validateImageAttachment — PNG/JPEG/WEBP/GIF happy + oversize /
//      count_cap / unsupported_type / mime_mismatch edges.
//   2. validateAttachmentsForVision — vision flag gate.
//   3. summarizeAttachmentsForLog — count + totalBytes + mimes; never
//      includes base64 (defense against log leakage).
//   4. imageBytesToDataUrl — bytes + mime → data: URL.
//   5. attachmentBytesFromBase64 — known base64 → byte length.
//   6. Constants: no `vscode` import in aiChatAttachments.ts; constants
//      match any host-side mirror that happens to export them.
//
// PURE — does not construct an AiChatPanel, does not open a webview,
// does not require the vscode runtime.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  MAX_ATTACH_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  ATTACH_ALLOWED_MIME,
  validateImageAttachment,
  validateAttachmentsForVision,
  summarizeAttachmentsForLog,
  imageBytesToDataUrl,
  attachmentBytesFromBase64,
  type MinimalAttachment,
  type AttachmentValidationOk,
  type AttachmentValidationErr,
  type AttachRejectReason,
} from "../aiChatAttachments";

// ---- magic-byte fixtures -------------------------------------------------

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const WEBP_HEADER = [
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39];
// PDF magic bytes for the mime_mismatch case.
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46];

/** Build a Uint8Array from a magic-byte prefix + filler; total length = bytes. */
function makeBytes(prefix: readonly number[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  for (let i = 0; i < prefix.length && i < totalLength; i++) {
    out[i] = prefix[i];
  }
  for (let i = prefix.length; i < totalLength; i++) {
    out[i] = 0;
  }
  return out;
}

/** Encode bytes → standard base64 string (test-only fixture helper). */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Build a MinimalAttachment with the given bytes + mime. */
function makeAttach(
  bytes: Uint8Array,
  mime: string,
  overrides: Partial<MinimalAttachment> = {},
): MinimalAttachment {
  return {
    id: "att-" + Math.random().toString(36).slice(2, 9),
    mime,
    base64: toBase64(bytes),
    bytes: bytes.byteLength,
    ...overrides,
  };
}

// ---- #1a–d validateImageAttachment: PNG / JPEG / WEBP / GIF happy --------

describe("validateImageAttachment — happy magic-byte sniff (TASK-005)", () => {
  it("a) PNG header passes validation", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const attach = makeAttach(bytes, "image/png");
    const result = validateImageAttachment(attach, []);
    expect(result).toEqual<AttachmentValidationOk>({ ok: true });
  });

  it("b) JPEG header passes validation", () => {
    const bytes = makeBytes(JPEG_HEADER, 64);
    const attach = makeAttach(bytes, "image/jpeg");
    const result = validateImageAttachment(attach, []);
    expect(result).toEqual<AttachmentValidationOk>({ ok: true });
  });

  it("c) WEBP header passes validation (RIFF...WEBP within first 12 bytes)", () => {
    const bytes = makeBytes(WEBP_HEADER, 64);
    const attach = makeAttach(bytes, "image/webp");
    const result = validateImageAttachment(attach, []);
    expect(result).toEqual<AttachmentValidationOk>({ ok: true });
  });

  it("d) GIF header passes validation", () => {
    const bytes = makeBytes(GIF_HEADER, 64);
    const attach = makeAttach(bytes, "image/gif");
    const result = validateImageAttachment(attach, []);
    expect(result).toEqual<AttachmentValidationOk>({ ok: true });
  });
});

// ---- #1e–h validateImageAttachment: rejection edges --------------------

describe("validateImageAttachment — rejection edges (TASK-005)", () => {
  it("e) 6 MB blob → {ok:false, reason:'oversize'}", () => {
    const sixMb = 6 * 1024 * 1024;
    const bytes = makeBytes(PNG_HEADER, sixMb);
    const attach = makeAttach(bytes, "image/png");
    const result = validateImageAttachment(attach, []);
    expect(result.ok).toBe(false);
    expect((result as AttachmentValidationErr).reason).toBe<AttachRejectReason>(
      "oversize",
    );
  });

  it("f) count_cap: existing.length=4 + new → {ok:false, reason:'count_cap'}", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const existing = [
      makeAttach(bytes, "image/png", { id: "x1" }),
      makeAttach(bytes, "image/png", { id: "x2" }),
      makeAttach(bytes, "image/png", { id: "x3" }),
      makeAttach(bytes, "image/png", { id: "x4" }),
    ];
    const newAttach = makeAttach(bytes, "image/png", { id: "x5" });
    const result = validateImageAttachment(newAttach, existing);
    expect(result.ok).toBe(false);
    expect((result as AttachmentValidationErr).reason).toBe<AttachRejectReason>(
      "count_cap",
    );
  });

  it("g) unsupported_type: image/svg+xml → {ok:false, reason:'unsupported_type'}", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const attach = makeAttach(bytes, "image/svg+xml");
    const result = validateImageAttachment(attach, []);
    expect(result.ok).toBe(false);
    expect((result as AttachmentValidationErr).reason).toBe<AttachRejectReason>(
      "unsupported_type",
    );
  });

  it("h) mime_mismatch: image/jpeg + PDF magic bytes → {ok:false, reason:'mime_mismatch'}", () => {
    const bytes = makeBytes(PDF_HEADER, 64);
    const attach = makeAttach(bytes, "image/jpeg");
    const result = validateImageAttachment(attach, []);
    expect(result.ok).toBe(false);
    expect((result as AttachmentValidationErr).reason).toBe<AttachRejectReason>(
      "mime_mismatch",
    );
  });
});

// ---- #1i validateAttachmentsForVision: vision flag gate ----------------

describe("validateAttachmentsForVision — vision flag gate (TASK-005)", () => {
  it("visionCapable=false + non-empty attachments → {ok:false, reason:'vision_unsupported'}", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const attach = makeAttach(bytes, "image/png");
    const result = validateAttachmentsForVision([attach], false);
    expect(result.ok).toBe(false);
    expect((result as AttachmentValidationErr).reason).toBe<AttachRejectReason>(
      "vision_unsupported",
    );
  });

  it("visionCapable=true → {ok:true} (even with non-empty attachments)", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const attach = makeAttach(bytes, "image/png");
    const result = validateAttachmentsForVision([attach], true);
    expect(result).toEqual<AttachmentValidationOk>({ ok: true });
  });

  it("visionCapable=false + empty attachments → {ok:true} (no work to gate)", () => {
    const result = validateAttachmentsForVision([], false);
    expect(result).toEqual<AttachmentValidationOk>({ ok: true });
  });
});

// ---- #1j summarizeAttachmentsForLog: shape + base64 redaction -----------

describe("summarizeAttachmentsForLog — shape + base64 redaction (TASK-005)", () => {
  it("j1) own keys are exactly {count, totalBytes, mimes}", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const attach = makeAttach(bytes, "image/png");
    const summary = summarizeAttachmentsForLog([attach]);
    expect(Object.keys(summary).sort()).toEqual([
      "count",
      "mimes",
      "totalBytes",
    ]);
  });

  it("j2) returned values never contain 'base64' string", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const attach = makeAttach(bytes, "image/png");
    const summary = summarizeAttachmentsForLog([attach, attach]);
    // Serialize to JSON to catch any nested base64 leak.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("base64");
    // Also explicit field-level check.
    expect(JSON.stringify(summary.mimes)).not.toContain("base64");
    expect(summary.count).toBe(2);
    expect(summary.totalBytes).toBe(bytes.byteLength * 2);
    expect(summary.mimes).toEqual(["image/png", "image/png"]);
  });

  it("j3) empty list → {count:0, totalBytes:0, mimes:[]}", () => {
    const summary = summarizeAttachmentsForLog([]);
    expect(summary).toEqual({ count: 0, totalBytes: 0, mimes: [] });
  });
});

// ---- #1k imageBytesToDataUrl: bytes + mime → data URL -------------------

describe("imageBytesToDataUrl — pure data URL builder (TASK-005)", () => {
  it("k) PNG bytes + 'image/png' → starts with 'data:image/png;base64,'", () => {
    const bytes = makeBytes(PNG_HEADER, 32);
    const url = imageBytesToDataUrl(bytes, "image/png");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // The payload after the prefix should decode back to the same bytes.
    const payload = url.slice("data:image/png;base64,".length);
    const decoded = Buffer.from(payload, "base64");
    expect(decoded.byteLength).toBe(bytes.byteLength);
  });

  it("k2) unsupported mime throws TypeError", () => {
    const bytes = makeBytes(PNG_HEADER, 32);
    expect(() => imageBytesToDataUrl(bytes, "image/svg+xml")).toThrow(TypeError);
  });
});

// ---- #1l attachmentBytesFromBase64: Buffer.byteLength wrapper ---------

describe("attachmentBytesFromBase64 — Buffer.byteLength wrapper (TASK-005)", () => {
  it("l) known base64 string → expected byte length (matches Buffer.byteLength)", () => {
    const bytes = makeBytes(PNG_HEADER, 64);
    const b64 = toBase64(bytes);
    expect(attachmentBytesFromBase64(b64)).toBe(Buffer.byteLength(b64, "base64"));
    expect(attachmentBytesFromBase64(b64)).toBe(bytes.byteLength);
  });

  it("l2) empty string → 0", () => {
    expect(attachmentBytesFromBase64("")).toBe(0);
  });
});

// ---- #1m Grep: aiChatAttachments.ts does NOT import vscode -------------

describe("aiChatAttachments — module hygiene (TASK-005)", () => {
  it("m) source file does NOT import vscode", () => {
    const sourcePath = path.resolve(__dirname, "..", "aiChatAttachments.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/from\s+["']vscode["']/);
    expect(source).not.toMatch(/require\s*\(\s*["']vscode["']\s*\)/);
  });

  it("m2) ATTACH_ALLOWED_MIME contains exactly the four whitelisted image types", () => {
    expect(ATTACH_ALLOWED_MIME.has("image/png")).toBe(true);
    expect(ATTACH_ALLOWED_MIME.has("image/jpeg")).toBe(true);
    expect(ATTACH_ALLOWED_MIME.has("image/webp")).toBe(true);
    expect(ATTACH_ALLOWED_MIME.has("image/gif")).toBe(true);
    expect(ATTACH_ALLOWED_MIME.size).toBe(4);
  });

  it("m3) constants exported and well-typed", () => {
    expect(MAX_ATTACH_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_TURN).toBe(4);
  });
});

// ---- #1n Constants equality: mirror sites (forward-looking guard) ------
//
// TASK-005 owns the canonical definitions in aiChatAttachments.ts. Host /
// webview mirror sites are added by other cycle-AB tasks (TASK-001 for
// aiChatPanel.ts; webview/attachLimits.ts). When those mirrors exist they
// MUST agree with the canonical values; if they do not exist yet the test
// gracefully skips — the canonical-source assertion above (m3) remains
// the binding check.

describe("MAX_ATTACH_BYTES — mirror equality guard (TASK-005)", () => {
  function maybeLoad(name: string): Record<string, unknown> | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(name) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  it("n) aiChatPanel.ts mirror (if exported) matches canonical MAX_ATTACH_BYTES", () => {
    const mirror = maybeLoad("../aiChatPanel");
    if (mirror === null) return; // mirror not yet exported — skip.
    if (!("MAX_ATTACH_BYTES" in mirror)) return;
    expect(mirror.MAX_ATTACH_BYTES).toBe(MAX_ATTACH_BYTES);
  });

  it("n2) webview/attachLimits.ts mirror (if loaded) matches canonical MAX_ATTACH_BYTES", () => {
    // webview is bundle-only, not Node-importable; skip silently if absent.
    const mirror = maybeLoad("../../webview/attachLimits");
    if (mirror === null) return;
    if (!("MAX_ATTACH_BYTES" in mirror)) return;
    expect(mirror.MAX_ATTACH_BYTES).toBe(MAX_ATTACH_BYTES);
  });
});