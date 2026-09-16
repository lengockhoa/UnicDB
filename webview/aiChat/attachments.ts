// webview/aiChat/attachments.ts — TASK-CHATV2-013
//
// The V2 image-attachment surface: the thumbnail strip above the text region,
// the early webview validation that warns before the host re-validates, the
// remove control, the inline amber rejection notices, and the EPHEMERAL payload
// lifecycle (base64 lives here and is released on a matching submit ack or an
// explicit remove/clear).
//
// CONTRACT / PRIVACY
// - Ephemeral state is exactly `{ id, mime, base64, bytes }`. base64 NEVER
//   reaches a DOM attribute, a data-* value, a URL query, a log, a trace or an
//   export. Thumbnails paint from a revocable object URL, never a data URL.
// - The webview warns EARLY (unsupported MIME, oversize, count cap, model
//   unavailable) using the shared constants from `src/ui/aiChatAttachments.ts`.
//   The host remains authoritative and re-validates MIME/magic/count/size/
//   model/engine; a webview warning is never a substitute for that.
// - Object URLs are revoked EXACTLY ONCE, on remove or destroy. A second revoke
//   for the same id is a no-op.
// - A host rejection of one image NEVER discards valid siblings or a text-only
//   request: notices are per-item and additive.
// - Adding to the NEXT draft is always allowed, including while a turn is busy.
//   This module never inspects turn phase.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import {
  ATTACH_ALLOWED_MIME,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACH_BYTES,
  type AttachRejectReason,
  type MinimalAttachment,
} from "../../src/ui/aiChatAttachments";
import { createChatIcon } from "./icons";

const ROOT_CLASS = "UnicDB-ai-chat-v2";

/** Marker attribute identifying the thumbnail strip. */
export const ATTACHMENT_STRIP_MARKER = "data-chat-attachment-strip";
/** Marker on one thumbnail. */
export const ATTACHMENT_THUMB_MARKER = "data-chat-attachment-thumb";
/** Marker on a thumbnail's remove control. */
export const ATTACHMENT_REMOVE_MARKER = "data-chat-attachment-remove";
/** Marker on one inline rejection notice. */
export const ATTACHMENT_NOTICE_MARKER = "data-chat-attach-notice";
/** Marker on the hidden file input. */
export const ATTACHMENT_INPUT_MARKER = "data-chat-attach-input";

/** Strip height ceiling in px (PLAN §3: context strip max 72px). */
export const THUMB_STRIP_MAX_PX = 72;
/** One thumbnail's edge in px. */
export const THUMB_SIZE_PX = 44;
/** Thumbnail corner radius in px. */
export const THUMB_RADIUS_PX = 6;
/** Remove-target edge in px. */
export const THUMB_REMOVE_SIZE_PX = 24;

/** `accept` attribute value for the hidden image input, from the shared set. */
export const ATTACH_IMAGE_ACCEPT = [...ATTACH_ALLOWED_MIME].join(",");

/** One early-rejection notice. `fileName` is hostile text rendered as text. */
export interface AttachmentNotice {
  readonly id: string;
  readonly fileName: string;
  readonly reason: AttachRejectReason;
  readonly message: string;
}

/** Exact, fixed reason copy. Never derived from raw input. */
export function attachmentRejectLabel(reason: AttachRejectReason): string {
  switch (reason) {
    case "oversize":
      return "too large";
    case "count_cap":
      return "attachment limit reached";
    case "unsupported_type":
      return "unsupported type";
    case "mime_mismatch":
      return "file contents do not match its type";
    case "vision_unsupported":
      return "current model unavailable";
    default:
      return "rejected";
  }
}

/** Build the user-facing notice line: file name + exact reason. */
export function attachmentNoticeMessage(
  fileName: string,
  reason: AttachRejectReason,
): string {
  return `${fileName}: ${attachmentRejectLabel(reason)}`;
}

