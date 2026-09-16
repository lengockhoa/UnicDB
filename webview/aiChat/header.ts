// webview/aiChat/header.ts — TASK-CHATV2-012
//
// The V2 40px header: product mark + session title + engine pill + overflow.
// It is a PURE VIEW over `ChatViewState` plus a small semantic callback surface.
//
// OWNERSHIP
// - It owns the header's own pointer/keyboard interaction: the inline session
//   title edit (click or F2 to enter, Enter to SAVE-request, Escape to revert)
//   and the 32×32 overflow menu. It never acquires a transport and never posts:
//   every mutation is reported to the controller, which owns `postMessage`.
// - The engine pill is not re-implemented here. It renders through
//   `renderEnginePill` (engineModelMenus.ts) so the truthful
//   `<displayName> · <Ready|Starting|Working|Unavailable>` label has ONE
//   definition, and it delegates the listbox to `createEngineMenu`.
//
// CAPABILITY-GATED OVERFLOW. The six overflow actions are each gated by a
// boolean the caller computes from the capability snapshot — this module never
// branches a feature on an engine name. A gated-off action is not rendered at
// all (never a dead/coming-soon control).
//
// SAVED-TRANSCRIPT LABELLING. The title is the user-provided session name; the
// resume affordance is labelled as a SAVED transcript, never a provider-native
// resume (that wording belongs to the host's capability data).
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { createChatIcon } from "./icons";
import {
  createEngineMenu,
  renderEnginePill,
  type EngineMenuEntry,
  type EngineMenuView,
} from "./engineModelMenus";
import { createOverlayMenu, type OverlayMenu } from "./overlays";
import type { ChatViewState } from "./store";
import { CHAT_V2_ROOT_CLASS } from "./shell";

const ROOT_CLASS = CHAT_V2_ROOT_CLASS;

function cls(name: string): string {
  return `${ROOT_CLASS}-${name}`;
}

/** Fixed product copy (constant, never host data). */
export const HEADER_PRODUCT_TITLE = "UnicDB AI";
/** Header height, in px (PLAN §3: 40px header). */
export const HEADER_HEIGHT_PX = 40;
/** Engine pill minimum height, in px (task spec: >=32px). */
export const HEADER_ENGINE_PILL_MIN_PX = 32;
/** Overflow control edge, in px (PLAN §5: 32×32). */
export const HEADER_OVERFLOW_SIZE_PX = 32;
/** Plug-icon edge shown inside the pill, in px (task spec: 14px). */
export const HEADER_PLUG_ICON_PX = 14;

/** Overflow action ids, in canonical order. */
export type HeaderOverflowAction =
  | "new-chat"
  | "rename"
  | "export"
  | "clear"
  | "diagnostics"
  | "settings";

/** Capability gate for each overflow action (computed by the caller). */
export interface HeaderOverflowGates {
  readonly newChat: boolean;
  readonly rename: boolean;
  readonly export: boolean;
  readonly clear: boolean;
  readonly diagnostics: boolean;
  readonly settings: boolean;
}

/** Exact overflow labels. */
const OVERFLOW_LABELS: Readonly<Record<HeaderOverflowAction, string>> = Object.freeze({
  "new-chat": "New chat",
  rename: "Rename",
  export: "Export",
  clear: "Clear",
  diagnostics: "Diagnostics",
  settings: "Settings",
});

/** The header's semantic callback surface. Transport-owned by the controller. */
export interface HeaderCallbacks {
  /** A session title rename was submitted (Enter, or blur after an edit). */
  onRenameSubmit(title: string): void;
  /** An overflow action was chosen. */
  onOverflowAction(action: HeaderOverflowAction): void;
  /** A selectable engine was chosen from the pill menu (idle path). */
  onSelectEngine(engine: EngineMenuEntry["engine"]): void;
  /** A non-selectable engine row's setup affordance was chosen. */
  onEngineSetup(engine: EngineMenuEntry["engine"]): void;
}

