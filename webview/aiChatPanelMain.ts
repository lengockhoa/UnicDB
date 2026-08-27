// webview/aiChatPanelMain.ts — TASK-003
// Webview entry cho AiChatPanel — bubbles host messages, minimal input +
// Send / Stop / Clear buttons, minimal markdown rendering (no CDN), and a
// text-only ACP permission request renderer (TEXT RENDERING ONLY — never
// innerHTML or any markdown interpreter for untrusted host text).
//
// SECURITY: webview only ever POSTS send/stop/clear/permission_response to
// host. It NEVER receives apiKey material. Permission requests carry a
// host-generated opaque requestId + opaque optionIds; the webview echoes
// them verbatim or denies (no optionId field on the wire). The webview
// yields AT MOST ONE response per visible request.

import { highlightSql } from "./sqlHighlight";

declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

// ---- Host → Webview message shapes (mirror aiChatPanelMessages.ts) ---------
interface InitMsg {
  type: "init";
  hasHistory: boolean;
}
interface StepMsg {
  type: "step";
  label: string;
}
interface AssistantMsg {
  type: "assistant";
  text: string;
  markdown: boolean;
}
interface ErrorMsg {
  type: "error";
  message: string;
}
interface DoneMsg {
  type: "done";
}
/** Incremental assistant text from omp streaming — appended to the current
 assistant bubble in real time. */
interface DeltaMsg {
  type: "delta";
  text: string;
}
/** Engine mode announcement — emitted on first ready (and on crash fallback). */
interface EngineMsg {
  type: "engine";
  name: "omp" | "builtin";
  hint?: string;
  version?: string;
}
/** ACP permission request — host-generated opaque requestId, opaque optionIds,
 * and tool name/detail that MUST be rendered as plain text only. */
interface PermissionRequestMsg {
  type: "permission_request";
  requestId: string;
  tool: { id: string; name: string; detail: string };
  options: Array<{ optionId: string; label: string }>;
}
/** Host answer for `resume_list` — ≤20 cwd-filtered rows, current session
 * removed. `sessionId` is opaque to the webview (echoed verbatim on pick). */
interface ResumeSessionsMsg {
  type: "resume_sessions";
  sessions: Array<{ sessionId: string; label: string; detail: string }>;
}
/** Host replay of the picked session — capped at HISTORY_RENDER_CAP. Only
 * `kind:"user"|"assistant"|"tool"` items are rendered; anything else is
 * silently dropped (host already filtered `agent_thought_chunk`). */
/** TASK-001: live piece of the agent's reasoning chain, forwarded verbatim
 * from ACP `agent_thought_chunk`. Never carries apiKey. The webview renders
 * these into a single collapsible "Thinking" block per turn (chunks append
 * to the same body; resets on the next user send). Replay history
 * (`HistoryMsg`) still silently drops `agent_thought_chunk` — only the live
 * `thought` message kind is rendered. */
interface ThoughtMsg {
  type: "thought";
  text: string;
}
interface HistoryMsg {
  type: "history";
  items: Array<{ kind: string; text: string }>;
  truncated: boolean;
  truncatedCount: number;
}
 type HostMsg =
  | InitMsg
  | StepMsg
  | AssistantMsg
  | ErrorMsg
  | DoneMsg
  | DeltaMsg
  | EngineMsg
  | PermissionRequestMsg
  | ResumeSessionsMsg
  | HistoryMsg
  | ThoughtMsg;

// ---- State -----------------------------------------------------------------
interface State {
  busy: boolean;
  hasHistory: boolean;
}
const state: State = { busy: false, hasHistory: false };

const root = document.getElementById("vsdb-root") as HTMLDivElement;

// ---- vscode bridge ---------------------------------------------------------
function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

/**
 * Minimal markdown — only what the agent is expected to emit:
 *  - ## / ### headings
 *  - fenced code ```…```
 *  - inline `code`
 *  - **bold**
 *  - line breaks (blank line → new paragraph)
 * Returns HTML with all user content escaped first, then markdown syntax
 * re-introduced through the controlled replacement set above.
 *
 * for permission tool/option labels.
 */
