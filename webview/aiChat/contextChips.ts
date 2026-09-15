// webview/aiChat/contextChips.ts — TASK-CHATV2-011
//
// The context strip: one chip per structured `ContextRef`, a model-free
// preview popover, and the explicit changed/missing/forbidden resolution
// dialog. This module OWNS the chip DOM; it is a pure view and reports intent
// through callbacks — the controller remains the only transport.
//
// CONTRACT
// - Chip geometry: min 28px tall, 16px semantic icon, ellipsized label, a
//   status indicator and a 28px remove target. `title`/`aria-label` carry the
//   FULL detail (`contextStatusLabel` + ref.detail), so a truncated label is
//   never the only identity a user has.
// - Click requests a SAFE PREVIEW only. A preview is metadata: it is built
//   locally by `previewContextRef`, which never touches a host round trip and
//   never invokes an AI engine.
// - Every string is written with `textContent` (or an attribute set from a
//   string value — which the DOM does not parse as markup). Hostile labels and
//   paths can therefore never create an element, an attribute or a class.
// - Removal identifies ONE `ref.id`. Two chips with the same label are two
//   identities; removing one never touches the other.
// - A ref whose status is not `ready` demands an EXPLICIT choice before send:
//   Refresh / Keep snapshot (policy permitting) / Remove, and for
//   missing/forbidden Remove / Send without it. Nothing is auto-dropped.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import {
  contextResolutionChoices,
  contextStatusLabel,
  previewContextRef,
  type ContextRef,
  type ContextResolutionChoice,
} from "../../src/ui/aiChatContext";
import { createChatIcon } from "./icons";

/** Root class every selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

/** Stable id prefix for a chip, derived from a SANITIZED ref id. */
export const CONTEXT_CHIP_ID_PREFIX = `${ROOT_CLASS}-ctx-chip-`;

/** Marker attribute proving an element is a context chip. */
export const CONTEXT_CHIP_MARKER = "data-chat-context-chip";
/** Marker on the chip's remove control. */
export const CONTEXT_CHIP_REMOVE_MARKER = "data-chat-context-remove";
/** Marker on the chip's preview (body) control. */
export const CONTEXT_CHIP_PREVIEW_MARKER = "data-chat-context-preview";
/** Marker on the preview popover. */
export const CONTEXT_PREVIEW_MARKER = "data-chat-context-preview-popover";
/** Marker on the resolution dialog. */
export const CONTEXT_RESOLVE_MARKER = "data-chat-context-resolve";

/** Chip geometry contract (px). */
export const CONTEXT_CHIP_MIN_HEIGHT_PX = 28;
export const CONTEXT_CHIP_ICON_SIZE_PX = 16;
export const CONTEXT_CHIP_REMOVE_SIZE_PX = 28;

/** Callbacks the strip reports through. All are intent, never transport. */
export interface ContextChipCallbacks {
  /** A chip body was activated (click/Enter): show its safe preview. */
  onPreview(ref: ContextRef): void;
  /** A chip remove control was activated: remove exactly this id. */
  onRemove(refId: string): void;
  /** The user answered a blocked ref's resolution dialog. */
  onResolve(ref: ContextRef, choice: ContextResolutionChoice): void;
}

export interface ContextChipsOptions {
  /** Root the strip mounts inside (the composer's context lane). */
  readonly container: HTMLElement;
  readonly callbacks: ContextChipCallbacks;
  /** Sender for the preview popover — defaults to `container`. */
  readonly previewAnchor?: HTMLElement;
}

/** The strip handle the controller drives. */
export interface ContextChipStrip {
  /** Replace the rendered chips. Idempotent — same refs, same DOM shape. */
  render(refs: readonly ContextRef[]): void;
  /** Open the safe preview for one ref (no host call, no model call). */
  showPreview(ref: ContextRef): void;
  /** Close the preview popover if one is open. */
  closePreview(): void;
  /**
   * Open the resolution dialog for a blocked ref. Returns the ordered choices
   * the caller must present (empty for a `ready` ref, which needs no dialog).
   */
  openResolution(
    ref: ContextRef,
    policy: { readonly allowKeepSnapshot: boolean },
  ): readonly ContextResolutionChoice[];
  /** The ref id currently shown in the resolution dialog, or null. */
  resolvingRefId(): string | null;
  /** Detach every listener/node. Idempotent. */
  destroy(): void;
}

/**
 * A safe DOM id fragment: unbounded/hostile ids never reach `id=`. A short
 * deterministic hash suffix keeps two ids that sanitize to the same text
 * (`a/index.vue` vs `a-index-vue`) from colliding in the DOM.
 */
