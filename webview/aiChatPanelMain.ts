// webview/aiChatPanelMain.ts — TASK-003
// Webview entry cho AiChatPanel — bubbles host messages, minimal input +
// Send / Stop / Clear buttons, minimal markdown rendering (no CDN).
//
// SECURITY: webview only ever POSTS send/stop/clear to host. It NEVER
// receives apiKey material.

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
type HostMsg =
  | InitMsg
  | StepMsg
  | AssistantMsg
  | ErrorMsg
  | DoneMsg
  | DeltaMsg
  | EngineMsg;

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
  if (sendBtn) sendBtn.disabled = busy;
  // stopBtn is always clickable — host ignores stop when no agent is in flight.
  if (stopBtn) stopBtn.disabled = false;
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (prompt) prompt.disabled = busy;
}

function renderInitial(): void {
  root.innerHTML = `
  <div class="vsdb-chat-thread" id="thread" aria-live="polite"></div>
  <div class="vsdb-chat-input">
    <textarea id="prompt" rows="3" placeholder="Ask about your database…"></textarea>
    <div class="vsdb-chat-actions">
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
      : `Engine: builtin${msg.hint ? ` — ${msg.hint}` : ""}`;
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
      return;
    case "done":
      setBusy(false);
      return;
  }
});

// ---- Boot ------------------------------------------------------------------
renderInitial();
post({ type: "ready" });