/** A minimal File-like surface (browser `File`, or a test double). */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/** Result of decoding one file. `null` means "could not read". */
export interface DecodedFile {
  readonly base64: string;
  readonly mime: string;
  readonly bytes: number;
}

/** Injectable environment so the module is testable without a browser. */
export interface AttachmentEnvironment {
  /** Decode a File-like to base64. Default uses `FileReader` when present. */
  readonly readFile?: (file: FileLike) => Promise<DecodedFile | null>;
  /** Create an object URL for a Blob. Default uses `URL.createObjectURL`. */
  readonly createObjectUrl?: (blob: Blob) => string | null;
  /** Revoke an object URL. Default uses `URL.revokeObjectURL`. */
  readonly revokeObjectUrl?: (url: string) => void;
  /** Deterministic id factory for an ingest index. */
  readonly newId?: (index: number) => string;
}

/** Callbacks the strip reports. All are intent — never transport. */
export interface AttachmentCallbacks {
  /** One valid image was ingested and committed to the draft. */
  onAdd(attachment: MinimalAttachment): void;
  /** One attachment id was removed by the user. */
  onRemove(id: string): void;
  /** Early-rejection notices changed (additive; the caller renders/posts them). */
  onNotices?(notices: readonly AttachmentNotice[]): void;
}

export interface AttachmentControllerOptions {
  /** Element the strip + notices mount inside (the composer context lane). */
  readonly container: HTMLElement;
  readonly callbacks: AttachmentCallbacks;
  /** Whether the active engine+model can accept images at all. */
  readonly imageInput: boolean;
  readonly environment?: AttachmentEnvironment;
}

/** The live attachment controller handle. */
export interface AttachmentController {
  /** The strip element (empty and hidden while no attachments exist). */
  readonly strip: HTMLElement;
  /** The hidden file input, or null when `imageInput` is false. */
  readonly input: HTMLInputElement | null;
  /** Reconcile the visible strip against the store's attachment list. */
  setAttachments(attachments: readonly MinimalAttachment[]): void;
  /** Open the hidden image input. No-op when `imageInput` is false. */
  openFileInput(): void;
  /** Ingest File-like images through the shared validation pipeline. */
  ingestFiles(files: readonly FileLike[]): Promise<readonly AttachmentNotice[]>;
  /** Ingest raw bytes that did not come from a `File` (e.g. a paste blob). */
  ingestDecoded(
    fileName: string,
    mime: string,
    base64: string,
    bytes: number,
  ): AttachmentNotice | null;
  /** Remove exactly one id (revokes its object URL once). */
  remove(id: string): void;
  /** Remove every attachment (revokes each URL once). */
  clear(): void;
  /** Snapshot the ids that a submit frame carries. */
  markSubmitted(clientRequestId: string, ids: readonly string[]): void;
  /** Release the ephemeral payloads for a MATCHING submit ack. */
  acknowledgeSubmit(clientRequestId: string): boolean;
  /** Ephemeral payloads (id/mime/base64/bytes) for the current draft. */
  ephemeralPayloads(): readonly MinimalAttachment[];
  /** Current early-rejection notices. */
  notices(): readonly AttachmentNotice[];
  /** Drop every listener/node and revoke every object URL once. Idempotent. */
  destroy(): void;
}

/** A safe DOM attribute string: an id that can never inject a selector. */
function safeAttr(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "");
}

