// webview/aiChat/errors.ts — TASK-CHATV2-016
//
// The V2 ERROR CARD. It renders exactly one mapped `AiChatErrorFrame`
// (`src/ui/aiChatErrors.ts`) and reports INTENT: Retry re-issues the ORIGINAL
// immutable structured request, Copy details round-trips only safe copy, and
// Change engine asks the caller to open the engine picker.
//
// CONTRACT
// - The card writes ONLY `frame.safeMessage`, `frame.safeDetail` and
//   `frame.diagnosticId`, always via `textContent`. A raw stderr line, provider
//   JSON, command, URL or secret can never become DOM text, an attribute or a
//   copy-details payload.
// - Retry is offered only when the frame allows it. The structured request is
//   captured once at creation and deep-copied on the way out (never mutated).
// - A second Retry click while one is in flight is a NO-OP, so a double-click
//   or a key-repeat cannot spawn two concurrent turns from one card.
// - The card is inert after `settle()` (its terminal turn was already retried
//   or replaced) — clicks do nothing and no callback fires.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import {
  errorActionAllowed,
  type AiChatErrorFrame,
  type AiChatErrorAction,
} from "../../src/ui/aiChatErrors";
import type { ComposerDraft } from "./store";
import { createChatIcon } from "./icons";
import { CHAT_V2_ROOT_CLASS } from "./shell";

const PREFIX = CHAT_V2_ROOT_CLASS;

/** Exact card title (PLAN §6, locked). */
export const ERROR_CARD_TITLE = "Could not complete this response";

export const ERROR_RETRY_LABEL = "Retry";
export const ERROR_COPY_DETAILS_LABEL = "Copy details";
export const ERROR_CHANGE_ENGINE_LABEL = "Change engine";
export const ERROR_DETAILS_SUMMARY = "Details";
export const ERROR_COPY_OK_LABEL = "Copied";
export const ERROR_COPY_FAIL_LABEL = "Could not copy";
export const ERROR_DIAGNOSTIC_PREFIX = "ID";

/** Marker attribute identifying the card for the shell/CSS and tests. */
export const ERROR_CARD_MARKER = "data-chat-error-card";

/** The immutable structured request a Retry re-issues. */
export interface AiChatStructuredRequest {
  readonly clientRequestId: string;
  readonly draft: ComposerDraft;
}

export interface ErrorCardCallbacks {
  /** Re-issue the captured request. Receives a fresh deep copy each call. */
  onRetry?(request: AiChatStructuredRequest): void;
  onChangeEngine?(): void;
}

export interface ErrorCardOptions {
  readonly frame: AiChatErrorFrame;
  /** The original structured request this failed turn belonged to. Required to
   * offer Retry; omitted, Retry is not rendered even if the frame allows it. */
  readonly request?: AiChatStructuredRequest;
  readonly callbacks?: ErrorCardCallbacks;
  /** Optional clipboard port (tests inject one; production uses the webview
   * clipboard API). */
  readonly clipboard?: { writeText(text: string): Promise<void> };
}

export interface ErrorCardHandle {
  readonly root: HTMLElement;
  /** True while a Retry has been dispatched and not yet settled. */
  readonly retryInFlight: boolean;
  /** True once the card was settled (inert). */
  readonly settled: boolean;
  /** The safe details payload `Copy details` would write. Never raw input. */
  detailsText(): string;
  /** Dispatch Retry if allowed and not already in flight. Returns whether a
   * retry was actually issued. */
  retry(): boolean;
  /** The in-flight retry answered (turn_started / a new error): ready for
   * another attempt unless the card was settled. */
  settleRetry(): void;
  /** Permanently retire the card (its turn was retried, replaced or removed). */
  settle(): void;
  destroy(): void;
}

/** Deep-copy a structured request so a retry can never alias the draft the
 * failed turn already owns. */
export function cloneStructuredRequest(request: AiChatStructuredRequest): AiChatStructuredRequest {
  return Object.freeze({
    clientRequestId: request.clientRequestId,
    draft: Object.freeze({
      ...request.draft,
      attachments: Object.freeze(request.draft.attachments.map((a) => Object.freeze({ ...a }))),
      context: Object.freeze(request.draft.context.map((c) => Object.freeze({ ...c }))),
    }),
  });
}

/**
 * Build the safe copy-details text for `frame`. Pure: the output is derived
 * from the frame's already-safe fields only, so no caller value can leak.
 */
export function errorDetailsText(frame: AiChatErrorFrame): string {
  const lines = [
    `Category: ${frame.category}`,
    `Message: ${frame.safeMessage}`,
    `${ERROR_DIAGNOSTIC_PREFIX}: ${frame.diagnosticId}`,
  ];
  if (frame.safeDetail !== undefined) lines.push(`Detail: ${frame.safeDetail}`);
  return lines.join("\n");
}

function el(tag: string, ...classes: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classes.map((c) => `${PREFIX}-${c}`).join(" ");
  return node;
}

/**
 * Create an error card bound to `options.frame`.
 *
 * The caller owns placement (the transcript pins it to the failed assistant
 * turn); this function only builds the node and its behavior.
 */