function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  // Fenced blocks: capture each (lang, escaped-code) pair into a parallel
  // array, replace with an opaque placeholder, then re-substitute the
  // final HTML (with a data-raw attribute holding the un-escaped code so
  // the Copy button can grab it later without re-parsing). Double-escape
  // on the attribute is intentional: the browser decodes the HTML entities
  // once, leaving the original escaped form in the attribute — we then
  // un-escape at click time to recover the raw code.
  const fences: Array<{ lang: string; code: string }> = [];
  let html = escaped.replace(
    /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const idx = fences.length;
      fences.push({ lang, code: code.replace(/\n$/, "") });
      return `\u0000FENCE${idx}\u0000`;
    },
  );
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const blocks = html.split(/\n{2,}/);
  const joined = blocks
    .map((b) => (b.startsWith("<") ? b : `<p>${b.replace(/\n/g, "<br>")}</p>`))
    .join("\n");
  return joined.replace(
    /\u0000FENCE(\d+)\u0000/g,
    (_m, idxStr: string) => {
      const idx = Number(idxStr);
      const f = fences[idx]!;
      // data-raw carries the ORIGINAL escaped code so the click handler
      // can grab it via getAttribute and un-escape to recover the raw
      // string the user wants to copy.
      return `<pre class="vsdb-md-code" data-raw="${escapeHtml(f.code)}"><code class="vsdb-md-code-lang-${escapeHtml(f.lang)}">${f.code}</code><button type="button" class="vsdb-md-copy">Copy</button></pre>`;
    },
  );
}
function setBusy(busy: boolean): void {
  state.busy = busy;
  const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement | null;
  const resumeBtn = document.getElementById("resumeBtn") as HTMLButtonElement | null;
  const regenBtn = document.getElementById("regenerateBtn") as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = busy;
  // stopBtn is always clickable — host ignores stop when no agent is in flight.
  if (stopBtn) stopBtn.disabled = false;
  if (resumeBtn) resumeBtn.disabled = busy;
  if (regenBtn) regenBtn.disabled = busy;
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (prompt) prompt.disabled = busy;
}
function renderInitial(): void {
  root.innerHTML = `
  <div class="vsdb-chat-thread" id="thread" aria-live="polite"></div>
  <button type="button" id="jumpLatest" class="vsdb-chat-jump" hidden>Jump to latest</button>
  <div class="vsdb-chat-input">
    <textarea id="prompt" rows="3" placeholder="Ask about your database…"></textarea>
    <div class="vsdb-chat-actions">
      <button id="resumeBtn" class="vsdb-chat-secondary">Resume session</button>
      <button id="clearBtn">Clear</button>
      <button id="regenerateBtn" class="vsdb-chat-secondary" title="Regenerate last response">Regenerate</button>
      <button id="stopBtn" class="vsdb-chat-secondary">Stop</button>
      <button id="sendBtn" class="vsdb-chat-primary">Send</button>
    </div>
  </div>`;
  wireControls();
  wireJumpLatest();
}
function wireControls(): void {
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement | null;
  const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement | null;

  // Send: echo the user prompt as a bubble (UI responsiveness), then post
  // send + clear. Single handler so the bubble and the wire post stay in
  // lockstep — the previous capture-then-bubble split was fragile under
  // jsdom's dispatch order.
  sendBtn?.addEventListener("click", () => {
    if (!prompt) return;
    const text = prompt.value;
    if (text.trim().length === 0) return;
    appendUser(text);
    post({ type: "send", text });
    setBusy(true);
    prompt.value = "";
  });
  stopBtn?.addEventListener("click", () => {
    post({ type: "stop" });
  });

  const resumeBtn = document.getElementById("resumeBtn") as HTMLButtonElement | null;
  resumeBtn?.addEventListener("click", () => {
    if (state.busy) return;
    post({ type: "resume_list" });
  });

  // Regenerate: host pops the trailing history pair and re-runs the last
  // user prompt (semantics in PLAN §3). Disabled while busy — the button
  // reflects `state.busy` via setBusy.
  const regenBtn = document.getElementById("regenerateBtn") as HTMLButtonElement | null;
  regenBtn?.addEventListener("click", () => {
    if (state.busy) return;
    post({ type: "regenerate" });
  });

  // Clear: immediately wipe the local thread (UI responsiveness) and tell
  // host to reset. Host replies with init{hasHistory:false}+done; applyInit
  // re-enables the input + de-streams any orphaned bubble. The local wipe
  // is best-effort UX — applyInit is the authoritative reset.
  clearBtn?.addEventListener("click", () => {
    post({ type: "clear" });
    const thread = document.getElementById("thread");
    if (thread) thread.innerHTML = "";
  });

  // Enter (no shift) sends + clears; Shift+Enter falls through (browser
  // default inserts newline). Plain Enter NEVER inserts a newline in the
  // chat composer. Legacy Ctrl/Cmd+Enter was retired (TASK-002 #9) —
  // holding a modifier + Enter lets the browser do its default thing
  // (e.g. type a literal newline on macOS via Cmd+Enter shortcuts).
  prompt?.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter") return;
    if (ev.shiftKey) return;
    if (ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    sendBtn?.click();
  });
}