function decodeBase64(base64: string): Uint8Array {
  const binary =
    typeof atob === "function"
      ? atob(base64)
      : Buffer.from(base64, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Default FileReader-backed decoder. Returns null when FileReader is absent. */
async function defaultReadFile(file: FileLike): Promise<DecodedFile | null> {
  const globalReader = (globalThis as { FileReader?: new () => FileReader }).FileReader;
  if (typeof globalReader !== "function") return null;
  return await new Promise<DecodedFile | null>((resolve) => {
    try {
      const reader = new globalReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        if (comma < 0) {
          resolve(null);
          return;
        }
        const base64 = result.slice(comma + 1);
        resolve({ base64, mime: file.type, bytes: file.size });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file as unknown as Blob);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Mount the attachment strip + notices against `options.container`.
 *
 * The strip is empty (and `hidden`) until the first valid image arrives, so an
 * image-incapable engine shows nothing at all.
 */
export function createAttachmentController(
  options: AttachmentControllerOptions,
): AttachmentController {
  const { container, callbacks } = options;
  const env = options.environment ?? {};
  const createObjectUrl =
    env.createObjectUrl ??
    ((blob: Blob): string | null =>
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(blob)
        : null);
  const revokeObjectUrl =
    env.revokeObjectUrl ??
    ((url: string): void => {
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    });
  const readFile = env.readFile ?? defaultReadFile;

  let attachments: readonly MinimalAttachment[] = [];
  let currentNotices: readonly AttachmentNotice[] = [];
  let destroyed = false;
  let ingestCounter = 0;

  /** Ephemeral payloads, keyed by attachment id. */
  const payloads = new Map<string, MinimalAttachment>();
  /** Object URLs, keyed by attachment id. Revoked exactly once. */
  const urls = new Map<string, { url: string; revoked: boolean }>();
  /** Pending submit snapshots: clientRequestId → ids. */
  const pendingSubmits = new Map<string, readonly string[]>();

  // ---- DOM ---------------------------------------------------------------
  const strip = document.createElement("div");
  strip.className = `${ROOT_CLASS}-attachment-strip`;
  strip.setAttribute(ATTACHMENT_STRIP_MARKER, "1");
  strip.setAttribute("aria-label", "Draft images");
  strip.hidden = true;
  strip.style.setProperty("--UnicDB-thumb-strip-max", `${THUMB_STRIP_MAX_PX}px`);
  strip.style.setProperty("--UnicDB-thumb-size", `${THUMB_SIZE_PX}px`);
  strip.style.setProperty("--UnicDB-thumb-radius", `${THUMB_RADIUS_PX}px`);
  strip.style.setProperty("--UnicDB-thumb-remove", `${THUMB_REMOVE_SIZE_PX}px`);
  container.appendChild(strip);

  const noticeList = document.createElement("div");
  noticeList.className = `${ROOT_CLASS}-attachment-notices`;
  noticeList.setAttribute("role", "status");
  noticeList.setAttribute("aria-live", "polite");
  noticeList.hidden = true;
  container.appendChild(noticeList);

  /** The hidden file input exists ONLY when the capability allows images. */
  let input: HTMLInputElement | null = null;
  if (options.imageInput === true) {
    input = document.createElement("input");
    input.type = "file";
    input.accept = ATTACH_IMAGE_ACCEPT;
    input.multiple = true;
    input.hidden = true;
    input.setAttribute(ATTACHMENT_INPUT_MARKER, "1");
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    input.addEventListener("change", () => {
      const files: FileLike[] = [];
      const list = input?.files;
      if (list !== null && list !== undefined) {
        for (let i = 0; i < list.length; i++) {
          const f = list.item(i);
          if (f !== null) files.push(f);
        }
      }
      void controller.ingestFiles(files);
      if (input !== null) input.value = "";
    });
    container.appendChild(input);
  }

  // ---- Helpers -----------------------------------------------------------

  function revokeOnce(id: string): void {
    const entry = urls.get(id);
    if (entry === undefined || entry.revoked) return;
    entry.revoked = true;
    revokeObjectUrl(entry.url);
    urls.delete(id);
  }

  /** Object URL for a payload, created lazily and cached per id. */
  function objectUrlFor(id: string): string | null {
    const existing = urls.get(id);
    if (existing !== undefined) return existing.revoked ? null : existing.url;
    const payload = payloads.get(id);
    if (payload === undefined) return null;
    let blob: Blob;
    try {
      blob = new Blob([decodeBase64(payload.base64)], { type: payload.mime });
    } catch {
      return null;
    }
    const url = createObjectUrl(blob);
    if (url === null) return null;
    urls.set(id, { url, revoked: false });
    return url;
  }

  function pushNotice(notice: AttachmentNotice): void {
    currentNotices = [...currentNotices, notice];
    renderNotices();
    callbacks.onNotices?.(currentNotices);
  }

  function renderNotices(): void {
    noticeList.replaceChildren();
    if (currentNotices.length === 0) {
      noticeList.hidden = true;
      return;
    }
    noticeList.hidden = false;
    for (const notice of currentNotices) {
      const item = document.createElement("div");
      item.className = `${ROOT_CLASS}-attachment-notice`;
      item.setAttribute(ATTACHMENT_NOTICE_MARKER, "1");
      item.setAttribute("data-reason", notice.reason);
      // textContent only — a hostile file name can never become markup.
      item.textContent = notice.message;
      noticeList.appendChild(item);
    }
  }

  function renderStrip(): void {
    strip.replaceChildren();
    strip.hidden = attachments.length === 0;
    attachments.forEach((attachment, index) => {
      const thumb = document.createElement("div");
      thumb.className = `${ROOT_CLASS}-attachment-thumb`;
      thumb.setAttribute(ATTACHMENT_THUMB_MARKER, "1");
      thumb.dataset.attachmentId = safeAttr(attachment.id);

      const image = document.createElement("img");
      image.className = `${ROOT_CLASS}-attachment-thumb-image`;
      // Decorative: the remove control carries the accessible name. No data
      // URL and no base64 ever reaches this attribute.
      image.alt = "";
      image.width = THUMB_SIZE_PX;
      image.height = THUMB_SIZE_PX;
      const url = objectUrlFor(attachment.id);
      if (url !== null) image.src = url;
      thumb.appendChild(image);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = `${ROOT_CLASS}-attachment-thumb-remove`;
      remove.setAttribute(ATTACHMENT_REMOVE_MARKER, "1");
      const label = `Remove image ${index + 1}`;
      remove.title = label;
      remove.setAttribute("aria-label", label);
      const xIcon = createChatIcon("x", 16);
      remove.appendChild(xIcon);
      remove.addEventListener("click", () => controller.remove(attachment.id));
      thumb.appendChild(remove);

      strip.appendChild(thumb);
    });
  }

  /** Early webview validation — MIME + size + count only. Magic bytes and the
   * engine/model gate are the HOST's authoritative re-check. */
  function validateEarly(
    mime: string,
    bytes: number,
    acceptedSoFar: number,
  ): AttachRejectReason | null {
    if (options.imageInput !== true) return "vision_unsupported";
    if (attachments.length + acceptedSoFar >= MAX_ATTACHMENTS_PER_TURN) return "count_cap";
    if (bytes > MAX_ATTACH_BYTES) return "oversize";
    if (!ATTACH_ALLOWED_MIME.has(mime)) return "unsupported_type";
    return null;
  }

  function commit(attachment: MinimalAttachment): void {
    attachments = [...attachments, attachment];
    payloads.set(attachment.id, attachment);
    renderStrip();
    callbacks.onAdd(attachment);
  }

  const controller: AttachmentController = {
    strip,
    input,
    setAttachments(next: readonly MinimalAttachment[]): void {
      if (destroyed) return;
      const keep = new Set(next.map((a) => a.id));
      // Revoke + drop payloads for ids the store no longer carries.
      for (const id of [...payloads.keys()]) {
        if (!keep.has(id)) {
          revokeOnce(id);
          payloads.delete(id);
        }
      }
      for (const attachment of next) {
        if (!payloads.has(attachment.id)) payloads.set(attachment.id, attachment);
      }
      attachments = next;
      renderStrip();
    },
    openFileInput(): void {
      if (destroyed || input === null) return;
      input.click();
    },
    async ingestFiles(files: readonly FileLike[]): Promise<readonly AttachmentNotice[]> {
      if (destroyed) return Object.freeze([]);
      const added: AttachmentNotice[] = [];
      let acceptedSoFar = 0;
      for (const file of files) {
        const reject = validateEarly(file.type, file.size, acceptedSoFar);
        if (reject !== null) {
          const notice: AttachmentNotice = {
            id: env.newId?.(ingestCounter) ?? `img-${ingestCounter}`,
            fileName: file.name,
            reason: reject,
            message: attachmentNoticeMessage(file.name, reject),
          };
          ingestCounter += 1;
          pushNotice(notice);
          added.push(notice);
          continue;
        }
        const decoded = await readFile(file);
        if (decoded === null) {
          const notice: AttachmentNotice = {
            id: env.newId?.(ingestCounter) ?? `img-${ingestCounter}`,
            fileName: file.name,
            reason: "unsupported_type",
            message: attachmentNoticeMessage(file.name, "unsupported_type"),
          };
          ingestCounter += 1;
          pushNotice(notice);
          added.push(notice);
          continue;
        }
        const id = env.newId?.(ingestCounter) ?? `img-${ingestCounter}`;
        ingestCounter += 1;
        commit({
          id,
          mime: decoded.mime.length > 0 ? decoded.mime : file.type,
          base64: decoded.base64,
          bytes: decoded.bytes,
        });
        acceptedSoFar += 1;
      }
      return Object.freeze(added);
    },
    ingestDecoded(
      fileName: string,
      mime: string,
      base64: string,
      bytes: number,
    ): AttachmentNotice | null {
      if (destroyed) return null;
      const reject = validateEarly(mime, bytes, 0);
      if (reject !== null) {
        const notice: AttachmentNotice = {
          id: env.newId?.(ingestCounter) ?? `img-${ingestCounter}`,
          fileName,
          reason: reject,
          message: attachmentNoticeMessage(fileName, reject),
        };
        ingestCounter += 1;
        pushNotice(notice);
        return notice;
      }
      const id = env.newId?.(ingestCounter) ?? `img-${ingestCounter}`;
      ingestCounter += 1;
      commit({ id, mime, base64, bytes });
      return null;
    },
    remove(id: string): void {
      if (destroyed) return;
      if (!attachments.some((a) => a.id === id)) return;
      revokeOnce(id);
      payloads.delete(id);
      attachments = attachments.filter((a) => a.id !== id);
      renderStrip();
      callbacks.onRemove(id);
    },
    clear(): void {
      if (destroyed) return;
      for (const id of [...urls.keys()]) revokeOnce(id);
      payloads.clear();
      attachments = [];
      pendingSubmits.clear();
      renderStrip();
    },
    markSubmitted(clientRequestId: string, ids: readonly string[]): void {
      pendingSubmits.set(clientRequestId, [...ids]);
    },
    acknowledgeSubmit(clientRequestId: string): boolean {
      const ids = pendingSubmits.get(clientRequestId);
      if (ids === undefined) return false;
      pendingSubmits.delete(clientRequestId);
      for (const id of ids) {
        revokeOnce(id);
        payloads.delete(id);
      }
      return true;
    },
    ephemeralPayloads(): readonly MinimalAttachment[] {
      // ONLY ids with a live payload entry. Once a matching submit ack (or an
      // explicit remove/clear) has released an id, its base64 is GONE — the
      // store may still name it until the webview resets the draft, and this
      // method must never resurrect released bytes.
      const out: MinimalAttachment[] = [];
      for (const attachment of attachments) {
        const payload = payloads.get(attachment.id);
        if (payload !== undefined) out.push(payload);
      }
      return Object.freeze(out);
    },
    notices: () => currentNotices,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const id of [...urls.keys()]) revokeOnce(id);
      payloads.clear();
      pendingSubmits.clear();
      strip.remove();
      noticeList.remove();
      input?.remove();
      input = null;
    },
  };

  return controller;
}
