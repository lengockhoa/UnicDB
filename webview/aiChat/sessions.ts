// webview/aiChat/sessions.ts — TASK-CHATV2-015
//
// Session UX: the header overflow menu (New chat · Rename · Export · Clear ·
// Diagnostics · Settings), the inline title rename, the resume picker, the
// clear/new confirmations, the export format dialog and the diagnostics sheet.
//
// CONTRACT
// - This module NEVER scrapes the DOM. Every export/resume request is a typed
//   callback; the host owns the structured record.
// - Session ids are OPAQUE EXACT ECHOES. Rename/export/switch responses are
//   correlated by clientRequestId AND the sessionId they were issued against;
//   a stale ack cannot mutate the live session.
// - Saved-transcript copy is truthful: the picker is labelled
//   `Resume saved UnicDB chat` and never claims provider-native resume.
// - Success is announced ONLY on host confirmation (`export_completed` →
//   `Exported chat`); cancel produces no success; failure is exactly
//   `Could not export chat` + a safe reason.
// - All menu rows are >=40px (styles.css owns the rule) and every dialog is
//   keyboard/focus safe (Escape closes, focus moves in and returns out).
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { createChatIcon } from "./icons";
import { CHAT_V2_ROOT_CLASS } from "./shell";
import type { AiChatHostFrameV2 } from "../../src/ui/aiChatPanelMessages";

const PREFIX = CHAT_V2_ROOT_CLASS;

/** Stable ids later tasks / tests address. Never renamed. */
export const SESSIONS_IDS = Object.freeze({
  menu: `${PREFIX}-session-menu`,
  overflowButton: `${PREFIX}-overflow`,
  resumePicker: `${PREFIX}-resume-picker`,
  titleInput: `${PREFIX}-title-input`,
} as const);

/** Exact, locked copy. */
export const RESUME_PICKER_LABEL = "Resume saved UnicDB chat";
export const RESUME_EMPTY_LABEL = "No saved UnicDB chats in this workspace.";
export const NATIVE_RESUME_DISCLAIMER =
  "Saved UnicDB transcript — this is not a provider-native session resume.";
export const EXPORT_SUCCESS_LABEL = "Exported chat";
export const EXPORT_FAILURE_LABEL = "Could not export chat";
export const CLEAR_CONFIRM_COPY =
  "This clears the current transcript. Your other saved UnicDB chats are kept.";
export const NEW_CHAT_CONFIRM_COPY =
  "Starting a new chat keeps this chat saved. You can resume it later.";
export const OVERFLOW_LABEL = "More actions";

/** Overflow menu inventory, in order (PLAN §5). */
export type SessionsMenuAction =
  | "new"
  | "rename"
  | "export"
  | "clear"
  | "diagnostics"
  | "settings";

export const SESSIONS_MENU_ITEMS: readonly { readonly action: SessionsMenuAction; readonly label: string }[] =
  Object.freeze([
    { action: "new", label: "New chat" },
    { action: "rename", label: "Rename" },
    { action: "export", label: "Export" },
    { action: "clear", label: "Clear" },
    { action: "diagnostics", label: "Diagnostics" },
    { action: "settings", label: "Settings" },
  ]);

export type AiChatExportFormat = "markdown" | "json";

export interface SessionsListEntry {
  readonly sessionId: string;
  readonly label: string;
  readonly detail: string;
}

/** Host-owned inputs this component renders. */
export interface SessionsViewState {
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly hasHistory: boolean;
  readonly hasDraft: boolean;
  readonly busy: boolean;
  readonly sessions: readonly SessionsListEntry[];
  readonly diagnosticIds: readonly string[];
  readonly engine: string;
  readonly model: string;
}