export interface HeaderOptions {
  /** The shell's header mount point (`refs.header`). */
  readonly header: HTMLElement;
  readonly callbacks: HeaderCallbacks;
  /**
   * Gate map; actions whose gate is false are not rendered. Omit it when the
   * header does not own the overflow menu (`ownOverflow: false`) — the map is
   * then never consulted.
   */
  readonly gates?: HeaderOverflowGates;
  /**
   * TASK-CHATV2-017: whether this view also binds the overflow MENU. The
   * session surface (sessions.ts) already owns that menu, so the controller
   * mounts the header with `ownOverflow: false` — the header then only exposes
   * the (already wired) overflow button instead of stacking a second menu and a
   * second click listener on the same node. Defaults to `true`.
   */
  readonly ownOverflow?: boolean;
  /**
   * TASK-CHATV2-017: whether this view also owns the session title display and
   * its inline rename. The session surface (sessions.ts) already renders that
   * title from the same reducer state and owns rename (dblclick/F2, host
   * `title_updated` ack), so the controller mounts the header with
   * `ownTitle: false`: the shell's placeholder title node is removed instead of
   * leaving a second visible title, and no editor/listener is stacked on top of
   * the sessions-owned one. Defaults to `true`.
   */
  readonly ownTitle?: boolean;
  /** Host-provided engine entries. DATA — never derived by engine name. */
  readonly engineEntries: readonly EngineMenuEntry[];
  /**
   * TASK-CHATV2-017: called when the engine pill is activated, BEFORE the menu
   * toggles — the controller re-syncs the entries from the current reducer
   * state so the menu always shows host truth, never a stale snapshot.
   */
  readonly onEngineOpen?: () => void;
  /** Present only when a session list genuinely exists (else the mark is
   * decorative, per PLAN §5). */
  readonly hasSessionList?: boolean;
  /** Called when the decorative mark is activated and a session list exists. */
  readonly onOpenSessions?: () => void;
}

export interface ChatHeaderView {
  readonly root: HTMLElement;
  readonly titleElement: HTMLElement;
  readonly enginePill: HTMLButtonElement;
  readonly overflowButton: HTMLButtonElement;
  /** True while the inline title editor is open. */
  isEditingTitle(): boolean;
  /** Enter title edit mode (click handler / F2). */
  beginTitleEdit(): void;
  /** Cancel the edit and revert to the last host-acknowledged title. */
  cancelTitleEdit(): void;
  /** Commit the edit (reports intent; the visible title updates on ack). */
  commitTitleEdit(): void;
  /** Render from state. Pure; never dispatches. */
  render(state: ChatViewState): void;
  /** Reflect a host-acknowledged title without an optimistic swap. */
  setTitleFromHost(title: string | null): void;
  /** Replace the engine entries (host data). */
  setEngineEntries(entries: readonly EngineMenuEntry[]): void;
  readonly engineMenu: EngineMenuView;
  readonly menu: () => OverlayMenu | null;
  destroy(): void;
}

/** `state.sessionTitle`, or the fixed product title when unset. */
function titleFor(state: ChatViewState): string {
  const title = state.sessionTitle;
  return typeof title === "string" && title.trim().length > 0 ? title : HEADER_PRODUCT_TITLE;
}

/**
 * Wire the header controls inside `options.header`. The caller (the controller
 * or the integration seam) owns the shell mount; this function only fills and
 * binds the header's children.
 */