function appendUser(text: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-bubble vsdb-chat-user vsdb-chat-queued";
  div.textContent = text;
  // Queued marker — child element with the same class so test #8 can find
  // it via both classList and a descendant selector. Resolved by
  // resolveQueuedUserBubble() on first delta/error/done.
  const queued = document.createElement("span");
  queued.className = "vsdb-chat-queued";
  queued.setAttribute("aria-label", "queued");
  div.appendChild(queued);
  thread.appendChild(div);
  autoScroll(div);
  // New turn: reset the per-turn thinking block so the next `thought`
  // message re-creates it (default collapsed + empty).
  resetThinkingBlock();
}

/** Resolve the queued marker on the latest user bubble (the just-sent
 * prompt). Called on first delta / error / done so the placeholder is
 * never left spinning on a settled turn. No-op if there's no queued
 * bubble (e.g. error before any user bubble). */
function resolveQueuedUserBubble(): void {
  const queued = root.querySelector(
    ".vsdb-chat-bubble.vsdb-chat-user.vsdb-chat-queued",
  ) as HTMLDivElement | null;
  if (!queued) return;
  queued.classList.remove("vsdb-chat-queued");
  for (const m of Array.from(
    queued.querySelectorAll(".vsdb-chat-queued"),
  )) m.remove();
}

function appendStep(label: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const step = document.createElement("div");
  step.className = "vsdb-chat-step";
  step.textContent = `→ ${label}`;
  thread.appendChild(step);
}

function appendAssistant(text: string, markdown: boolean): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-bubble vsdb-chat-assistant";
  // TASK-003: colorize SQL fenced blocks AFTER the escaped HTML is in place.
  // renderMarkdown escapes user text first; reading `textContent` off the
  // already-escaped <code> node decodes entities back to the raw SQL, and
  // highlightSql writes a fragment built with createElement + textContent
  // only — preserving the no-innerHTML-for-user-content contract (hostile
  // agent output never reaches the page as live nodes).
  div.innerHTML = markdown ? renderMarkdown(text) : escapeHtml(text);
  if (markdown) {
    for (const code of Array.from(
      div.querySelectorAll<HTMLElement>("code.vsdb-md-code-lang-sql"),
    )) {
      const frag = highlightSql(code.textContent ?? "");
      code.replaceChildren(frag);
    }
  }
  // Wire the per-block Copy buttons + append a copy-message action.
  wireCopyButtons(div);
  appendCopyMessageAction(div, text);
  thread.appendChild(div);
  autoScroll(div);
}

function appendError(message: string): void {
  // Honest error label: drops the queued marker on the just-sent user
  // bubble (so the placeholder never lingers past the turn's settlement)
  // and renders the error in its own bubble.
  resolveQueuedUserBubble();
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-bubble vsdb-chat-error";
  div.textContent = message;
  thread.appendChild(div);
  autoScroll(div);
}