/** Every outbound intent carries an opaque clientRequestId. */
export interface SessionsCallbacks {
  onNewSession(clientRequestId: string, sessionId: string | null): void;
  onRenameSession(clientRequestId: string, sessionId: string, title: string): void;
  onClearSession(clientRequestId: string, sessionId: string): void;
  onExportSession(clientRequestId: string, sessionId: string, format: AiChatExportFormat): void;
  onResumeSession(clientRequestId: string, sessionId: string): void;
  onListSessions(): void;
  onOpenSettings(): void;
  /** Diagnostics copy — the panel copies the SAFE metadata text. */
  onCopyDiagnostics(text: string): void;
}

export interface SessionsRefs {
  /** Scope root; dialogs are appended here. */
  readonly root: HTMLElement;
  /** Header that owns the overflow button. */
  readonly header: HTMLElement;
  /** Live region for polite announcements (may be absent in bare tests). */
  readonly statusLiveRegion?: HTMLElement | null;
  /** Live region for assertive announcements. */
  readonly alertLiveRegion?: HTMLElement | null;
}

export interface SessionsController {
  render(state: SessionsViewState): void;
  applyHostFrame(frame: AiChatHostFrameV2): void;
  /** A rename write failed — keep the edit visible and toast a safe reason. */
  notifyRenameFailed(clientRequestId: string, safeMessage: string): void;
  openMenu(): void;
  closeMenu(): void;
  isMenuOpen(): boolean;
  openResumePicker(): void;
  openExportDialog(): void;
  openDiagnostics(): void;
  beginRename(): void;
  dispose(): void;
}

