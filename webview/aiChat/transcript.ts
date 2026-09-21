// webview/aiChat/transcript.ts — TASK-CHATV2-006
//
// Keyed transcript renderer for the V2 chat surface. It reads ONE pure
// `ChatViewState` (TASK-CHATV2-004) and paints it into the shell's transcript
// container (TASK-CHATV2-005) with stable, per-`messageId` DOM nodes.
//
// CONTRACT
// - KEYED, NOT APPENDED. Every transcript item owns exactly one DOM node,
//   addressed by `data-chat-key`. A streaming assistant message keeps the SAME
//   node from its first delta through its terminal frame — the renderer never
//   deletes a streaming node and appends a duplicate. Raw source is held in
//   reducer state and mirrored into a JS record (never into a DOM dataset), and
//   action callbacks receive that raw source, never a DOM read-back.
// - ESCAPE-FIRST. Only assistant Markdown reaches `markdown.ts` (DOM,
//   `textContent`-only). User text, context labels, tool labels/summaries,
//   errors and every action label are written through `textContent`. No raw
//   provider/user string is ever assigned to `innerHTML`.
// - COALESCED STREAM PAINT, ≤30FPS. Streaming deltas are painted on the next
//   `requestAnimationFrame`, with a hard 100 ms `setTimeout` fallback, so a
//   burst of deltas costs at most one Markdown re-render — and a flush that
//   would land inside `STREAM_PAINT_MIN_INTERVAL_MS` (33 ms) of the previous
//   one is deferred through a timeout instead (TASK-CHATUX-W5-2). Terminal
//   items paint synchronously and finalize exactly once.
// - STOP. A stopped turn keeps its partial text, drops the decorative caret,
//   and gains one muted `Stopped` footer.
// - VIEWPORT CAP. Only `state.transcript.renderOrder` (<= `paging.cap`, default
//   200) is rendered; when `paging.hasMore` a `Load earlier messages` control
//   is offered. No browser persistence.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no storage.

import type {
  ChatTranscriptItem,
  ChatUserItem,
  ChatViewState,
} from "./store";
import { createChatIcon } from "./icons";
import { extractSqlFences, renderMarkdownInto } from "./markdown";
import { CHAT_V2_ROOT_CLASS } from "./shell";

const PREFIX = CHAT_V2_ROOT_CLASS;

/** Min interval between stream paints — caps streaming repaints at ~30fps
 * (TASK-CHATUX-W5-2, SPEC §7.2). */
export const STREAM_PAINT_MIN_INTERVAL_MS = 33;

/** Max stream-paint latency before a forced flush (ms). */
export const STREAM_PAINT_FALLBACK_MS = 100;

/** Accessibility copy for the clipboard round-trip. */
export const COPY_OK_LABEL = "Copied";
export const COPY_FAIL_LABEL = "Could not copy";

/** Copy shown on the load-earlier control. */
export const LOAD_EARLIER_LABEL = "Load earlier messages";

/** Copy shown on a stopped assistant message. */
export const STOPPED_LABEL = "Stopped";

/** TASK-CHATFIX-003: trailing live-turn indicator copy. Decorative — the real
 * status stays in the shell's live regions. */
const LIVE_LABEL = "Working…";

/** The transcript container plus the two shell live regions. `ChatShellRefs`
 * satisfies this shape, so callers pass the shell refs directly. */
export interface ChatTranscriptRefs {
  readonly transcript: HTMLElement;
  readonly statusLiveRegion?: HTMLElement | null;
  readonly alertLiveRegion?: HTMLElement | null;
}

/**
 * Controller callbacks. Each carries the STABLE item id and the raw safe source
 * (never a scraped `innerText`). All are optional; a missing callback makes the
 * corresponding control a no-op rather than a DOM guess.
 */