/** Append an incremental text fragment to the current assistant bubble.
 * If no assistant bubble is open, create one. Used for omp streaming —
 * the host posts `{type:"delta",text}` and the final assistant message
 * then arrives when the turn ends.
 */
function appendDelta(text: string): void {
  // First delta of the turn resolves the queued user placeholder.
  resolveQueuedUserBubble();
  const thread = document.getElementById("thread");
  if (!thread) return;
  let bubble = thread.querySelector<HTMLDivElement>(
    ".vsdb-chat-bubble.vsdb-chat-assistant.vsdb-chat-streaming",
  );
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className =
      "vsdb-chat-bubble vsdb-chat-assistant vsdb-chat-streaming";
    thread.appendChild(bubble);
  }
  // Streaming content is plain text; full markdown render happens on the
  // terminal assistant message. Append the escaped fragment and add the
  // streaming caret so the user sees the bubble is still receiving text.
  bubble.appendChild(document.createTextNode(text));
  ensureStreamingCaret(bubble);
  autoScroll(bubble);
}

/** F4 regression helper — strip the streaming class from any open bubble
 * so the NEXT delta opens a fresh bubble instead of appending into an
 * orphaned one (causes text bleed across turns when the user stops mid-
 * stream and starts a new turn without an `assistant` arrival). The bubble
 * itself is kept so the user still sees whatever streamed before the stop
 * (matches T3.2 — preserve partial text on stop). */
function deStreamOpenBubble(): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const open = thread.querySelectorAll<HTMLDivElement>(
    ".vsdb-chat-bubble.vsdb-chat-assistant.vsdb-chat-streaming",
  );
  for (const bubble of Array.from(open)) {
    bubble.classList.remove("vsdb-chat-streaming");
    const caret = bubble.querySelector(".vsdb-chat-caret");
    if (caret) caret.remove();
  }
}

// ---- TASK-002 — scroll discipline, jump-to-latest, thinking block --------
//
// Scroll discipline: only auto-scroll when the user is already near the
// bottom of the thread (within 40px). Otherwise show a floating
// #jumpLatest button that, when clicked, scrolls to bottom and hides.

/** Threshold in CSS pixels for "near bottom" detection. */
const SCROLL_BOTTOM_THRESHOLD_PX = 40;

/** Update scroll + jump-to-latest visibility based on the current
 * scrollTop relative to the thread. Auto-scroll only when within
 * SCROLL_BOTTOM_THRESHOLD_PX of the bottom; otherwise surface the
 * #jumpLatest button without scrolling. The `_appendedNode` argument is
 * informational — we scroll the thread, not the new node — but it lets
 * callers pass through the just-appended element for symmetry with
 * future per-node scroll logic. */
function autoScroll(_appendedNode?: HTMLElement): void {
  const thread = document.getElementById("thread") as HTMLDivElement | null;
  if (!thread) return;
  const jump = document.getElementById("jumpLatest") as HTMLButtonElement | null;
  const distanceFromBottom =
    thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  if (distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX) {
    thread.scrollTop = thread.scrollHeight - thread.clientHeight;
    if (jump) jump.hidden = true;
  } else {
    if (jump) jump.hidden = false;
  }
}

/** Wire the floating #jumpLatest button to scroll to bottom + hide. */
function wireJumpLatest(): void {
  const jump = document.getElementById("jumpLatest") as HTMLButtonElement | null;
  jump.addEventListener("click", () => {
    const thread = document.getElementById("thread") as HTMLDivElement | null;
    if (thread) thread.scrollTop = thread.scrollHeight - thread.clientHeight;
    jump.hidden = true;
  });
}

/** Attach the streaming caret (`▍` glyph) to an open streaming bubble.
 * Idempotent — the bubble only carries one caret at a time. The caret is
 * removed when the bubble is de-streamed (done/error). */
function ensureStreamingCaret(bubble: HTMLDivElement): void {
  if (bubble.querySelector(".vsdb-chat-caret")) return;
  const caret = document.createElement("span");
  caret.className = "vsdb-chat-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "\u258D"; // �
  bubble.appendChild(caret);
}