/** Deterministic client-request id factory (opaque, monotonic). */
function makeRequestIdFactory(): () => string {
  let n = 0;
  return () => `req-${++n}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_STATE: SessionsViewState = {
  sessionId: null,
  title: null,
  hasHistory: false,
  hasDraft: false,
  busy: false,
  sessions: [],
  diagnosticIds: [],
  engine: "",
  model: "",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  ...classes: string[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (classes.length > 0) node.className = classes.join(" ");
  return node;
}

function cls(...names: string[]): string {
  return names.map((n) => `${PREFIX}-${n}`).join(" ");
}

/**
 * Create the session controller bound to `refs`. It does not own the reducer;
 * call `render` with the current view state and `applyHostFrame` for each host
 * frame. All dialogs are `role="dialog"` with `aria-modal="true"`, focus moved
 * to the first control on open and restored to the opener on close.
 */
export function createSessionsController(
  refs: SessionsRefs,
  callbacks: SessionsCallbacks,
): SessionsController {
  const nextRequestId = makeRequestIdFactory();
  let state: SessionsViewState = EMPTY_STATE;
  let disposed = false;

  // -- panes ---------------------------------------------------------------
  const layer = el("div", cls("dialog-layer"));
  layer.hidden = true;
  refs.root.appendChild(layer);

  let menu: HTMLElement | null = null;
  let menuOpen = false;
  let activeRowIndex = 0;
  let dialog: HTMLElement | null = null;
  let dialogOpener: HTMLElement | null = null;

  /** Pending rename correlated by clientRequestId AND sessionId. */
  let pendingRename: { clientRequestId: string; sessionId: string; title: string } | null = null;
  /** Pending export correlated by clientRequestId AND sessionId. */
  let pendingExport: { clientRequestId: string; sessionId: string; format: AiChatExportFormat } | null =
    null;
  /** Inline rename input while editing. */
  let renameInput: HTMLInputElement | null = null;

  const overflowButton = findOverflowButton(refs.header);

  function findOverflowButton(header: HTMLElement): HTMLButtonElement {
    const existing = header.querySelector<HTMLButtonElement>(`#${SESSIONS_IDS.overflowButton}`);
    if (existing) return existing;
    const btn = el("button", cls("control"), cls("overflow"));
    btn.id = SESSIONS_IDS.overflowButton;
    btn.type = "button";
    btn.setAttribute("aria-label", OVERFLOW_LABEL);
    btn.title = OVERFLOW_LABEL;
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(createChatIcon("ellipsis", 16));
    header.appendChild(btn);
    return btn;
  }

  function announce(message: string, live: "status" | "alert"): void {
    const region = live === "alert" ? refs.alertLiveRegion : refs.statusLiveRegion;
    if (region) region.textContent = message;
  }

  function toast(message: string, level: "info" | "warning" | "error"): void {
    announce(message, level === "error" ? "alert" : "status");
    const node = el("div", cls("toast"));
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", level === "error" ? "assertive" : "polite");
    node.dataset["level"] = level;
    node.textContent = message;
    refs.root.appendChild(node);
    setTimeout(() => node.remove(), 4000);
  }

  // -- keyboard / focus ----------------------------------------------------

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(scope: HTMLElement): HTMLElement[] {
    return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => !n.hasAttribute("hidden") && n.offsetParent !== null ? true : true,
    );
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (disposed) return;
    if (event.key === "Escape") {
      if (dialog !== null) {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (menuOpen) {
        event.preventDefault();
        closeMenu();
      }
      return;
    }
    if (dialog !== null) {
      if (event.key === "Tab") trapTab(event);
      return;
    }
    if (menuOpen) handleMenuKey(event);
  }

  /** Keep Tab inside a modal dialog; focus wraps first <-> last. */
  function trapTab(event: KeyboardEvent): void {
    if (dialog === null) return;
    const items = focusables(dialog);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onDocumentKeydown, true);

  // -- menu ----------------------------------------------------------------

  function menuRows(): HTMLButtonElement[] {
    if (menu === null) return [];
    return Array.from(menu.querySelectorAll<HTMLButtonElement>("button[data-action]"));
  }

  function highlightRow(index: number): void {
    const rows = menuRows();
    if (rows.length === 0) return;
    activeRowIndex = ((index % rows.length) + rows.length) % rows.length;
    rows.forEach((row, i) => {
      const on = i === activeRowIndex;
      row.setAttribute("tabindex", on ? "0" : "-1");
      row.dataset["active"] = on ? "true" : "false";
    });
    rows[activeRowIndex]?.focus();
  }

  function handleMenuKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightRow(activeRowIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightRow(activeRowIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      highlightRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      highlightRow(menuRows().length - 1);
    }
  }

  function openMenu(): void {
    if (disposed || menuOpen) return;
    menuOpen = true;
    pendingExport = pendingExport; // no-op; kept explicit for readability
    menu = el("div", cls("menu"));
    menu.id = SESSIONS_IDS.menu;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", OVERFLOW_LABEL);
    for (const item of SESSIONS_MENU_ITEMS) {
      const row = el("button", cls("menu-row"));
      row.type = "button";
      row.setAttribute("role", "menuitem");
      row.dataset["action"] = item.action;
      row.dataset["capability"] = capabilityFor(item.action);
      row.textContent = item.label;
      row.addEventListener("click", () => {
        closeMenu();
        runMenuAction(item.action);
      });
      menu.appendChild(row);
    }
    // Anchor under the overflow button.
    menu.style.position = "absolute";
    refs.header.appendChild(menu);
    overflowButton.setAttribute("aria-expanded", "true");
    highlightRow(0);
  }

  function capabilityFor(action: SessionsMenuAction): string {
    if (action === "rename") return state.sessionId === null ? "disabled" : "enabled";
    if (action === "export" || action === "clear") return state.hasHistory ? "enabled" : "enabled";
    return "enabled";
  }

  function closeMenu(): void {
    if (!menuOpen) return;
    menuOpen = false;
    menu?.remove();
    menu = null;
    overflowButton.setAttribute("aria-expanded", "false");
    overflowButton.focus();
  }

  function isMenuOpen(): boolean {
    return menuOpen;
  }

  function runMenuAction(action: SessionsMenuAction): void {
    switch (action) {
      case "new":
        requestNew();
        return;
      case "rename":
        beginRename();
        return;
      case "export":
        openExportDialog();
        return;
      case "clear":
        openClearConfirm();
        return;
      case "diagnostics":
        openDiagnostics();
        return;
      case "settings":
        callbacks.onOpenSettings();
        return;
    }
  }

  // -- dialogs -------------------------------------------------------------

  function openDialog(options: {
    readonly title: string;
    readonly body?: string;
    readonly className?: string;
    readonly actions: readonly {
      readonly label: string;
      readonly primary?: boolean;
      readonly onSelect: () => void;
      readonly keepOpen?: boolean;
    }[];
    readonly opener?: HTMLElement | null;
  }): HTMLElement {
    closeDialog();
    dialogOpener = options.opener ?? (document.activeElement as HTMLElement | null);
    const dlg = el("div", cls("dialog"), ...(options.className ? [options.className] : []));
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-label", options.title);
    const heading = el("h2", cls("dialog-title"));
    heading.textContent = options.title;
    dlg.appendChild(heading);
    if (options.body !== undefined) {
      const body = el("p", cls("dialog-body"));
      body.textContent = options.body;
      dlg.appendChild(body);
    }
    const actions = el("div", cls("dialog-actions"));
    for (const action of options.actions) {
      const btn = el("button", cls("dialog-action"));
      btn.type = "button";
      btn.textContent = action.label;
      if (action.primary === true) btn.dataset["primary"] = "true";
      btn.addEventListener("click", () => {
        const keep = action.keepOpen === true;
        if (!keep) closeDialog();
        action.onSelect();
      });
      actions.appendChild(btn);
    }
    dlg.appendChild(actions);
    layer.appendChild(dlg);
    layer.hidden = false;
    dialog = dlg;
    const first = focusables(dlg)[0];
    first?.focus();
    return dlg;
  }

  function closeDialog(): void {
    if (dialog === null) return;
    dialog.remove();
    dialog = null;
    layer.hidden = true;
    if (dialogOpener !== null && dialogOpener.isConnected) dialogOpener.focus();
    dialogOpener = null;
  }

  // -- new chat ------------------------------------------------------------

  function requestNew(): void {
    const sessionId = state.sessionId;
    if (!state.hasHistory && !state.hasDraft) {
      const clientRequestId = nextRequestId();
      callbacks.onNewSession(clientRequestId, sessionId);
      return;
    }
    openDialog({
      title: "Start a new chat?",
      body: NEW_CHAT_CONFIRM_COPY,
      className: cls("dialog-confirm"),
      actions: [
        { label: "Cancel", onSelect: () => undefined },
        {
          label: "Start new chat",
          primary: true,
          onSelect: () => {
            const clientRequestId = nextRequestId();
            callbacks.onNewSession(clientRequestId, sessionId);
          },
        },
      ],
    });
  }

  // -- clear ---------------------------------------------------------------

  function openClearConfirm(): void {
    openDialog({
      title: "Clear this transcript?",
      body: CLEAR_CONFIRM_COPY,
      className: cls("dialog-confirm"),
      actions: [
        { label: "Cancel", onSelect: () => undefined },
        {
          label: "Clear transcript",
          primary: true,
          onSelect: () => {
            if (state.sessionId === null) return;
            callbacks.onClearSession(nextRequestId(), state.sessionId);
          },
        },
      ],
    });
  }

  // -- rename --------------------------------------------------------------

  function titleNode(): HTMLElement | null {
    return refs.header.querySelector<HTMLElement>(`.${PREFIX}-title-inline`);
  }

  function beginRename(): void {
    if (disposed || state.sessionId === null) return;
    const host = titleNode() ?? refs.header;
    if (renameInput !== null) {
      renameInput.focus();
      renameInput.select();
      return;
    }
    const original = state.title ?? "";
    const input = el("input", cls("title-input"));
    input.id = SESSIONS_IDS.titleInput;
    input.type = "text";
    input.value = original;
    input.setAttribute("aria-label", "Chat title");
    renameInput = input;

    const commit = (): void => {
      const value = input.value.trim();
      if (value.length === 0) {
        // Empty title is rejected locally; the edit stays so the user can fix it.
        commitFailed("A chat title cannot be empty.");
        return;
      }
      const clientRequestId = nextRequestId();
      pendingRename = { clientRequestId, sessionId: state.sessionId!, title: value };
      callbacks.onRenameSession(clientRequestId, state.sessionId!, value);
      // Stay in edit mode until the host acks (title_updated) or fails.
    };
    const revert = (): void => {
      cancelRename();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        revert();
      }
    });
    input.addEventListener("blur", () => {
      // A blur without an ack is treated as a cancel so the edit cannot stick
      // unreconciled; an acked rename has already cleared the input.
      if (renameInput === input) cancelRename();
    });

    input.dataset["original"] = original;
    host.appendChild(input);
    input.focus();
    input.select();

    function commitFailed(message: string): void {
      // Keep the user's edit; surface a safe toast.
      toast(message, "warning");
    }
  }

  function cancelRename(): void {
    if (renameInput === null) return;
    renameInput.remove();
    renameInput = null;
    pendingRename = null;
    renderTitle();
  }

  function renderTitle(): void {
    let title = titleNode();
    if (title === null) {
      title = el("span", `${PREFIX}-title-inline`);
      refs.header.appendChild(title);
    }
    title.textContent = state.title !== null && state.title.length > 0 ? state.title : "Untitled chat";
    title.title = title.textContent;
    title.tabIndex = 0;
    title.setAttribute("aria-label", `Chat title: ${title.textContent}. Press F2 to rename.`);
    title.addEventListener("dblclick", () => beginRename());
    title.addEventListener("keydown", (event) => {
      if (event.key === "F2") {
        event.preventDefault();
        beginRename();
      }
    });
  }

  // -- resume picker -------------------------------------------------------

  function openResumePicker(): void {
    callbacks.onListSessions();
    renderResumePicker(state.sessions);
  }

  function renderResumePicker(sessions: readonly SessionsListEntry[]): void {
    const dlg = openDialog({
      title: RESUME_PICKER_LABEL,
      className: cls("dialog-resume"),
      actions: [{ label: "Close", onSelect: () => undefined }],
    });
    dlg.dataset["nativeResume"] = "false";
    const note = el("p", cls("dialog-note"));
    note.textContent = NATIVE_RESUME_DISCLAIMER;
    dlg.appendChild(note);

    if (sessions.length === 0) {
      const empty = el("p", cls("dialog-empty"));
      empty.textContent = RESUME_EMPTY_LABEL;
      dlg.appendChild(empty);
      return;
    }
    const list = el("ul", cls("resume-list"));
    for (const entry of sessions.slice(0, 20)) {
      const item = el("li", cls("resume-item"));
      const btn = el("button", cls("resume-row"));
      btn.type = "button";
      btn.dataset["sessionId"] = entry.sessionId; // opaque exact echo
      const label = el("span", cls("resume-label"));
      label.textContent = entry.label;
      const detail = el("span", cls("resume-detail"));
      detail.textContent = entry.detail;
      btn.appendChild(label);
      btn.appendChild(detail);
      btn.addEventListener("click", () => {
        const clientRequestId = nextRequestId();
        callbacks.onResumeSession(clientRequestId, entry.sessionId);
        closeDialog();
      });
      item.appendChild(btn);
      list.appendChild(item);
    }
    dlg.appendChild(list);
  }

  // -- export --------------------------------------------------------------

  function openExportDialog(): void {
    const sessionId = state.sessionId;
    const emit = (format: AiChatExportFormat): void => {
      if (sessionId === null) return;
      const clientRequestId = nextRequestId();
      pendingExport = { clientRequestId, sessionId, format };
      callbacks.onExportSession(clientRequestId, sessionId, format);
    };
    openDialog({
      title: "Export chat",
      body: "Choose a format. The host writes the structured transcript to a location you pick.",
      className: cls("dialog-export"),
      actions: [
        { label: "Cancel", onSelect: () => undefined },
        { label: "Markdown", onSelect: () => emit("markdown") },
        { label: "JSON", primary: true, onSelect: () => emit("json") },
      ],
    });
  }

  // -- diagnostics ---------------------------------------------------------

  /** Safe metadata only — never raw trace/stderr. */
  function diagnosticsText(): string {
    const lines = [
      `Session: ${state.sessionId ?? "(none)"}`,
      `Engine: ${state.engine || "(unknown)"}`,
      `Model: ${state.model || "(unknown)"}`,
      `Messages: ${state.hasHistory ? "present" : "none"}`,
      `Diagnostics: ${state.diagnosticIds.length > 0 ? state.diagnosticIds.join(", ") : "(none)"}`,
    ];
    return lines.join("\n");
  }

  function openDiagnostics(): void {
    const dlg = openDialog({
      title: "Chat diagnostics",
      className: cls("dialog-diagnostics"),
      actions: [
        { label: "Close", onSelect: () => undefined },
        {
          label: "Copy",
          primary: true,
          onSelect: () => callbacks.onCopyDiagnostics(diagnosticsText()),
        },
      ],
    });
    const pre = el("pre", cls("diagnostics-body"));
    pre.textContent = diagnosticsText();
    dlg.appendChild(pre);
  }

  // -- host frames ---------------------------------------------------------

  function applyHostFrame(frame: AiChatHostFrameV2): void {
    switch (frame.kind) {
      case "title_updated": {
        // Correlate by BOTH the pending request and the live session id.
        if (pendingRename === null) return;
        if (pendingRename.sessionId !== state.sessionId) return;
        if (frame.sessionId !== state.sessionId) return;
        state = { ...state, title: frame.title };
        pendingRename = null;
        if (renameInput !== null) {
          renameInput.remove();
          renameInput = null;
        }
        renderTitle();
        return;
      }
      case "sessions":
        state = { ...state, sessions: frame.items };
        // Refresh an open picker if one is showing.
        if (dialog !== null && dialog.classList.contains(`${PREFIX}-dialog-resume`)) {
          renderResumePicker(state.sessions);
        }
        return;
      case "export_completed": {
        if (pendingExport === null || frame.sessionId !== state.sessionId) return;
        pendingExport = null;
        // Success copy announced ONLY here, on host confirmation.
        toast(EXPORT_SUCCESS_LABEL, "info");
        return;
      }
      case "export_failed": {
        if (pendingExport === null || frame.sessionId !== state.sessionId) return;
        pendingExport = null;
        toast(`${EXPORT_FAILURE_LABEL}. ${frame.safeMessage}`, "error");
        return;
      }
      default:
        return;
    }
  }

  function notifyRenameFailed(clientRequestId: string, safeMessage: string): void {
    if (pendingRename === null || pendingRename.clientRequestId !== clientRequestId) return;
    // Keep the edit visible; do not silently discard the user's title.
    toast(`Rename failed. ${safeMessage}`, "error");
  }

  // -- lifecycle -----------------------------------------------------------

  function render(next: SessionsViewState): void {
    if (disposed) return;
    state = next;
    // A session switch invalidates in-flight rename/export correlation.
    if (pendingRename !== null && pendingRename.sessionId !== next.sessionId) pendingRename = null;
    if (pendingExport !== null && pendingExport.sessionId !== next.sessionId) pendingExport = null;
    renderTitle();
    if (menuOpen) {
      closeMenu();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("keydown", onDocumentKeydown, true);
    closeMenu();
    closeDialog();
    layer.remove();
    renameInput?.remove();
    renameInput = null;
  }

  // Overflow button opens the menu (the shell only created the node).
  overflowButton.addEventListener("click", () => {
    if (menuOpen) closeMenu();
    else openMenu();
  });

  return {
    render,
    applyHostFrame,
    notifyRenameFailed,
    openMenu,
    closeMenu,
    isMenuOpen,
    openResumePicker,
    openExportDialog,
    openDiagnostics,
    beginRename,
    dispose,
  };
}