export interface TranscriptCallbacks {
  /** User bubble: Copy / Edit / Retry. */
  onCopyUser?(messageId: string, text: string): void;
  onEditUser?(messageId: string, text: string): void;
  onRetryUser?(messageId: string, text: string): void;
  /** Assistant message: Copy / Regenerate / More. */
  onCopyAssistant?(messageId: string, raw: string): void;
  onRegenerateAssistant?(messageId: string, raw: string): void;
  /** `trigger` is the clicked More button — the overlay's ARIA anchor
   * (TASK-CHATFIX-004; additive, callers may ignore it). */
  onMoreAssistant?(messageId: string, raw: string, trigger?: HTMLElement): void;
  /** Assistant SQL action — fires only when a SQL fence exists. */
  onInsertSql?(messageId: string, sql: string): void;
  /** Viewport paging request. */
  onLoadEarlier?(): void;
}

/** Public renderer handle. */
export interface TranscriptRenderer {
  /** Paint (or incrementally update) the transcript for `state`. */
  render(state: ChatViewState): void;
  /** Cancel pending paints and remove every node this renderer created. */
  dispose(): void;
}

/** Per-item bookkeeping. Holds raw source in JS, NOT in a DOM dataset. */
interface KeyedRecord {
  readonly root: HTMLElement;
  readonly kind: ChatTranscriptItem["kind"];
  body: HTMLElement | null;
  caret: HTMLElement | null;
  actions: HTMLElement | null;
  stopped: HTMLElement | null;
  buttons: Map<string, HTMLButtonElement>;
  /** Mirrors reducer `raw`/`text`; the single source for action payloads. */
  source: string;
  streaming: boolean;
  /** Set once a terminal frame has been applied to this node. */
  finalized: boolean;
  /** SQL payload, present only while a fence exists. */
  sql: string | null;
  /** TASK-CHATFIX-003 timeline: IN/OUT card container + its two text nodes
   * and the expand/collapse toggle. Created lazily, removed with the row. */
  io: HTMLElement | null;
  ioIn: HTMLElement | null;
  ioOut: HTMLElement | null;
  toolToggle: HTMLButtonElement | null;
}

function cls(name: string): string {
  return `${PREFIX}-${name}`;
}

function el(tag: string, ...classes: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classes.map(cls).join(" ");
  return node;
}

/** Build one 28x28 icon-only action button with title + aria-label. */
function actionButton(
  name: string,
  icon: "copy" | "edit" | "retry" | "ellipsis" | "chevron-right",
  label: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls("action");
  btn.setAttribute("data-action", name);
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.appendChild(createChatIcon(icon, 14));
  return btn;
}

/** TASK-CHATUX-003: one disclosure-toggle button bound to a record root's
 * `data-collapsed` flag. Mounts collapsed (`data-collapsed="1"` +
 * `aria-expanded="false"`); each click flips both. Shared by the tool IN/OUT
 * toggle and the reasoning disclosure row. */
function disclosureToggle(
  root: HTMLElement,
  className: string,
  label: string,
): HTMLButtonElement {
  root.setAttribute("data-collapsed", "1");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = className;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  toggle.appendChild(createChatIcon("chevron-down", 12));
  toggle.addEventListener("click", () => {
    const collapsed = root.getAttribute("data-collapsed") === "1";
    if (collapsed) root.removeAttribute("data-collapsed");
    else root.setAttribute("data-collapsed", "1");
    toggle.setAttribute("aria-expanded", collapsed ? "true" : "false");
  });
  return toggle;
}

/**
 * Create the keyed transcript renderer bound to `refs`.
 *
 * The container is owned by the renderer: its children after `render`/`dispose`
 * are exactly the load-earlier control (when needed) plus the current keyed
 * nodes.
 */