// ---- Thinking block state (TASK-002 #1, #2) ------------------------------
//
// One collapsible #thinkingBlock per turn. Default collapsed. Chunks
// append to its body across `thought` messages; state (open/closed)
// survives chunk appends; `resetThinkingBlock` on next user send drops
// it so the new turn starts fresh.
let thinkingBlock: HTMLDetailsElement | null = null;
let thinkingBody: HTMLDivElement | null = null;

/** Render a `thought` chunk into the per-turn thinking block. Lazily
 * creates the <details> + <summary> + body on the first chunk of a turn.
 * Default collapsed; the open/closed state survives chunk appends. */
function applyThought(text: string): void {
  if (text.length === 0) return;
  if (!thinkingBlock) {
    const details = document.createElement("details");
    details.className = "vsdb-chat-thinking";
    details.id = "thinkingBlock";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "vsdb-chat-thinking-body";
    details.appendChild(body);
    const thread = document.getElementById("thread");
    if (thread) thread.appendChild(details);
    thinkingBlock = details;
    thinkingBody = body;
  }
  if (thinkingBody) {
    thinkingBody.appendChild(document.createTextNode(text));
  }
  // Note: we deliberately do NOT auto-scroll on every thought chunk
  // (it would yank the user around as reasoning streams). The next
  // delta / assistant message still applies the scroll discipline.
}

/** Drop the per-turn thinking block. Called when the user starts a new
 * turn so the next `thought` message re-creates the block from scratch
 * (default collapsed + empty). */
function resetThinkingBlock(): void {
  if (thinkingBlock && thinkingBlock.parentNode) {
    thinkingBlock.parentNode.removeChild(thinkingBlock);
  }
  thinkingBlock = null;
  thinkingBody = null;
}

// ---- Copy affordances (TASK-002 #4, #5, #6) ------------------------------
//
// Per-block Copy buttons get their raw code via the data-raw attribute
// set by renderMarkdown. The button click un-escapes the attribute value
// to recover the original code, then calls navigator.clipboard.writeText
// with a silent .catch — clipboard rejection degrades silently.

/** Reverse the HTML escape table from escapeHtml for the data-raw attribute. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Wire all `.vsdb-md-copy` buttons inside a bubble root so a click
 * copies the raw code (data-raw attribute, un-escaped) via clipboard. */
function wireCopyButtons(rootEl: HTMLElement): void {
  for (const btn of Array.from(
    rootEl.querySelectorAll<HTMLButtonElement>(".vsdb-md-copy"),
  )) {
    btn.addEventListener("click", () => {
      const pre = btn.closest("pre");
      if (!pre) return;
      const raw = pre.getAttribute("data-raw") ?? "";
      const code = unescapeHtml(raw);
      void navigator.clipboard?.writeText(code).catch(() => {
        // Silent degrade — keep the button label so the user can retry.
      });
    });
  }
}

/** Append a copy-message action button to an assistant bubble. The
 * button copies the raw markdown source (the un-rendered agent text)
 * so the user can paste the whole reply into another tool. */
function appendCopyMessageAction(bubble: HTMLElement, rawSource: string): void {
  const action = document.createElement("button");
  action.type = "button";
  action.className = "vsdb-chat-copy-msg";
  action.textContent = "Copy";
  action.title = "Copy message";
  action.addEventListener("click", () => {
    void navigator.clipboard?.writeText(rawSource).catch(() => {
      // Silent degrade.
    });
  });
  bubble.appendChild(action);
}

/** Show / replace the engine banner (omp active, or builtin fallback with hint). */
function applyEngine(msg: EngineMsg): void {
  const root = document.getElementById("vsdb-root");
  if (!root) return;
  let banner = document.getElementById("engineBanner");
  if (banner) banner.remove();
  banner = document.createElement("div");
  banner.id = "engineBanner";
  banner.className = `vsdb-chat-engine vsdb-chat-engine-${msg.name}`;
  const label =
    msg.name === "omp"
      ? msg.version
        ? `Engine: oh-my-pi (omp) v${msg.version} — streaming`
        : "Engine: oh-my-pi (omp) — streaming"
      : msg.hint
        ? `Engine: builtin — ${msg.hint} — streaming`
        : `Engine: builtin — streaming`;
  banner.textContent = label;
  // Insert at the top of the thread (before any chat bubbles).
  const thread = document.getElementById("thread");
  if (thread && thread.parentNode === root) {
    root.insertBefore(banner, thread);
  } else {
    root.prepend(banner);
  }
}