export function createErrorCard(options: ErrorCardOptions): ErrorCardHandle {
  const { frame, callbacks } = options;
  const request = options.request;

  const root = el("div", "error-card");
  root.setAttribute(ERROR_CARD_MARKER, frame.category);
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", ERROR_CARD_TITLE);

  const head = el("div", "error-card-head");
  const icon = el("span", "error-card-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.appendChild(createChatIcon("warning", 16));
  head.appendChild(icon);

  const title = el("span", "error-card-title");
  title.textContent = ERROR_CARD_TITLE;
  head.appendChild(title);

  const id = el("span", "error-card-id");
  id.textContent = `${ERROR_DIAGNOSTIC_PREFIX} ${frame.diagnosticId}`;
  id.title = frame.diagnosticId;
  head.appendChild(id);
  root.appendChild(head);

  const message = el("p", "error-card-message");
  message.textContent = frame.safeMessage;
  root.appendChild(message);

  // Collapsed, pre-scrubbed single line. Absent when the frame carried none,
  // so no empty disclosure is rendered.
  let detail: HTMLElement | null = null;
  if (frame.safeDetail !== undefined && frame.safeDetail.length > 0) {
    const details = document.createElement("details");
    details.className = `${PREFIX}-error-card-details`;
    const summary = document.createElement("summary");
    summary.className = `${PREFIX}-error-card-summary`;
    summary.textContent = ERROR_DETAILS_SUMMARY;
    details.appendChild(summary);
    detail = el("pre", "error-card-detail");
    detail.textContent = frame.safeDetail;
    details.appendChild(detail);
    root.appendChild(details);
  }

  const actions = el("div", "error-card-actions");
  root.appendChild(actions);

  let retryInFlight = false;
  let settled = false;

  const buttons: HTMLButtonElement[] = [];

  function makeButton(action: AiChatErrorAction, label: string, iconName: "retry" | "copy" | "plug"): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${PREFIX}-error-card-action`;
    btn.setAttribute("data-action", action);
    btn.setAttribute("aria-label", label);
    btn.title = label;
    if (iconName !== "plug") btn.appendChild(createChatIcon(iconName, 14));
    btn.appendChild(document.createTextNode(label));
    buttons.push(btn);
    return btn;
  }

  // ---- Retry ---------------------------------------------------------------
  let retryButton: HTMLButtonElement | null = null;
  const canRetry = errorActionAllowed(frame, "retry") && request !== undefined;
  if (canRetry) {
    retryButton = makeButton("retry", ERROR_RETRY_LABEL, "retry");
    retryButton.addEventListener("click", () => {
      retry();
    });
    actions.appendChild(retryButton);
  }

  function retry(): boolean {
    if (settled || retryInFlight || !canRetry || retryButton === null) return false;
    retryInFlight = true;
    retryButton.disabled = true;
    retryButton.setAttribute("aria-busy", "true");
    callbacks?.onRetry?.(cloneStructuredRequest(request!));
    return true;
  }

  // ---- Copy details --------------------------------------------------------
  let copyButton: HTMLButtonElement | null = null;
  if (errorActionAllowed(frame, "copy_details")) {
    copyButton = makeButton("copy-details", ERROR_COPY_DETAILS_LABEL, "copy");
    copyButton.addEventListener("click", () => {
      void copyDetails();
    });
    actions.appendChild(copyButton);
  }

  async function copyDetails(): Promise<void> {
    const text = errorDetailsText(frame);
    const clip = options.clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
    let ok = false;
    if (clip && typeof clip.writeText === "function") {
      try {
        await clip.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (copyButton === null) return;
    if (!ok) {
      copyButton.setAttribute("data-copy-state", "failed");
      return;
    }
    copyButton.setAttribute("data-copy-state", "ok");
  }

  // ---- Change engine -------------------------------------------------------
  if (errorActionAllowed(frame, "change_engine")) {
    const changeButton = makeButton("change-engine", ERROR_CHANGE_ENGINE_LABEL, "plug");
    changeButton.addEventListener("click", () => {
      if (settled) return;
      callbacks?.onChangeEngine?.();
    });
    actions.appendChild(changeButton);
  }

  function setDisabled(disabled: boolean): void {
    for (const btn of buttons) btn.disabled = disabled;
  }

  return {
    root,
    get retryInFlight() {
      return retryInFlight;
    },
    get settled() {
      return settled;
    },
    detailsText: () => errorDetailsText(frame),
    retry,
    settleRetry: () => {
      if (settled) return;
      retryInFlight = false;
      if (retryButton !== null) {
        retryButton.disabled = false;
        retryButton.removeAttribute("aria-busy");
      }
    },
    settle: () => {
      settled = true;
      retryInFlight = false;
      setDisabled(true);
      root.setAttribute("data-chat-error-settled", "1");
    },
    destroy: () => {
      settled = true;
      retryInFlight = false;
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Stop-failure advisory
// ---------------------------------------------------------------------------

/** Exact copy re-exported for callers that only need the label. */
export { STOP_FAILURE_COPY } from "../../src/ui/aiChatErrors";

export interface StopFailureNotice {
  readonly root: HTMLElement;
  destroy(): void;
}

/**
 * A failed Stop shows an ADVISORY, not a terminal card: the stop control stays
 * active and the turn keeps running until a later terminal host event. This
 * never renders a `Stopped` state.
 */
export function createStopFailureNotice(copy: string): StopFailureNotice {
  const root = el("div", "stop-failure");
  root.setAttribute("role", "status");
  root.setAttribute("data-chat-stop-failure", "1");
  const icon = el("span", "stop-failure-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.appendChild(createChatIcon("warning", 14));
  root.appendChild(icon);
  const text = el("span", "stop-failure-text");
  text.textContent = copy;
  root.appendChild(text);
  return { root, destroy: () => root.remove() };
}