export function createTranscriptRenderer(
  refs: ChatTranscriptRefs,
  callbacks: TranscriptCallbacks = {},
): TranscriptRenderer {
  const container = refs.transcript;
  const records = new Map<string, KeyedRecord>();
  /** item id -> latest raw awaiting the next coalesced paint. */
  const pendingPaint = new Map<string, { record: KeyedRecord; raw: string }>();
  /** Active toast timers, cleared on dispose. */
  const timers = new Set<ReturnType<typeof setTimeout>>();

  let loadEarlier: HTMLButtonElement | null = null;
  /** TASK-CHATFIX-003: the single trailing live-turn indicator node. */
  let liveNode: HTMLElement | null = null;
  let rafHandle: number | null = null;
  let fallbackHandle: ReturnType<typeof setTimeout> | null = null;
  /** Deferred flush while inside the min-interval window. */
  let throttleHandle: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last flush that actually painted; null before the first. */
  let lastFlushAt: number | null = null;
  let disposed = false;

  // ------------------------------------------------------------------
  // Coalesced streaming paint
  // ------------------------------------------------------------------

  function flushPending(): void {
    cancelScheduled();
    if (pendingPaint.size === 0) return;
    lastFlushAt = Date.now();
    const batch = Array.from(pendingPaint.values());
    pendingPaint.clear();
    for (const { record, raw } of batch) {
      if (!record.body) continue;
      // Only assistant Markdown enters the escape-first renderer.
      renderMarkdownInto(record.body, raw);
    }
  }

  function cancelScheduled(): void {
    if (rafHandle !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (fallbackHandle !== null) {
      clearTimeout(fallbackHandle);
      fallbackHandle = null;
    }
    if (throttleHandle !== null) {
      clearTimeout(throttleHandle);
      throttleHandle = null;
    }
  }

  function schedulePaint(record: KeyedRecord, raw: string): void {
    pendingPaint.set(recordKey(record), { record, raw });
    if (rafHandle !== null || fallbackHandle !== null || throttleHandle !== null) return;
    // TASK-CHATUX-W5-2: a flush that would land inside
    // STREAM_PAINT_MIN_INTERVAL_MS of the previous one is deferred through a
    // timeout for the remainder of the window instead of the next frame.
    if (lastFlushAt !== null) {
      const wait = STREAM_PAINT_MIN_INTERVAL_MS - (Date.now() - lastFlushAt);
      if (wait > 0) {
        throttleHandle = setTimeout(() => {
          throttleHandle = null;
          flushPending();
        }, wait);
        return;
      }
    }
    if (typeof requestAnimationFrame === "function") {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        flushPending();
      });
    }
    fallbackHandle = setTimeout(() => {
      fallbackHandle = null;
      flushPending();
    }, STREAM_PAINT_FALLBACK_MS);
  }


  /** Stable identity for the pending map across repaints of one node. */
  const keyOf = new WeakMap<KeyedRecord, string>();
  function recordKey(record: KeyedRecord): string {
    let key = keyOf.get(record);
    if (key === undefined) {
      key = `r${keyOfIds++}`;
      keyOf.set(record, key);
    }
    return key;
  }
  let keyOfIds = 0;

  // ------------------------------------------------------------------
  // Toasts (clipboard round-trip: success polite, failure polite alert)
  // ------------------------------------------------------------------

  function announce(message: string, live: "status" | "alert"): void {
    const region = live === "alert" ? refs.alertLiveRegion : refs.statusLiveRegion;
    if (region) region.textContent = message;
    const toast = el("div", "toast");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = message;
    if (live === "alert") toast.setAttribute("data-level", "error");
    container.appendChild(toast);
    const timer = setTimeout(() => {
      timers.delete(timer);
      toast.remove();
    }, 4000);
    timers.add(timer);
  }

  function copyText(text: string): void {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      // Never a silent catch: report the failure to assistive tech + the user.
      announce(COPY_FAIL_LABEL, "alert");
      return;
    }
    clipboard.writeText(text).then(
      () => announce(COPY_OK_LABEL, "status"),
      () => announce(COPY_FAIL_LABEL, "alert"),
    );
  }

  // ------------------------------------------------------------------
  // Node construction (once per item id)
  // ------------------------------------------------------------------

  function buildActions(
    kind: ChatTranscriptItem["kind"],
    record: KeyedRecord,
    id: string,
  ): HTMLElement {
    const row = el("div", "actions");
    row.setAttribute("role", "group");
    if (kind === "user") {
      const copy = actionButton("copy", "copy", "Copy message");
      copy.addEventListener("click", () => {
        callbacks.onCopyUser?.(id, record.source);
        copyText(record.source);
      });
      const edit = actionButton("edit", "edit", "Edit message");
      edit.addEventListener("click", () => callbacks.onEditUser?.(id, record.source));
      const retry = actionButton("retry", "retry", "Retry message");
      retry.addEventListener("click", () => callbacks.onRetryUser?.(id, record.source));
      row.append(copy, edit, retry);
    } else {
      const copy = actionButton("copy", "copy", "Copy message");
      copy.addEventListener("click", () => {
        callbacks.onCopyAssistant?.(id, record.source);
        copyText(record.source);
      });
      const regenerate = actionButton("regenerate", "retry", "Regenerate response");
      regenerate.addEventListener("click", () => callbacks.onRegenerateAssistant?.(id, record.source));
      row.append(copy, regenerate);
      // Insert SQL exists only for a SQL fence — same node, toggled per render.
      const insert = actionButton("insert-sql", "chevron-right", "Insert SQL into editor");
      insert.addEventListener("click", () => {
        if (record.sql === null) return;
        callbacks.onInsertSql?.(id, record.sql);
      });
      insert.hidden = true;
      row.appendChild(insert);
      const more = actionButton("more", "ellipsis", "More actions");
      more.addEventListener("click", () => callbacks.onMoreAssistant?.(id, record.source, more));
      row.appendChild(more);
    }
    return row;
  }

  function createRecord(item: ChatTranscriptItem): KeyedRecord {
    const root = el("div", "item", `item-${item.kind}`);
    root.setAttribute("data-chat-key", item.id);
    const record: KeyedRecord = {
      root,
      kind: item.kind,
      body: null,
      caret: null,
      actions: null,
      stopped: null,
      buttons: new Map(),
      source: "",
      streaming: false,
      finalized: false,
      sql: null,
      io: null,
      ioIn: null,
      ioOut: null,
      toolToggle: null,
    };

    if (item.kind === "text" || item.kind === "reasoning") {
      if (item.kind === "reasoning") {
        // TASK-CHATUX-003: reasoning mounts as a collapsed disclosure row —
        // the toggle sits above the body and flips data-collapsed on the root.
        const reasoningToggle = disclosureToggle(
          root,
          cls("reasoning-toggle"),
          "Toggle reasoning",
        );
        const reasoningLabel = document.createElement("span");
        reasoningLabel.textContent = "Reasoning";
        reasoningToggle.appendChild(reasoningLabel);
        root.appendChild(reasoningToggle);
      }
      const body = el("div", item.kind === "text" ? "assistant-body" : "reasoning-body");
      body.setAttribute("data-chat-body", "1");
      record.body = body;
      root.appendChild(body);
      const caret = el("span", "caret");
      caret.setAttribute("aria-hidden", "true");
      root.appendChild(caret);
      record.caret = caret;
      const actions = buildActions(item.kind, record, item.id);
      root.appendChild(actions);
      record.actions = actions;
    } else if (item.kind === "tool") {
      // TASK-CHATFIX-003 timeline row: status dot column + content column.
      // The dot is decorative; the bold label carries the tool name and the
      // muted line carries the arg hint / result summary (textContent only).
      const status = el("span", "tool-status");
      status.setAttribute("data-status", "running");
      status.setAttribute("aria-hidden", "true");
      const head = el("div", "tool-head");
      const label = el("span", "tool-label");
      const summary = el("span", "tool-summary");
      const toggle = disclosureToggle(root, cls("tool-toggle"), "Toggle tool output");
      head.append(label, summary, toggle);
      root.append(status, head);
      record.toolToggle = toggle;
    }
    // `user` bubbles are the root node itself; actions + context are children.

    return record;
  }

  // ------------------------------------------------------------------
  // Per-item update
  // ------------------------------------------------------------------

  function update(item: ChatTranscriptItem, record: KeyedRecord): void {
    switch (item.kind) {
      case "user":
        updateUser(item, record);
        return;
      case "text":
      case "reasoning":
        updateText(item, record);
        return;
      case "tool":
        updateTool(item, record);
        return;
      default:
        return;
    }
  }

  function updateUser(item: ChatUserItem, record: KeyedRecord): void {
    record.source = item.text;
    // textContent only — user text never enters the Markdown path.
    // The bubble text is a dedicated child so context chips keep identity.
    const textNode = record.buttons.get("__text__");
    void textNode;
    const current = record.root.querySelector<HTMLElement>(`.${cls("user-text")}`);
    if (current) {
      current.textContent = item.text;
    } else {
      const text = el("div", "user-text");
      text.textContent = item.text;
      record.root.insertBefore(text, record.root.firstChild);
    }
    if (record.actions === null) {
      const actions = buildActions("user", record, item.id);
      record.root.appendChild(actions);
      record.actions = actions;
    }
    // Structured context chips (labels are wire strings -> textContent).
    const existing = record.root.querySelector<HTMLElement>(`.${cls("context-chips")}`);
    if (existing) existing.remove();
    if (item.context.length > 0) {
      const chips = el("div", "context-chips");
      for (const ref of item.context) {
        const chip = el("span", "context-chip");
        chip.textContent = ref.label;
        chips.appendChild(chip);
      }
      record.root.insertBefore(chips, record.actions);
    }
  }

  function updateText(
    item: Extract<ChatTranscriptItem, { kind: "text" | "reasoning" }>,
    record: KeyedRecord,
  ): void {
    const changed = record.source !== item.raw;
    record.source = item.raw;
    record.streaming = item.streaming;

    if (item.streaming && changed) {
      // Coalesce: paint on the next frame (or within 100 ms).
      schedulePaint(record, item.raw);
    } else if (!item.streaming && !record.finalized) {
      // Terminal item: cancel any queued stream paint and paint synchronously.
      pendingPaint.delete(recordKey(record));
      if (record.body) renderMarkdownInto(record.body, item.raw);
      finalize(record);
    } else if (!item.streaming && changed) {
      // A late change to an already-final item still repaints, but never
      // re-finalizes (footer/caret stay single).
      pendingPaint.delete(recordKey(record));
      if (record.body) renderMarkdownInto(record.body, item.raw);
    }

    // Decorative caret: present only while streaming.
    if (record.caret) {
      if (item.streaming) record.caret.removeAttribute("hidden");
      else record.caret.setAttribute("hidden", "1");
    }

    if (record.actions) updateSqlAction(item, record);
  }

  /** Toggle the Insert SQL action against the raw source (not the DOM). */
  function updateSqlAction(
    item: Extract<ChatTranscriptItem, { kind: "text" | "reasoning" }>,
    record: KeyedRecord,
  ): void {
    const insert = record.actions?.querySelector<HTMLButtonElement>('[data-action="insert-sql"]');
    if (!insert) return;
    if (item.kind !== "text") {
      insert.hidden = true;
      record.sql = null;
      return;
    }
    const fences = extractSqlFences(item.raw);
    if (fences.length === 0) {
      insert.hidden = true;
      record.sql = null;
    } else {
      insert.hidden = false;
      record.sql = fences[0]!;
    }
  }

  /** Apply terminal-only decorations exactly once. */
  function finalize(record: KeyedRecord): void {
    if (record.finalized) return;
    record.finalized = true;
    if (record.caret) record.caret.setAttribute("hidden", "1");
  }

  function updateTool(
    item: Extract<ChatTranscriptItem, { kind: "tool" }>,
    record: KeyedRecord,
  ): void {
    record.source = item.summary;
    const label = record.root.querySelector<HTMLElement>(`.${cls("tool-label")}`);
    const status = record.root.querySelector<HTMLElement>(`.${cls("tool-status")}`);
    const summary = record.root.querySelector<HTMLElement>(`.${cls("tool-summary")}`);
    if (label) label.textContent = item.label;
    if (status) status.setAttribute("data-status", item.status);
    if (summary) {
      // TASK-CHATFIX-003: the muted line carries the arg hint when it adds
      // information beyond the bold label; degraded frames (detail === label)
      // and legacy frames fall back to the result summary.
      summary.textContent =
        item.detail !== "" && item.detail !== item.label ? item.detail : item.summary;
    }
    syncToolIo(item, record);
  }

  /** TASK-CHATFIX-003: keep the expandable IN/OUT monospace cards in sync with
   * the item. IN mirrors `item.detail`, OUT mirrors `item.summary`; a card is
   * only mounted while its text is non-empty and non-degenerate, and every
   * wire string enters through `textContent`. */
  function syncToolIo(
    item: Extract<ChatTranscriptItem, { kind: "tool" }>,
    record: KeyedRecord,
  ): void {
    const wantIn = item.detail !== "" && item.detail !== item.label;
    const wantOut = item.summary !== "";
    ensureIoText(record, "in", wantIn, item.detail);
    ensureIoText(record, "out", wantOut, item.summary);
    if (record.toolToggle) {
      record.toolToggle.hidden = record.ioIn === null && record.ioOut === null;
    }
  }

  function ensureIoText(
    record: KeyedRecord,
    which: "in" | "out",
    wanted: boolean,
    text: string,
  ): void {
    const current = which === "in" ? record.ioIn : record.ioOut;
    if (!wanted) {
      if (current !== null) {
        current.parentElement?.remove();
        if (which === "in") record.ioIn = null;
        else record.ioOut = null;
      }
      if (record.ioIn === null && record.ioOut === null && record.io !== null) {
        record.io.remove();
        record.io = null;
      }
      return;
    }
    if (record.io === null) {
      record.io = el("div", "tool-io");
      record.root.appendChild(record.io);
    }
    let node = current;
    if (node === null) {
      const row = el("div", "tool-io-row");
      const tag = el("span", "tool-io-tag");
      tag.textContent = which === "in" ? "IN" : "OUT";
      const textNode = el("pre", "tool-io-text");
      textNode.setAttribute("data-tool-block", which);
      row.append(tag, textNode);
      record.io.appendChild(row);
      node = textNode;
      if (which === "in") record.ioIn = textNode;
      else record.ioOut = textNode;
    }
    node.textContent = text;
    // Fade mask only when the cap actually clips — otherwise short output
    // would lose its last line to the gradient. jsdom reports 0/0 → "0".
    node.setAttribute(
      "data-scrollable",
      node.scrollHeight > node.clientHeight + 1 ? "1" : "0",
    );
  }

  // ------------------------------------------------------------------
  // Ordering / reconciliation
  // ------------------------------------------------------------------

  /** Render one transcript item, creating the node if needed. Returns null when
   * the item must not own a node yet (empty streaming message). */
  function ensureNode(item: ChatTranscriptItem): KeyedRecord | null {
    if (
      (item.kind === "text" || item.kind === "reasoning") &&
      item.streaming &&
      item.raw.length === 0
    ) {
      // Empty delta is ignored: no blank bubble, no caret-only node.
      return null;
    }
    const existing = records.get(item.id);
    const record = existing ?? createRecord(item);
    if (!existing) records.set(item.id, record);
    update(item, record);
    return record;
  }

  function ensureLoadEarlier(visible: boolean): void {
    if (visible && loadEarlier === null) {
      loadEarlier = document.createElement("button");
      loadEarlier.type = "button";
      loadEarlier.className = cls("load-earlier");
      loadEarlier.textContent = LOAD_EARLIER_LABEL;
      loadEarlier.addEventListener("click", () => callbacks.onLoadEarlier?.());
    }
    if (loadEarlier === null) return;
    if (visible) {
      if (loadEarlier.parentNode !== container) container.insertBefore(loadEarlier, container.firstChild);
    } else {
      loadEarlier.remove();
    }
  }

  function render(state: ChatViewState): void {
    if (disposed) return;
    const { transcript } = state;
    const cap = transcript.paging.cap > 0 ? transcript.paging.cap : transcript.renderOrder.length;
    const desired =
      transcript.renderOrder.length > cap
        ? transcript.renderOrder.slice(transcript.renderOrder.length - cap)
        : transcript.renderOrder;

    ensureLoadEarlier(transcript.paging.hasMore);

    const desiredSet = new Set(desired);
    // Remove nodes for ids that left the viewport.
    for (const [id, record] of records) {
      if (!desiredSet.has(id)) {
        pendingPaint.delete(recordKey(record));
        record.root.remove();
        records.delete(id);
      }
    }

    // Reconcile order: walk the desired ids and move only out-of-place nodes.
    let reference: Node | null = loadEarlier;
    for (const id of desired) {
      const item = transcript.entities[id];
      if (item === undefined) continue;
      const record = ensureNode(item);
      if (record === null) {
        // The id is logically present but yields no node yet; drop any stale
        // node for it so a blank bubble cannot linger.
        const stale = records.get(id);
        if (stale) {
          stale.root.remove();
          records.delete(id);
        }
        continue;
      }
      const desiredNext = reference === null ? container.firstChild : reference.nextSibling;
      if (record.root !== desiredNext) container.insertBefore(record.root, desiredNext);
      reference = record.root;
    }

    applyStopped(state);
    syncLiveIndicator(state);
  }

  /** TASK-CHATFIX-003: ONE trailing pulsing indicator while the current turn
   * is still open; removed the moment it closes (or when no turn is live). */
  function syncLiveIndicator(state: ChatViewState): void {
    const live = state.turn !== null && !state.turn.closed;
    if (!live) {
      if (liveNode !== null) {
        liveNode.remove();
        liveNode = null;
      }
      return;
    }
    if (liveNode === null) {
      liveNode = el("div", "live");
      liveNode.setAttribute("aria-hidden", "true");
      const dot = el("span", "live-dot");
      const text = el("span", "live-text");
      text.textContent = LIVE_LABEL;
      liveNode.append(dot, text);
    }
    if (liveNode.parentNode !== container) container.appendChild(liveNode);
  }

  /** One muted `Stopped` footer on the partial assistant message of a stopped
   * turn. Idempotent — a duplicate terminal frame cannot add a second footer. */
  function applyStopped(state: ChatViewState): void {
    const turn = state.turn;
    const stopped = turn !== null && turn.closed && turn.outcome === "stopped";
    for (const [id, record] of records) {
      const item = state.transcript.entities[id];
      const isAssistantText = item !== undefined && item.kind === "text";
      const belongs =
        stopped && item !== undefined && item.kind === "text" && item.turnId === turn.turnId;
      if (belongs && isAssistantText) {
        if (record.stopped === null) {
          const footer = el("div", "stopped");
          footer.textContent = STOPPED_LABEL;
          record.root.appendChild(footer);
          record.stopped = footer;
        }
      } else if (record.stopped !== null) {
        record.stopped.remove();
        record.stopped = null;
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelScheduled();
    pendingPaint.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const record of records.values()) record.root.remove();
    records.clear();
    if (loadEarlier) {
      loadEarlier.remove();
      loadEarlier = null;
    }
    if (liveNode) {
      liveNode.remove();
      liveNode = null;
    }
    for (const toast of Array.from(container.querySelectorAll(`.${cls("toast")}`))) toast.remove();
  }

  return { render, dispose };
}