function applyInit(msg: InitMsg): void {
  state.hasHistory = msg.hasHistory;
  // init{hasHistory:false} đến sau khi panel từng busy (Clear path) →
  // chắc chắn re-enable input + đóng streaming bubble. Host cũng post
  // done, nhưng done một mình không de-stream nếu panel replay init.
  if (!msg.hasHistory) {
    deStreamOpenBubble();
    setBusy(false);
  }
}

// ---- Permission request rendering (text-only) -----------------------------

/** Host-generated request IDs that the webview is currently holding open.
 * A request leaves the set exactly once — when the user picks Allow, picks
 * Deny, the host replaces the request, or the panel is reset. Late / duplicate
 * / replaced IDs find no membership and emit no second response. */
const pendingPermissionRequests = new Set<string>();

/** Minimal CSS.escape polyfill (jsdom doesn't ship one). */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Get the DOM element backing a pending permission request by its host ID. */
function permissionCard(requestId: string): HTMLDivElement | null {
  const thread = document.getElementById("thread");
  if (!thread) return null;
  return thread.querySelector<HTMLDivElement>(
    `.vsdb-chat-permission[data-request-id="${cssEscape(requestId)}"]`,
  );
}
/** Threshold above which the detail collapses into a <details><pre> block.
 * Single-line + <= threshold → plain div, otherwise collapsible. */
const PERMISSION_DETAIL_COLLAPSE_THRESHOLD = 120;

/** Build the detail DOM node for a permission card. Short single-line → a
 * plain div; longer or multi-line → a collapsible `<details><summary>Show
 * tool details</summary><pre>`. Empty → null (caller omits the node).
 * textContent only — no innerHTML. */
function permissionDetailNode(
  detail: string,
): HTMLDivElement | HTMLDetailsElement | null {
  if (detail.length === 0) return null;
  const isShort =
    detail.length <= PERMISSION_DETAIL_COLLAPSE_THRESHOLD &&
    !detail.includes("\n");
  if (isShort) {
    const div = document.createElement("div");
    div.className = "vsdb-chat-permission-tool-detail";
    div.textContent = detail;
    return div;
  }
  const details = document.createElement("details");
  details.className = "vsdb-chat-permission-tool-detail";
  const summary = document.createElement("summary");
  summary.textContent = "Show tool details";
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.textContent = detail;
  details.appendChild(pre);
  return details;
}

/** Render one host permission request. Every label / detail / option is
 * rendered via DOM text nodes (element.textContent) — never innerHTML, never
 * a markdown interpreter. The card is keyed by the opaque requestId so we can
 * find and dispose it later. */