export function createChatHeader(options: HeaderOptions): ChatHeaderView {
  const header = options.header;
  header.classList.add(cls("header"));

  // ---- Mark (decorative unless a real session list exists) ---------------
  const mark = header.querySelector<HTMLElement>(`.${cls("mark")}`);
  const onMarkActivate = (): void => options.onOpenSessions?.();
  if (mark !== null) {
    if (options.hasSessionList === true) {
      mark.removeAttribute("aria-hidden");
      mark.setAttribute("role", "button");
      mark.setAttribute("tabindex", "0");
      mark.setAttribute("aria-label", "Open chats");
      if (options.onOpenSessions !== undefined) {
        mark.addEventListener("click", onMarkActivate);
      }
    } else {
      mark.setAttribute("aria-hidden", "true");
    }
  }

  // ---- Session title -----------------------------------------------------
  // TASK-CHATV2-017: when the session surface already owns the title, the
  // shell's placeholder node is REMOVED here rather than left behind as a
  // second visible title (two titles on one 40px row would also overflow it).
  const ownTitle = options.ownTitle !== false;
  const existingTitle = header.querySelector<HTMLElement>(`.${cls("title")}`);
  if (!ownTitle) existingTitle?.remove();
  const title = ownTitle
    ? existingTitle ?? (() => {
        const node = document.createElement("span");
        node.className = cls("title");
        header.appendChild(node);
        return node;
      })()
    : document.createElement("span");
  if (ownTitle) {
    title.setAttribute("tabindex", "0");
    title.setAttribute("role", "textbox");
    title.setAttribute("aria-label", "Chat title");
    title.title = "Rename chat (F2)";
  }

  const editor = document.createElement("input");
  editor.type = "text";
  editor.className = cls("title-editor");
  editor.hidden = true;
  editor.setAttribute("aria-label", "Chat title");
  if (ownTitle) header.appendChild(editor);

  let editing = false;
  let committedTitle: string | null = null;

  function openEditor(): void {
    if (!ownTitle || editing) return;
    editing = true;
    editor.value = title.textContent ?? "";
    editor.hidden = false;
    title.hidden = true;
    try {
      editor.focus();
      editor.select();
    } catch {
      /* jsdom focus is best-effort */
    }
  }

  function closeEditor(): void {
    editing = false;
    editor.hidden = true;
    title.hidden = false;
  }

  function commit(): void {
    if (!editing) return;
    const next = editor.value.trim();
    closeEditor();
    if (next.length === 0) return; // an empty rename is a revert, not a save
    // Report intent only — the visible title changes when the host acks.
    options.callbacks.onRenameSubmit(next);
  }

  function cancel(): void {
    if (!editing) return;
    closeEditor();
    title.textContent = committedTitle ?? title.textContent ?? HEADER_PRODUCT_TITLE;
  }

  // Named refs so destroy() can remove exactly what was added (a remount must
  // never stack a second listener on the shell's persistent header nodes).
  const onTitleClick = (): void => openEditor();
  const onTitleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "F2" || event.key === "Enter") {
      event.preventDefault();
      openEditor();
    }
  };
  const onEditorKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  if (ownTitle) {
    title.addEventListener("click", onTitleClick);
    title.addEventListener("keydown", onTitleKeydown);
    editor.addEventListener("keydown", onEditorKeydown);
  }

  // ---- Engine pill -------------------------------------------------------
  const enginePill = header.querySelector<HTMLButtonElement>(`.${cls("engine")}`) ?? (() => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = cls("engine");
    header.appendChild(node);
    return node;
  })();
  enginePill.id = `${ROOT_CLASS}-engine`;
  enginePill.style.setProperty("--UnicDB-pill-min", `${HEADER_ENGINE_PILL_MIN_PX}px`);
  // Rebuild the pill's glyph so the plug icon is exactly 14px (task spec).
  const existingIcon = enginePill.querySelector("svg");
  if (existingIcon !== null) existingIcon.replaceWith(createChatIcon("plug", HEADER_PLUG_ICON_PX));
  else enginePill.appendChild(createChatIcon("plug", HEADER_PLUG_ICON_PX));
  if (enginePill.querySelector(`.${cls("engine-dot")}`) === null) {
    const dot = document.createElement("span");
    dot.className = cls("engine-dot");
    dot.setAttribute("aria-hidden", "true");
    enginePill.prepend(dot);
  }
  if (enginePill.querySelector(`.${cls("engine-label")}`) === null) {
    const label = document.createElement("span");
    label.className = `${cls("engine-label")} ${cls("label-optional")}`;
    enginePill.appendChild(label);
  }

  const engineMenu = createEngineMenu({
    anchor: header,
    trigger: enginePill,
    onSelectEngine: (engine) => options.callbacks.onSelectEngine(engine),
    onOpenSetup: (engine) => options.callbacks.onEngineSetup(engine),
  });
  engineMenu.setEntries(options.engineEntries);

  // Named refs (see the title handlers above) + the onEngineOpen seam: the
  // controller re-syncs the entries from reducer state before the menu shows.
  const onPillClick = (): void => {
    options.onEngineOpen?.();
    engineMenu.toggle();
  };
  const onPillKeydown = (event: KeyboardEvent): void => {
    if (engineMenu.handleKey(event)) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      options.onEngineOpen?.();
      engineMenu.open();
    }
  };
  enginePill.addEventListener("click", onPillClick);
  enginePill.addEventListener("keydown", onPillKeydown);

  // ---- Overflow ----------------------------------------------------------
  // TASK-CHATV2-017: the session surface owns the overflow MENU. With
  // `ownOverflow: false` this view exposes the (already wired) button but adds
  // NO second menu and NO second click listener on the same node.
  const ownOverflow = options.ownOverflow !== false;
  const overflowButton = header.querySelector<HTMLButtonElement>(`.${cls("overflow")}`) ?? (() => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = cls("overflow");
    header.appendChild(node);
    return node;
  })();
  overflowButton.id = `${ROOT_CLASS}-overflow`;
  overflowButton.style.setProperty("--UnicDB-overflow", `${HEADER_OVERFLOW_SIZE_PX}px`);
  overflowButton.setAttribute("aria-label", "More actions");
  overflowButton.title = "More actions";
  if (overflowButton.querySelector("svg") === null) {
    overflowButton.appendChild(createChatIcon("ellipsis", 16));
  }

  let menu: OverlayMenu | null = null;

  function buildOverflowRows(): Array<{ id: HeaderOverflowAction; label: string }> {
    const rows: Array<{ id: HeaderOverflowAction; label: string }> = [];
    const push = (id: HeaderOverflowAction, gated: boolean): void => {
      if (gated) rows.push({ id, label: OVERFLOW_LABELS[id] });
    };
    push("new-chat", options.gates.newChat);
    push("rename", options.gates.rename);
    push("export", options.gates.export);
    push("clear", options.gates.clear);
    push("diagnostics", options.gates.diagnostics);
    push("settings", options.gates.settings);
    return rows;
  }

  function ensureOverflowMenu(): OverlayMenu {
    if (menu !== null) return menu;
    menu = createOverlayMenu({
      anchor: header,
      trigger: overflowButton,
      ariaLabel: "More actions",
      onActivate: (row) => options.callbacks.onOverflowAction(row.id as HeaderOverflowAction),
      onClose: () => {
        overflowButton.setAttribute("aria-expanded", "false");
      },
    });
    return menu;
  }

  const onOverflowClick = (): void => {
    const m = ensureOverflowMenu();
    if (m.isOpen()) {
      m.close("api");
      return;
    }
    m.setRows(
      buildOverflowRows().map((row) => ({ id: row.id, label: row.label })),
    );
    m.open();
  };

  // Keyboard: the button opens with the platform keys and routes the listbox.
  const onOverflowKeydown = (event: KeyboardEvent): void => {
    const m = ensureOverflowMenu();
    if (m.isOpen() && m.handleKey(event)) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      m.setRows(buildOverflowRows().map((row) => ({ id: row.id, label: row.label })));
      m.open();
    }
  };

  if (ownOverflow) {
    overflowButton.addEventListener("click", onOverflowClick);
    overflowButton.addEventListener("keydown", onOverflowKeydown);
  }

  return {
    root: header,
    titleElement: title,
    enginePill,
    overflowButton,
    isEditingTitle: () => editing,
    beginTitleEdit: openEditor,
    cancelTitleEdit: cancel,
    commitTitleEdit: commit,
    render(state: ChatViewState): void {
      // With `ownTitle: false` the session surface writes the visible title —
      // this view never stacks a second writer on the same 40px row.
      if (ownTitle && !editing) {
        title.textContent = titleFor(state);
      }
      renderEnginePill(enginePill, state);
    },
    setTitleFromHost(next: string | null): void {
      committedTitle = next;
      if (ownTitle && !editing) title.textContent = next ?? HEADER_PRODUCT_TITLE;
    },
    setEngineEntries(entries: readonly EngineMenuEntry[]): void {
      engineMenu.setEntries(entries);
    },
    engineMenu,
    menu: () => (ownOverflow ? menu : null),
    destroy(): void {
      engineMenu.destroy();
      menu?.destroy();
      menu = null;
      editing = false;
      // Remove exactly the listeners this mount added on the shell's persistent
      // nodes so a remount (dispose → createChatController again) cannot stack
      // a second engine-menu binding or overflow binding.
      if (options.onOpenSessions !== undefined) mark?.removeEventListener("click", onMarkActivate);
      if (ownTitle) {
        title.removeEventListener("click", onTitleClick);
        title.removeEventListener("keydown", onTitleKeydown);
        editor.removeEventListener("keydown", onEditorKeydown);
      }
      enginePill.removeEventListener("click", onPillClick);
      enginePill.removeEventListener("keydown", onPillKeydown);
      if (ownOverflow) {
        overflowButton.removeEventListener("click", onOverflowClick);
        overflowButton.removeEventListener("keydown", onOverflowKeydown);
      }
      editor.remove();
    },
  };
}

/** Re-export for callers that only need the constant shape. */
export type { EngineMenuEntry };