function safeIdFragment(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "");
  const base = cleaned.length > 0 ? cleaned : "ref";
  return `${base}-${hash.toString(36)}`;
}

/**
 * Build the full accessible name for a chip. It carries the STATUS and the
 * FULL detail, so the information is available even when the visible label is
 * ellipsized.
 */
export function contextChipAccessibleLabel(ref: ContextRef): string {
  return `${ref.displayToken} — ${contextStatusLabel(ref.status)} — ${ref.detail}`;
}

/** Build the preview popover's text lines (metadata only, never content). */
export function contextPreviewLines(ref: ContextRef): readonly string[] {
  const preview = previewContextRef(ref);
  if (preview === null) return Object.freeze([contextStatusLabel(ref.status)]);
  return preview.lines;
}

/**
 * Mount the context chip strip against `options.container`.
 *
 * The strip is EMPTY until the first `render`, and it never renders anything
 * beyond chips + the preview popover + the resolution dialog — the caller owns
 * the surrounding composer layout.
 */
export function createContextChipStrip(options: ContextChipsOptions): ContextChipStrip {
  const { container, callbacks } = options;
  const previewAnchor = options.previewAnchor ?? container;

  let refs: readonly ContextRef[] = [];
  let previewElement: HTMLElement | null = null;
  let resolveElement: HTMLElement | null = null;
  let resolvingRef: ContextRef | null = null;
  let destroyed = false;

  function chipIdFor(ref: ContextRef): string {
    return `${CONTEXT_CHIP_ID_PREFIX}${safeIdFragment(ref.id)}`;
  }

  function closePreview(): void {
    if (previewElement === null) return;
    const owner = previewElement.dataset.chatPreviewOwner;
    previewElement.remove();
    previewElement = null;
    if (owner !== undefined) {
      container
        .querySelector<HTMLElement>(`#${CSS_ESCAPE_ID(owner)}`)
        ?.setAttribute("aria-expanded", "false");
    }
  }

  /** Escape an id for a `querySelector` lookup (ids we wrote are safe, but the
   * helper keeps the lookup honest if that ever changes). */
  function CSS_ESCAPE_ID(id: string): string {
    return id.replace(/([^\w-])/g, "\\$1");
  }

  function renderPreview(ref: ContextRef): void {
    closePreview();
    const popover = document.createElement("div");
    popover.className = `${ROOT_CLASS}-context-preview`;
    popover.setAttribute(CONTEXT_PREVIEW_MARKER, "1");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `Context preview: ${ref.displayToken}`);
    popover.dataset.chatPreviewOwner = chipIdFor(ref);

    const title = document.createElement("div");
    title.className = `${ROOT_CLASS}-context-preview-title`;
    title.textContent = ref.label;
    popover.appendChild(title);

    const detail = document.createElement("div");
    detail.className = `${ROOT_CLASS}-context-preview-detail`;
    detail.textContent = ref.detail;
    popover.appendChild(detail);

    const list = document.createElement("ul");
    list.className = `${ROOT_CLASS}-context-preview-lines`;
    for (const line of contextPreviewLines(ref)) {
      const item = document.createElement("li");
      // textContent only — a hostile path can never become markup.
      item.textContent = line;
      list.appendChild(item);
    }
    popover.appendChild(list);

    const close = document.createElement("button");
    close.type = "button";
    close.className = `${ROOT_CLASS}-context-preview-close`;
    close.textContent = "Close";
    close.addEventListener("click", () => closePreview());
    popover.appendChild(close);

    previewAnchor.appendChild(popover);
    previewElement = popover;
    container.querySelector<HTMLElement>(`#${CSS_ESCAPE_ID(chipIdFor(ref))}`)?.setAttribute(
      "aria-expanded",
      "true",
    );
  }

  function closeResolution(): void {
    resolveElement?.remove();
    resolveElement = null;
    resolvingRef = null;
  }

  /** The choice → label mapping the dialog renders. */
  const CHOICE_LABELS: Readonly<Record<ContextResolutionChoice, string>> = Object.freeze({
    refresh: "Refresh",
    keep: "Keep snapshot",
    remove: "Remove",
    send_without: "Send without it",
  });

  function openResolution(
    ref: ContextRef,
    policy: { readonly allowKeepSnapshot: boolean },
  ): readonly ContextResolutionChoice[] {
    closeResolution();
    const choices = contextResolutionChoices(ref.status, policy);
    if (choices.length === 0) return choices;

    const dialog = document.createElement("div");
    dialog.className = `${ROOT_CLASS}-context-resolve`;
    dialog.setAttribute(CONTEXT_RESOLVE_MARKER, "1");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-label", `Resolve context: ${ref.displayToken}`);

    const heading = document.createElement("div");
    heading.className = `${ROOT_CLASS}-context-resolve-title`;
    heading.textContent = `${contextStatusLabel(ref.status)}: ${ref.label}`;
    dialog.appendChild(heading);

    const detail = document.createElement("div");
    detail.className = `${ROOT_CLASS}-context-resolve-detail`;
    detail.textContent = ref.detail;
    dialog.appendChild(detail);

    const actions = document.createElement("div");
    actions.className = `${ROOT_CLASS}-context-resolve-actions`;
    // Every offered choice is explicit — nothing is auto-dropped.
    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${ROOT_CLASS}-context-resolve-${choice}`;
      button.dataset.chatResolveChoice = choice;
      button.textContent = CHOICE_LABELS[choice];
      button.addEventListener("click", () => {
        const target = resolvingRef;
        closeResolution();
        if (target !== null) callbacks.onResolve(target, choice);
      });
      actions.appendChild(button);
    }
    dialog.appendChild(actions);

    previewAnchor.appendChild(dialog);
    resolveElement = dialog;
    resolvingRef = ref;
    return choices;
  }

  function renderChips(): void {
    container.replaceChildren();
    for (const ref of refs) {
      const chip = document.createElement("span");
      chip.className = `${ROOT_CLASS}-context-chip`;
      chip.id = chipIdFor(ref);
      chip.setAttribute(CONTEXT_CHIP_MARKER, "1");
      chip.setAttribute("data-status", ref.status);
      // Geometry contract as custom properties; styles.css consumes them.
      chip.style.setProperty("--UnicDB-chip-h", `${CONTEXT_CHIP_MIN_HEIGHT_PX}px`);
      chip.style.setProperty("--UnicDB-chip-remove", `${CONTEXT_CHIP_REMOVE_SIZE_PX}px`);

      // Root gets the FULL accessible name: status + full detail, so an
      // ellipsized label never hides identity.
      const accessible = contextChipAccessibleLabel(ref);
      chip.title = accessible;
      chip.setAttribute("aria-label", accessible);

      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = `${ROOT_CLASS}-context-chip-preview`;
      preview.setAttribute(CONTEXT_CHIP_PREVIEW_MARKER, "1");
      preview.setAttribute("aria-haspopup", "dialog");
      preview.setAttribute("aria-expanded", "false");

      const icon = createChatIcon(ref.kind, CONTEXT_CHIP_ICON_SIZE_PX);
      icon.classList.add(`${ROOT_CLASS}-context-chip-icon`);
      preview.appendChild(icon);

      const label = document.createElement("span");
      label.className = `${ROOT_CLASS}-context-chip-label`;
      // Ellipsized in CSS; hostile text stays inert.
      label.textContent = ref.displayToken;
      preview.appendChild(label);

      if (ref.status !== "ready") {
        const status = document.createElement("span");
        status.className = `${ROOT_CLASS}-context-chip-status`;
        status.setAttribute("data-status", ref.status);
        status.textContent = contextStatusLabel(ref.status);
        preview.appendChild(status);
      }

      // A click on the body requests a SAFE PREVIEW only — never a model call.
      preview.addEventListener("click", () => {
        callbacks.onPreview(ref);
      });
      chip.appendChild(preview);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = `${ROOT_CLASS}-context-chip-remove`;
      remove.setAttribute(CONTEXT_CHIP_REMOVE_MARKER, "1");
      // Identity is the id: two same-labelled chips remove independently.
      remove.dataset.chatContextRefId = ref.id;
      remove.title = `Remove context: ${ref.displayToken}`;
      remove.setAttribute("aria-label", `Remove context: ${ref.displayToken}`);
      const removeIcon = createChatIcon("x", CONTEXT_CHIP_ICON_SIZE_PX);
      remove.appendChild(removeIcon);
      remove.addEventListener("click", () => {
        callbacks.onRemove(ref.id);
      });
      chip.appendChild(remove);

      container.appendChild(chip);
    }
  }

  return {
    render(next: readonly ContextRef[]): void {
      if (destroyed) return;
      refs = next;
      renderChips();
    },
    showPreview(ref: ContextRef): void {
      if (destroyed) return;
      renderPreview(ref);
    },
    closePreview(): void {
      if (destroyed) return;
      closePreview();
    },
    openResolution(ref: ContextRef, policy: { readonly allowKeepSnapshot: boolean }) {
      if (destroyed) return Object.freeze<ContextResolutionChoice[]>([]);
      return openResolution(ref, policy);
    },
    resolvingRefId(): string | null {
      return resolvingRef?.id ?? null;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      closePreview();
      closeResolution();
      container.replaceChildren();
      refs = [];
    },
  };
}