function renderPermissionRequest(msg: PermissionRequestMsg): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  // If the host reuses an in-flight ID, dispose the previous card so we emit
  // no double response for the same request.
  const existing = permissionCard(msg.requestId);
  if (existing) {
    disposePermissionCard(existing, false);
  }
  const card = document.createElement("div");
  card.className = "vsdb-chat-permission";
  card.dataset.requestId = msg.requestId;

  const header = document.createElement("div");
  header.className = "vsdb-chat-permission-header";
  header.textContent = "Permission required";
  card.appendChild(header);

  const toolId = document.createElement("div");
  toolId.className = "vsdb-chat-permission-tool-id";
  toolId.textContent = msg.tool.id;
  card.appendChild(toolId);

  const toolName = document.createElement("div");
  toolName.className = "vsdb-chat-permission-tool-name";
  toolName.textContent = msg.tool.name;
  card.appendChild(toolName);

  // Detail rendering: short single-line → plain div; long → collapsible
  // <details><summary>…</summary><pre>; empty → omit node. textContent only.
  const detailNode = permissionDetailNode(msg.tool.detail);
  if (detailNode !== null) card.appendChild(detailNode);

  const actions = document.createElement("div");
  actions.className = "vsdb-chat-permission-actions";
  for (const opt of msg.options) {
    const btn = document.createElement("button");
    btn.className =
      opt.optionId === "deny"
        ? "vsdb-chat-secondary vsdb-chat-permission-deny"
        : "vsdb-chat-primary vsdb-chat-permission-allow";
    btn.textContent = opt.label;
    btn.dataset.optionId = opt.optionId;
    btn.addEventListener("click", () => {
      if (!pendingPermissionRequests.has(msg.requestId)) return;
      pendingPermissionRequests.delete(msg.requestId);
      const wire: { type: "permission_response"; requestId: string; optionId?: string } = {
        type: "permission_response",
        requestId: msg.requestId,
      };
      if (opt.optionId !== "deny") wire.optionId = opt.optionId;
      post(wire);
      card.remove();
    });
    actions.appendChild(btn);
  }
  card.appendChild(actions);
  pendingPermissionRequests.add(msg.requestId);
  thread.appendChild(card);
  thread.scrollTop = thread.scrollHeight;
}

/** Tear down a card without emitting any response (used for host-driven
 * replacement and panel reset). */
function disposePermissionCard(
  card: HTMLDivElement,
  emitDeny: boolean,
): void {
  const requestId = card.dataset.requestId;
  if (!requestId) {
    card.remove();
    return;
  }
  if (pendingPermissionRequests.has(requestId)) {
    pendingPermissionRequests.delete(requestId);
    if (emitDeny) {
      post({ type: "permission_response", requestId });
    }
  }
  card.remove();
}

// ---- Resume picker + history batch rendering (TASK-004) -------------------
//
// SECURITY: the picker renders every label / detail via DOM text nodes
// (element.textContent) — never innerHTML, never a markdown interpreter.
// `sessionId` is echoed verbatim on pick; the webview never invents or
// rewrites IDs. The history renderer only knows about user/assistant/tool
// items; any other `kind` is silently dropped (host already filtered
// `agent_thought_chunk` — the webview has no branch that renders thoughts).

/** Open picker state — exactly one row pick yields exactly one resume_pick. */
let pickerOpen = false;
/** Once the user picked a session we close the picker locally to guarantee no
 * second resume_pick can fire if a stale row is clicked again. */
let pickerConsumed = false;

/** Render the host-supplied session list as text-only rows inside a picker
 * card. Replaces any prior open picker. */
function renderResumePicker(msg: ResumeSessionsMsg): void {
  disposeResumePicker();
  pickerOpen = true;
  pickerConsumed = false;

  const thread = document.getElementById("thread");
  if (!thread) return;

  const card = document.createElement("div");
  card.className = "vsdb-chat-resume-picker";

  const header = document.createElement("div");
  header.className = "vsdb-chat-resume-header";
  header.textContent = "Resume a previous session";
  card.appendChild(header);

  for (const s of msg.sessions) {
    const row = document.createElement("div");
    row.className = "vsdb-chat-resume-row";
    row.dataset.sessionId = s.sessionId;

    const label = document.createElement("div");
    label.className = "vsdb-chat-resume-row-label";
    label.textContent = s.label;
    row.appendChild(label);

    const detail = document.createElement("div");
    detail.className = "vsdb-chat-resume-row-detail";
    detail.textContent = s.detail;
    row.appendChild(detail);

    row.addEventListener("click", () => {
      if (!pickerOpen || pickerConsumed) return;
      pickerConsumed = true;
      // Verbatim echo — never synthesize / rewrite the sessionId.
      post({ type: "resume_pick", sessionId: s.sessionId });
      disposeResumePicker();
    });
    card.appendChild(row);
  }

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "vsdb-chat-secondary vsdb-chat-resume-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    if (!pickerOpen) return;
    post({ type: "resume_cancel" });
    disposeResumePicker();
  });
  card.appendChild(cancelBtn);

  // Esc dismisses the picker — single resume_cancel + tear-down. Listener
  // is bound to the card so it dies with the card (no stale Esc handling
  // after the picker is closed).
  card.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    if (!pickerOpen) return;
    post({ type: "resume_cancel" });
    disposeResumePicker();
  });
  // Make the card focusable so it can receive the keydown event when the
  // user clicks anywhere inside it.
  card.tabIndex = -1;
  // Focus the card so an immediate Esc dismisses without requiring a click.
  // setTimeout defers focus until after the click that opened the picker
  // releases focus, avoiding a focus fight.
  setTimeout(() => card.focus(), 0);
  thread.appendChild(card);
}

