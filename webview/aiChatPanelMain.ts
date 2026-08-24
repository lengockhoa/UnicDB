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
  | HistoryMsg;

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
 * NOTE: this is ONLY used for the agent's own assistant bubble — never
 * for permission tool/option labels.
 */
function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  let html = escaped.replace(
    /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      return `<pre class="vsdb-md-code"><code class="vsdb-md-code-lang-${escapeHtml(lang)}">${code}</code></pre>`;
    },
  );
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const blocks = html.split(/\n{2,}/);
  return blocks
    .map((b) => (b.startsWith("<") ? b : `<p>${b.replace(/\n/g, "<br>")}</p>`))
    .join("\n");
}

// ---- Rendering -------------------------------------------------------------

function setBusy(busy: boolean): void {
  state.busy = busy;
  const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement | null;
  const resumeBtn = document.getElementById("resumeBtn") as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = busy;
  // stopBtn is always clickable — host ignores stop when no agent is in flight.
  if (stopBtn) stopBtn.disabled = false;
  if (resumeBtn) resumeBtn.disabled = busy;
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (prompt) prompt.disabled = busy;
}

function renderInitial(): void {
  root.innerHTML = `
  <div class="vsdb-chat-thread" id="thread" aria-live="polite"></div>
  <div class="vsdb-chat-input">
    <textarea id="prompt" rows="3" placeholder="Ask about your database…"></textarea>
    <div class="vsdb-chat-actions">
      <button id="resumeBtn" class="vsdb-chat-secondary">Resume session</button>
      <button id="clearBtn">Clear</button>
      <button id="stopBtn" class="vsdb-chat-secondary">Stop</button>
      <button id="sendBtn" class="vsdb-chat-primary">Send</button>
    </div>
  </div>`;
  wireControls();
}

function wireControls(): void {
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement | null;
  const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement | null;

  // Echo the user's just-typed prompt as a user bubble before clearing the
  // field. Capture-phase so it runs BEFORE the sendBtn click handler clears it.
  sendBtn?.addEventListener(
    "click",
    () => {
      if (!prompt) return;
      const snap = prompt.value;
      if (snap.trim().length > 0) appendUser(snap);
    },
    true,
  );

  sendBtn?.addEventListener("click", () => {
    if (!prompt) return;
    const text = prompt.value;
    if (text.trim().length === 0) return;
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

  // Clear: immediately wipe the local thread (UI responsiveness) and tell
  // host to reset. Host replies with init{hasHistory:false}+done; applyInit
  // re-enables the input + de-streams any orphaned bubble. The local wipe
  // is best-effort UX — applyInit is the authoritative reset.
  clearBtn?.addEventListener("click", () => {
    post({ type: "clear" });
    const thread = document.getElementById("thread");
    if (thread) thread.innerHTML = "";
  });

  // Ctrl/Cmd+Enter sends.
  prompt?.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      ev.preventDefault();
      sendBtn?.click();
    }
  });
}

function appendUser(text: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-bubble vsdb-chat-user";
  div.textContent = text;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

function appendStep(label: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-step";
  div.textContent = `→ ${label}`;
  thread.appendChild(div);
}

function appendAssistant(text: string, markdown: boolean): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-bubble vsdb-chat-assistant";
  div.innerHTML = markdown ? renderMarkdown(text) : escapeHtml(text);
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

function appendError(message: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-bubble vsdb-chat-error";
  div.textContent = message;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

/** Append an incremental text fragment to the current assistant bubble.
 * If no assistant bubble is open, create one. Used for omp streaming —
 * the host posts `{type:"delta",text}` and the final assistant message
 * then arrives when the turn ends.
 */
function appendDelta(text: string): void {
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
  // terminal assistant message. Append the escaped fragment and scroll.
  bubble.appendChild(document.createTextNode(text));
  thread.scrollTop = thread.scrollHeight;
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
  }
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
      ? "Engine: oh-my-pi (omp) — streaming"
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

  thread.appendChild(card);
  thread.scrollTop = thread.scrollHeight;
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
      return;
    case "done":
      // De-stream so the NEXT turn's delta opens a fresh bubble instead
      // of appending into a left-open streaming bubble (F4 regression).
      deStreamOpenBubble();
      setBusy(false);
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