/** Tear down the open picker without emitting any further messages. */
function disposeResumePicker(): void {
  pickerOpen = false;
  pickerConsumed = false;
  const existing = document.querySelector(".vsdb-chat-resume-picker");
  if (existing) existing.remove();
}

/** Render the host's replay-derived history batch in the original order.
 * user items → plain text bubble; assistant items → existing markdown
 * renderer (only safe path for any markdown); tool items → one-line
 * collapsed row. Anything else is silently skipped. If `truncated` is set,
 * a single notice line using `truncatedCount` is placed ABOVE the items. */
function renderHistory(msg: HistoryMsg): void {
  const thread = document.getElementById("thread");
  if (!thread) return;

  if (msg.truncated && msg.truncatedCount > 0) {
    const notice = document.createElement("div");
    notice.className = "vsdb-chat-history-truncated";
    notice.textContent = `${msg.truncatedCount} earlier items not shown`;
    thread.appendChild(notice);
  }

  for (const item of msg.items) {
    if (item.kind === "user") {
      appendUser(item.text);
    } else if (item.kind === "assistant") {
      appendAssistant(item.text, true);
    } else if (item.kind === "tool") {
      const row = document.createElement("div");
      row.className = "vsdb-chat-history-tool";
      row.textContent = item.text;
      thread.appendChild(row);
    }
    // Any other kind (host shouldn't ship thought/skip — silently dropped).
  }
  thread.scrollTop = thread.scrollHeight;
}

// ---- Wire host messages ----------------------------------------------------
 window.addEventListener("message", (ev: MessageEvent) => {
   const msg = ev.data as HostMsg;
   switch (msg.type) {
    case "init":
      applyInit(msg);
      return;
    case "step":
      appendStep(msg.label);
      return;
    case "delta":
      appendDelta(msg.text);
      return;
    case "engine":
      applyEngine(msg);
      return;
    case "assistant":
      // Final assistant message: replace any open streaming bubble with a
      // rendered markdown version. If no streaming bubble exists, render a
      // new one (builtin path).
      {
        const thread = document.getElementById("thread");
        const streaming = thread?.querySelector(
          ".vsdb-chat-bubble.vsdb-chat-assistant.vsdb-chat-streaming",
        );
        if (streaming) streaming.remove();
      }
      appendAssistant(msg.text, msg.markdown);
      return;
    case "error":
      appendError(msg.message);
      deStreamOpenBubble();
      // Error also resolves the queued user placeholder — an endless
      // "queued" marker after a failure is dishonest state (PLAN §4).
      resolveQueuedUserBubble();
      return;
    case "done":
      // De-stream so the NEXT turn's delta opens a fresh bubble instead
      // of appending into a left-open streaming bubble (F4 regression).
      deStreamOpenBubble();
      // First done of the turn resolves the queued user placeholder.
      resolveQueuedUserBubble();
      // Re-enable input/actions (Send, Regenerate, Resume, textarea).
      setBusy(false);
      // The thinking block stays visible after `done` — it summarizes
      // the just-finished turn's reasoning for the user. The next user
      // send drops it via appendUser -> resetThinkingBlock.
      return;
    case "thought":
      applyThought(msg.text);
      return;
    case "permission_request":
      renderPermissionRequest(msg);
      return;
    case "resume_sessions":
      renderResumePicker(msg);
      return;
    case "history":
      renderHistory(msg);
      return;
  }
});

// ---- Boot ------------------------------------------------------------------
renderInitial();
post({ type: "ready" });
