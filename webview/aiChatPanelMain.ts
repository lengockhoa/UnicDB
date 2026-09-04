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
import {
  ATTACH_ALLOWED_MIME,
  MAX_ATTACH_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
} from "./attachLimits";
import {
  parseAiChatCommand,
  AI_CHAT_COMMANDS,
  type AiChatCommand,
} from "../src/ui/aiChatPanelCommands";

declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

// ---- Host → Webview message shapes (mirror aiChatPanelMessages.ts) ---------
interface InitMsg {
  type: "init";
  hasHistory: boolean;
  /** TASK-002 (cycle AB): true iff the active role's vision flag is on.
   * Gates the attach button + clipboard-paste-image affordances. */
  visionCapable: boolean;
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
/** TASK-005: host answer to `mention_list`. `items` carries the candidate
 * DB objects + workspace files. Webview filters client-side on each
 * keystroke; the same full list is reused across the open dropdown. */
interface MentionObjectsMsg {
  type: "mention_objects";
  items: Array<{
    kind: "table" | "view" | "routine" | "file";
    label: string;
    detail: string;
    token: string;
  }>;
}
/** TASK-005: host reports a token the user mentioned that the host could
 * not resolve (no matching DB object AND no matching workspace file).
 * Rendered as an inline notice bubble on the thread. */
interface MentionMissMsg {
  type: "mention_miss";
  token: string;
}
/** TASK-002 (cycle AB): host rejects one attachment (oversize, count cap,
 * wrong MIME, etc.). Webview surfaces as an amber notice bubble naming
 * the offending file. NEVER carries apiKey material. */
interface AttachErrorMsg {
  type: "attach_error";
  id: string;
  reason:
    | "oversize"
    | "count_cap"
    | "unsupported_type"
    | "mime_mismatch"
    | "vision_unsupported";
  message: string;
}
type HostMsg =
  | InitMsg
  | StepMsg
  | { type: "tool_result"; tool: string; status: "ok" | "failed" | "denied"; summary: string }
  | AssistantMsg
  | ErrorMsg
  | DoneMsg
  | DeltaMsg
  | EngineMsg
  | { type: "session_state"; state: "connecting" | "running" | "done" | "error"; turnId: string }
  | PermissionRequestMsg
  | ResumeSessionsMsg
  | HistoryMsg
  | ThoughtMsg
  | MentionObjectsMsg
  | MentionMissMsg
  | AttachErrorMsg
  | ChangePlanMsg
  | UsageMsg
  | { type: "grounding_state"; selectionPath: string | null; fileCount: number; excludedCount: number; turnId: string };
/** AIX-04: reviewed change plan card with Approve/Reject consent
 * buttons. `drifted` disables Approve — a stale plan must not apply. */
interface ChangePlanMsg {
  type: "change_plan";
  tool: string;
  plan: {
    intent: string;
    statements: Array<{ sql: string; tier: string; dangerNote: string }>;
    drift: string[];
    drifted: boolean;
  };
}
/** TASK-ARP06-005: per-turn usage + governance notice. SHAPE-SAFE by
 * contract — numeric fields + the notice string only; NEVER carries
 * prompt/SQL/secret/trace/tool args. Rendered as a textContent-only
 * status chip. `unknown: true` means the zeros are NOT confirmed cost. */
interface UsageMsg {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  unknown: boolean;
  sessionTokens: { inputTokens: number; outputTokens: number };
  policyNotice: string;
}

// ---- State -----------------------------------------------------------------
interface State {
  busy: boolean;
  hasHistory: boolean;
  /** TASK-002 (cycle AB): true iff the active model's vision flag is on.
   * Drives attach-button enabled state + clipboard-paste-image gating. */
  visionCapable: boolean;
  /** TASK-002 (cycle AB): image attachments queued in the strip above the
   * textarea. Each entry carries id+mime+base64+bytes; `id` is a client-
   * minted UUID (no apiKey path). Cleared on send. */
  attachments: Array<{ id: string; mime: string; base64: string; bytes: number }>;
}
const state: State = {
  busy: false,
  hasHistory: false,
  visionCapable: true,
  attachments: [],
};
let slashOpen = false;
let slashActiveIndex = 0;
let slashCandidates: AiChatCommand[] = [];

// ---- TASK-005 — @-mention dropdown state ----------------------------------
//
// `mentionOpen` tracks whether the candidate dropdown is currently visible.
// Critical interop with the wave-2 Enter=send keybind (TASK-002): when the
// dropdown is open, Enter / Tab SELECTS the active row instead of sending.
// Send handler checks this flag BEFORE dispatching `{type:"send"}` so a
// stray selection can never accidentally fire a send in the same keystroke.
let mentionOpen = false;
let mentionActiveIndex = 0;
/** Last full candidate list posted by the host. Filtered client-side on
 * each keystroke; the host posts the full shortlist once per `@` keyup. */
let mentionItems: MentionObjectsMsg["items"] = [];
/** Last filter query. Used both for filtering and for matching against
 * the trailing `@…` span when inserting a token on selection. */
let mentionQuery = "";
/** Last caret position from the textarea — captured on every keyup so
 * insertion knows where to write the token. */
let lastCaretPos = 0;

/** Pure helper: find the start index of an `@token` ending at `caret`.
 * Returns -1 if no `@` precedes `caret` within the same line. */
function findAtTokenStart(text: string, caret: number): number {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") return i;
    if (ch === undefined) break;
    // Token chars only — anything else (space, newline, punctuation that
    // isn't part of the token grammar) breaks the span.
    if (!/[\w.\-/]/.test(ch)) break;
  }
  return -1;
}

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

/** Build / replace the dropdown DOM with the filtered items. All labels +
 * details + kinds are rendered via textContent (no innerHTML for untrusted
 * host data). Returns the rendered dropdown element. */
function renderMentionDropdown(
  items: MentionObjectsMsg["items"],
): HTMLDivElement | null {
  const input = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (!input) return null;
  disposeMentionDropdown();
  if (items.length === 0) {
    // Empty result → still render a "No matches" row so the user can
    // dismiss with Enter / Esc instead of being trapped with an invisible
    // dropdown.
    const dropdown = document.createElement("div");
    dropdown.className = "vsdb-chat-mention-dropdown";
    dropdown.id = "vsdbMentionDropdown";
    const row = document.createElement("div");
    row.className = "vsdb-chat-mention-row vsdb-chat-mention-row-empty";
    row.textContent = "No matches";
    dropdown.appendChild(row);
    document.body.appendChild(dropdown);
    positionDropdown(dropdown, input);
    return dropdown;
  }
  const dropdown = document.createElement("div");
  dropdown.className = "vsdb-chat-mention-dropdown";
  dropdown.id = "vsdbMentionDropdown";
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === undefined) continue;
    const row = document.createElement("div");
    row.className = "vsdb-chat-mention-row";
    row.setAttribute("data-token", it.token);
    row.setAttribute("data-index", i.toString());
    if (i === mentionActiveIndex) {
      row.classList.add("vsdb-chat-mention-row-active");
    }
    const kind = document.createElement("span");
    kind.className = "vsdb-chat-mention-kind";
    kind.textContent = it.kind;
    const label = document.createElement("span");
    label.className = "vsdb-chat-mention-label";
    label.textContent = it.label;
    const detail = document.createElement("span");
    detail.className = "vsdb-chat-mention-detail";
    detail.textContent = it.detail;
    row.appendChild(kind);
    row.appendChild(label);
    row.appendChild(detail);
    row.addEventListener("mousedown", (ev) => {
      // mousedown (not click) so the textarea blur doesn't fire first
      // and close the dropdown before the row click resolves.
      ev.preventDefault();
      selectMentionToken(it.token);
    });
    dropdown.appendChild(row);
  }
  document.body.appendChild(dropdown);
  positionDropdown(dropdown, input);
  return dropdown;
}

/** Position the dropdown anchored to the textarea. Uses fixed positioning
 * so the dropdown floats above scrolling content. */
function positionDropdown(
  dropdown: HTMLDivElement,
  input: HTMLTextAreaElement,
): void {
  const rect = input.getBoundingClientRect();
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  dropdown.style.width = `${Math.max(rect.width, 240)}px`;
}

/** Remove the dropdown DOM node + clear dropdown state. */
function disposeMentionDropdown(): void {
  const existing = document.getElementById("vsdbMentionDropdown");
  if (existing) existing.remove();
  mentionOpen = false;
  mentionActiveIndex = 0;
  mentionQuery = "";
}

/** Filter the cached `mentionItems` against `query` (case-insensitive
 * substring match against label + token). Updates the rendered DOM in
 * place. The host already returned the full shortlist; we narrow
 * client-side so a fast typing burst doesn't burn round trips. */
function filterMentionDropdown(query: string): void {
  mentionQuery = query;
  const q = query.toLowerCase();
  const filtered = mentionItems.filter((it) => {
    return (
      it.label.toLowerCase().includes(q) ||
      it.token.toLowerCase().includes(q)
    );
  });
  if (filtered.length === 0 && q.length > 0) {
    // No matches with a query → still show "No matches" so Enter/Esc work.
    mentionActiveIndex = 0;
    renderMentionDropdown([]);
    mentionOpen = true;
    return;
  }
  mentionActiveIndex = 0;
  renderMentionDropdown(filtered);
  mentionOpen = true;
}

/** Set the active row index and update the DOM class. Wraps around so the
 * user can hold ArrowDown indefinitely without escaping the list. */
function moveMentionActive(delta: number): void {
  const dropdown = document.getElementById("vsdbMentionDropdown");
  if (!dropdown) return;
  const rows = dropdown.querySelectorAll<HTMLDivElement>(
    ".vsdb-chat-mention-row",
  );
  if (rows.length === 0) return;
  let next = mentionActiveIndex + delta;
  if (next < 0) next = rows.length - 1;
  if (next >= rows.length) next = 0;
  mentionActiveIndex = next;
  rows.forEach((r, i) => {
    r.classList.toggle("vsdb-chat-mention-row-active", i === next);
  });
}

/** Insert the given @-token at the cursor position, replacing any partial
 * `@…` span that precedes it. Closes the dropdown. */
function selectMentionToken(token: string): void {
  const input = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value;
  const caret = input.selectionStart ?? lastCaretPos ?? text.length;
  const start = findAtTokenStart(text, caret);
  let before: string;
  let after: string;
  if (start >= 0) {
    before = text.slice(0, start);
    after = text.slice(caret);
  } else {
    // No `@` prefix visible — insert at caret verbatim.
    before = text.slice(0, caret);
    after = text.slice(caret);
  }
  const insertion = `@${token} `;
  input.value = `${before}${insertion}${after}`;
  const newCaret = before.length + insertion.length;
  input.setSelectionRange(newCaret, newCaret);
  input.focus();
  disposeMentionDropdown();
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
  const attachBtn = document.getElementById("attachBtn") as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = busy;
  // stopBtn is always clickable — host ignores stop when no agent is in flight.
  if (stopBtn) stopBtn.disabled = false;
  if (resumeBtn) resumeBtn.disabled = busy;
  if (regenBtn) regenBtn.disabled = busy;
  // Attach: disabled while busy OR when the active model can't see images.
  // TASK-AG-001: the title/aria-label pair is re-asserted together so the
  // hover tooltip and the accessible name never drift apart.
  if (attachBtn) {
    attachBtn.disabled = busy || !state.visionCapable;
    const attachLabel = !state.visionCapable
      ? "Current model does not support images"
      : COMPOSER_ICONS.attachBtn.label;
    attachBtn.title = attachLabel;
    attachBtn.setAttribute("aria-label", attachLabel);
  }
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (prompt) prompt.disabled = busy;
}
/** TASK-AG-001 — icon-only composer toolbar. Each action button renders a
 * 16×16 inline SVG (stroke="currentColor", same drawing idiom as the grid
 * toolbar in webview/main.ts) with its text label carried by title +
 * aria-label instead of visible text. The map is the single source of truth
 * for the tooltip string so the hover tooltip and the accessible name can
 * never drift apart. */
interface ComposerIconDef {
  label: string;
  svg: string;
}
const COMPOSER_ICONS: Record<string, ComposerIconDef> = {
  resumeBtn: {
    label: "Resume session",
    svg:
      // history / clock-rewind — arc + rewind arrow + clock hands.
      '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" />' +
      '<path d="M3.5 3.5 V6.5 H6.5" />' +
      '<path d="M8 5.5 V8 L9.8 9.5" />',
  },
  clearBtn: {
    label: "Clear conversation",
    svg:
      // trash — lid + body + handle (same glyph as the grid delete-row icon).
      '<path d="M3 5 H13" />' +
      '<path d="M5 5 V13 a1 1 0 0 0 1 1 h4 a1 1 0 0 0 1 -1 V5" />' +
      '<path d="M6 5 V3.5 a0.5 0.5 0 0 1 0.5 -0.5 h3 a0.5 0.5 0 0 1 0.5 0.5 V5" />' +
      '<path d="M6.8 7.5 V11.5" />' +
      '<path d="M9.2 7.5 V11.5" />',
  },
  regenerateBtn: {
    label: "Regenerate",
    svg:
      // counter-clockwise return arrow — "run the turn again".
      '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" />' +
      '<path d="M12.5 3.5 V6.5 H9.5" />',
  },
  stopBtn: {
    label: "Stop",
    svg:
      // filled square — universal stop glyph.
      '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />',
  },
  attachBtn: {
    label: "Attach image",
    svg:
      // paperclip — nested rounded loops on a diagonal.
      '<path d="M14.3 7.4 8.2 13.5a4 4 0 0 1-5.7-5.7l5.7-5.7A2.7 2.7 0 1 1 12 5.9l-5.7 5.7a1.4 1.4 0 0 1-1.9-1.9l5.7-5.7" />',
  },
  sendBtn: {
    label: "Send",
    svg:
      // paper plane — classic send glyph with fold line.
      '<path d="M14.7 1.3 7.3 8.7" />' +
      '<path d="M14.7 1.3 10 14.7 7.3 8.7 1.3 6 14.7 1.3 Z" />',
  },
};

/** The shared 16×16 currentColor svg for a composer icon (TASK-AG-001).
 * aria-hidden + focusable="false" so screen readers skip the glyph and read
 * the button's aria-label (=== title) instead. */
function composerIconSvg(id: string): string {
  const def = COMPOSER_ICONS[id];
  return (
    `<svg viewBox="0 0 16 16" width="16" height="16"` +
    ` xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"` +
    ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"` +
    ` aria-hidden="true" focusable="false">${def.svg}</svg>`
  );
}

/** Render one icon-only composer button from the COMPOSER_ICONS map — the
 * single source of truth for the tooltip string, so the hover tooltip and
 * the accessible name can never drift apart. */
function iconButtonHtml(id: string, className: string): string {
  const def = COMPOSER_ICONS[id];
  const cls = className ? ` class="${className}"` : "";
  return (
    `<button type="button" id="${id}"${cls}` +
    ` title="${def.label}" aria-label="${def.label}">` +
    `${composerIconSvg(id)}</button>`
  );
}

function disposeSlashDropdown(): void {
  slashOpen = false;
  slashActiveIndex = 0;
  slashCandidates = [];
  document.querySelector(".vsdb-chat-slash-dropdown")?.remove();
}

function renderSlashDropdown(candidates: AiChatCommand[]): void {
  document.querySelector(".vsdb-chat-slash-dropdown")?.remove();
  if (candidates.length === 0) {
    slashOpen = false;
    return;
  }
  slashOpen = true;
  slashCandidates = candidates;
  slashActiveIndex = Math.min(slashActiveIndex, candidates.length - 1);
  const dropdown = document.createElement("div");
  dropdown.className = "vsdb-chat-slash-dropdown";
  dropdown.setAttribute("role", "listbox");
  for (const [index, command] of candidates.entries()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "vsdb-chat-slash-row";
    row.setAttribute("role", "option");
    row.textContent = `/${command}`;
    row.setAttribute("aria-selected", String(index === slashActiveIndex));
    row.addEventListener("mousedown", (ev) => ev.preventDefault());
    row.addEventListener("click", () => {
      const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
      if (prompt) {
        prompt.value = `/${command} `;
        prompt.focus();
      }
      disposeSlashDropdown();
    });
    dropdown.appendChild(row);
  }
  document.querySelector(".vsdb-chat-input")?.appendChild(dropdown);
}

function updateSlashDropdown(value: string): void {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed.slice(1).split(/\s/, 1)[0] ?? "")) {
    disposeSlashDropdown();
    return;
  }
  const query = trimmed.slice(1).toLowerCase();
  const candidates = AI_CHAT_COMMANDS.filter((command) => command.startsWith(query));
  slashActiveIndex = 0;
  renderSlashDropdown(candidates);
}

function appendLocalNotice(message: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const notice = document.createElement("div");
  notice.className = "vsdb-chat-local-notice";
  notice.textContent = message;
  thread.appendChild(notice);
  autoScroll(notice);
}

function exportTranscript(filename?: string): void {
  const thread = document.getElementById("thread");
  const text = thread?.innerText?.trim() ?? "";
  const safeName = (filename?.trim() || "vsdb-ai-transcript.md").replace(/[\\/:*?\"<>|]/g, "_");
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeName;
  link.click();
  URL.revokeObjectURL(url);
  appendLocalNotice(`Transcript exported as ${safeName}`);
}

function executeSlashCommand(text: string): boolean {
  const parsed = parseAiChatCommand(text);
  if (!parsed) return false;
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  disposeSlashDropdown();
  if (prompt) prompt.value = "";
  switch (parsed.command) {
    case "clear":
      post({ type: "clear" });
      document.getElementById("thread")?.replaceChildren();
      clearAttachments();
      return true;
    case "resume":
      post({ type: "resume_list" });
      return true;
    case "context":
      appendLocalNotice(
        `Context: ${state.hasHistory ? "session history" : "no session history"}; ${state.attachments.length} queued attachment(s).`,
      );
      return true;
    case "export":
      exportTranscript(parsed.args[0]);
      return true;
    case "engine":
    case "model":
      post({ type: "command", command: parsed.command, args: parsed.args });
      return true;
  }
}

function renderInitial(): void {
  root.innerHTML = `
  <div class="vsdb-chat-thread" id="thread" aria-live="polite"></div>
  <button type="button" id="jumpLatest" class="vsdb-chat-jump" hidden>Jump to latest</button>
  <div class="vsdb-chat-input">
    <div class="vsdb-chat-attachments" id="attachStrip" hidden></div>
    <textarea id="prompt" rows="3" placeholder="Ask about your database…"></textarea>
    <div class="vsdb-chat-actions">
      ${iconButtonHtml("resumeBtn", "vsdb-chat-secondary")}
      ${iconButtonHtml("clearBtn", "")}
      ${iconButtonHtml("regenerateBtn", "vsdb-chat-secondary")}
      ${iconButtonHtml("stopBtn", "vsdb-chat-secondary")}
      <button type="button" id="attachBtn" class="vsdb-chat-attach-btn" title="Attach image" aria-label="Attach image">${composerIconSvg("attachBtn")}</button>
      ${iconButtonHtml("sendBtn", "vsdb-chat-primary")}
    </div>
  </div>`;
  // Hidden file input lives on <body> (not inside the composer card) so
  // jsdom + the VS Code webview can fire its `change` event without being
  // clipped by the composer column. Created exactly once; never re-created.
  if (!document.getElementById("attachFileInput")) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.id = "attachFileInput";
    fi.accept = "image/*";
    fi.multiple = true;
    fi.hidden = true;
    fi.setAttribute("aria-hidden", "true");
    document.body.appendChild(fi);
  }
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
  //
  // TASK-005: a mention dropdown that's still open means the user
  // accidentally clicked Send while the @-list was visible — close the
  // dropdown instead of sending. The actual selection on Enter / Tab is
  // handled in the keydown listener below; this guard is belt-and-braces
  // for the click path.
  sendBtn?.addEventListener("click", () => {
    if (mentionOpen) {
      disposeMentionDropdown();
      return;
    }
    if (!prompt) return;
    if (executeSlashCommand(prompt.value)) return;
    const text = prompt.value;
    if (text.trim().length === 0) return;
    appendUser(text);
    if (state.attachments.length > 0) {
      post({ type: "send", text, attachments: state.attachments.map((a) => ({
        id: a.id,
        mime: a.mime,
        base64: a.base64,
        bytes: a.bytes,
      })) });
    } else {
      post({ type: "send", text });
    }
    setBusy(true);
    prompt.value = "";
    disposeMentionDropdown();
    clearAttachments();
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
    disposeMentionDropdown();
    post({ type: "clear" });
    const thread = document.getElementById("thread");
    if (thread) thread.innerHTML = "";
  });

  // Enter / Tab / Esc / Arrow keys — TASK-005 dropdown semantics layered
  // ON TOP of the wave-2 Enter=send keybind (TASK-002 #3). The dropdown
  // MUST absorb these keys when open so the active row selects / moves
  // without sending. Order of checks:
  //   1. mentionOpen + Enter/Tab → SELECT active row (insert + close)
  //   2. mentionOpen + ArrowDown/Up → move active row
  //   3. mentionOpen + Esc → close
  //   4. Otherwise (no dropdown) → TASK-002 Enter=send semantics.
  prompt?.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (mentionOpen) {
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        const dropdown = document.getElementById("vsdbMentionDropdown");
        const rows = dropdown?.querySelectorAll<HTMLDivElement>(
          ".vsdb-chat-mention-row",
        );
        const row = rows?.[mentionActiveIndex];
        const token = row?.getAttribute("data-token");
        if (typeof token === "string" && token.length > 0) {
          selectMentionToken(token);
        } else {
          disposeMentionDropdown();
        }
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        disposeMentionDropdown();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveMentionActive(1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveMentionActive(-1);
        return;
      }
    }
    if (slashOpen) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        disposeSlashDropdown();
        return;
      }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const delta = ev.key === "ArrowDown" ? 1 : -1;
        slashActiveIndex =
          (slashActiveIndex + delta + slashCandidates.length) % slashCandidates.length;
        renderSlashDropdown(slashCandidates);
        return;
      }
      if (ev.key === "Tab") {
        ev.preventDefault();
        const command = slashCandidates[slashActiveIndex];
        if (command && prompt) {
          prompt.value = `/${command} `;
          prompt.focus();
        }
        disposeSlashDropdown();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (prompt && executeSlashCommand(prompt.value)) return;
        const command = slashCandidates[slashActiveIndex];
        if (command && prompt) {
          prompt.value = `/${command} `;
          prompt.focus();
        }
        disposeSlashDropdown();
        return;
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      if (prompt && executeSlashCommand(prompt.value)) {
        ev.preventDefault();
        return;
      }
    }
    // Fall through to normal Enter=send semantics.
    if (ev.key !== "Enter") return;
    if (ev.shiftKey) return;
    if (ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    sendBtn?.click();
  });

  prompt?.addEventListener("input", () => {
    if (!prompt || state.busy || mentionOpen) return;
    updateSlashDropdown(prompt.value);
  });

  // TASK-005: open / refresh the @-mention dropdown on each keystroke that
  // introduces an `@` at the cursor. We post `mention_list` and the host
  // answers with the full shortlist; client-side filter on each keystroke
  // narrows without burning round trips. Backspace through the `@` closes
  // the dropdown.
  prompt?.addEventListener("keyup", (ev: KeyboardEvent) => {
    if (!prompt) return;
    lastCaretPos = prompt.selectionStart ?? lastCaretPos;
    if (state.busy) {
      // Mention dropdown can't open while a turn is streaming (the input
      // is disabled by setBusy anyway; this is belt-and-braces).
      if (mentionOpen) disposeMentionDropdown();
      return;
    }
    const caret = prompt.selectionStart ?? prompt.value.length;
    const text = prompt.value;
    const atIdx = findAtTokenStart(text, caret);
    if (atIdx < 0) {
      // No active `@…` span — close any open dropdown.
      if (mentionOpen) disposeMentionDropdown();
      return;
    }
    const query = text.slice(atIdx + 1, caret);
    // Opening (or refreshing the query) — post the request.
    if (!mentionOpen || query !== mentionQuery) {
      // Store the query immediately so a quick second keystroke doesn't
      // re-post before the host reply lands.
      mentionQuery = query;
      post({ type: "mention_list", query });
    }
  });

  // Click outside the textarea or dropdown closes the dropdown. Listener
  // attached with capture so it wins against the textarea blur race.
  document.addEventListener("mousedown", (ev) => {
    if (!mentionOpen) return;
    const target = ev.target as Node | null;
    const dropdown = document.getElementById("vsdbMentionDropdown");
    if (
      target !== null &&
      (target === prompt || (dropdown !== null && dropdown.contains(target)))
    ) {
      return;
    }
    disposeMentionDropdown();
  });

  // TASK-002 (cycle AB) — attach button + file input + clipboard paste.
  const attachBtn = document.getElementById("attachBtn") as
    | HTMLButtonElement
    | null;
  const fileInput = document.getElementById("attachFileInput") as
    | HTMLInputElement
    | null;
  attachBtn?.addEventListener("click", () => {
    if (state.busy || !state.visionCapable) return;
    fileInput?.click();
  });
  fileInput?.addEventListener("change", () => {
    if (!fileInput.files) return;
    for (const f of Array.from(fileInput.files)) {
      void ingestFile(f);
    }
    // Reset so picking the same file twice still fires change.
    fileInput.value = "";
  });
  // Clipboard image paste — same pipeline as the file picker.
  prompt?.addEventListener("paste", (ev: ClipboardEvent) => {
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (!item.type.startsWith("image/")) continue;
      // Vision-disabled model → reject the paste with an inline warning;
      // do NOT add to the strip, do NOT swallow the event (text paste
      // should still work — see cycle-AA paste regression).
      if (!state.visionCapable) {
        renderAttachWarning(
          `Cannot attach image — current model does not support images`,
        );
        continue;
      }
      const blob = item.getAsFile();
      if (!blob) continue;
      void ingestFile(blob);
    }
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
  // TASK-UX1-009 (R11): surface an "AI is thinking…" row below the user
  // bubble so the assistant side has its own loading affordance while
  // the turn is pending. Removed on first delta / error / terminal
  // assistant message — lifecycle mirrors resolveQueuedUserBubble().
  appendThinking();
}

/** TASK-UX1-009 (R11) — append a separate "AI is thinking…" row BELOW
 * the just-sent user bubble. Pure DOM text (no innerHTML, no markdown)
 * so a hostile host cannot inject anything through the thinking label.
 * Idempotent — calling it twice in a row still leaves exactly one row. */
function appendThinking(): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  // Idempotency: never stack multiple thinking rows on the same turn.
  if (thread.querySelector(".vsdb-chat-thinking-row")) return;
  const row = document.createElement("div");
  row.className = "vsdb-chat-thinking-row";
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "vsdb-chat-thinking-spinner";
  spinner.setAttribute("aria-hidden", "true");
  row.appendChild(spinner);
  const label = document.createElement("span");
  label.className = "vsdb-chat-thinking-label";
  label.textContent = "AI is thinking…";
  row.appendChild(label);
  thread.appendChild(row);
  autoScroll(row);
}

/** TASK-UX1-009 (R11) — remove the "AI is thinking…" row. Called on
 * first delta / error / terminal assistant message. No-op if no row
 * exists (e.g. error before any user bubble). */
function removeThinking(): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  for (const row of Array.from(
    thread.querySelectorAll<HTMLElement>(".vsdb-chat-thinking-row"),
  )) {
    row.remove();
  }
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

/** AIX-03: visible tool-call outcome card. DOM text only — the summary is
 * host-authored shape text, rendered via textContent (never innerHTML). */
function appendToolResult(tool: string, status: string, summary: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = `vsdb-chat-tool-result vsdb-chat-tool-result-${status}`;
  div.textContent = summary; // host already formats "✓ tool — shape"
  thread.appendChild(div);
  autoScroll(div);
}

/** AIX-04: consent card for a reviewed change plan. DOM text only —
 * SQL/tier/drift rendered via textContent (never innerHTML). Buttons post
 * plan_approve / plan_reject; Approve disabled while drifted. */
function appendChangePlan(msg: ChangePlanMsg): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const card = document.createElement("div");
  card.className = "vsdb-chat-plan";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "reviewed change plan");

  const head = document.createElement("div");
  head.className = "vsdb-chat-plan-head";
  head.textContent = `Change plan — ${msg.plan.intent || "no intent"}`;
  card.appendChild(head);

  for (const st of msg.plan.statements) {
    const row = document.createElement("div");
    row.className = `vsdb-chat-plan-stmt vsdb-chat-plan-tier-${st.tier}`;
    const code = document.createElement("code");
    code.textContent = st.sql;
    row.appendChild(code);
    if (st.dangerNote) {
      const note = document.createElement("span");
      note.className = "vsdb-chat-plan-note";
      note.textContent = st.dangerNote;
      row.appendChild(note);
    }
    card.appendChild(row);
  }

  if (msg.plan.drift.length > 0) {
    const driftBox = document.createElement("div");
    driftBox.className = "vsdb-chat-plan-drift";
    const title = document.createElement("div");
    title.textContent = msg.plan.drifted
      ? "Schema drift detected — plan is stale. Re-run the suggestion before approving."
      : "Drift notes:";
    driftBox.appendChild(title);
    for (const line of msg.plan.drift) {
      const d = document.createElement("div");
      d.textContent = line;
      driftBox.appendChild(d);
    }
    card.appendChild(driftBox);
  }

  const actions = document.createElement("div");
  actions.className = "vsdb-chat-plan-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "vsdb-chat-plan-approve";
  approve.textContent = "Approve & run";
  approve.disabled = msg.plan.drifted;
  approve.addEventListener("click", () => post({ type: "plan_approve" }));
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "vsdb-chat-plan-reject";
  reject.textContent = "Reject";
  reject.addEventListener("click", () => post({ type: "plan_reject" }));
  actions.appendChild(approve);
  actions.appendChild(reject);
  card.appendChild(actions);

  thread.appendChild(card);
  autoScroll(card);
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
  // TASK-UX1-009 (R11): also remove the thinking row — an error settles
  // the turn, so the spinner would otherwise linger as dishonest state.
  removeThinking();
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
  // TASK-UX1-009 (R11): the thinking row is the assistant-side loading
  // affordance — first delta settles it.
  removeThinking();
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
  // TASK-UX1-009 (R11): once a fenced code block CLOSES mid-stream, the
  // accumulated plain-text bubble gets re-rendered through the markdown
  // pipeline so the user sees boxed code + copy button immediately — they
  // don't have to wait for the terminal assistant message to format the
  // reply. renderMarkdown escapes first, so the escape-first contract
  // holds across the re-render (case 5). Idempotent: each subsequent
  // delta re-renders from the full accumulated text, so copy buttons are
  // never duplicated (case 6).
  const accumulated = bubble.textContent ?? "";
  if (/```[\s\S]*?```/.test(accumulated)) {
    const caret = bubble.querySelector(".vsdb-chat-caret");
    bubble.innerHTML = renderMarkdown(accumulated);
    if (caret) bubble.appendChild(caret);
    wireCopyButtons(bubble);
  }
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

const root = document.getElementById("vsdb-root") as HTMLDivElement;
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

/** AIX-05: live OMP turn-lifecycle chip. Appends/replaces a
 * textContent-only `#sessionChip` inside the engine banner (or root when
 * no banner exists yet). State strings are host-enum values mapped to
 * fixed labels — never rendered verbatim. */
function applySessionState(state: "connecting" | "running" | "done" | "error"): void {
  const rootEl = document.getElementById("vsdb-root");
  if (!rootEl) return;
  let chip = document.getElementById("sessionChip") as HTMLSpanElement | null;
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "sessionChip";
    const banner = document.getElementById("engineBanner");
    const host = banner ?? rootEl;
    host.appendChild(chip);
  }
  const label =
    state === "connecting"
      ? "Connecting…"
      : state === "running"
        ? "Running…"
        : state === "done"
          ? "Done"
          : "Error";
  chip.className = `vsdb-chat-session vsdb-chat-session-${state}`;
  chip.textContent = label;
}

/** TASK-ARP06-005: render the per-turn usage + policy notice chip. The
 * `usage` frame is SHAPE-SAFE (numeric fields + notice string only — no
 * prompt/SQL/secret/trace/tool args ever ride on it), but the notice is a
 * host string, so the chip is textContent-ONLY: no innerHTML, no child
 * nodes, numbers rendered through fixed label templates — never verbatim
 * wire text. `unknown: true` renders an "unknown" label instead of the
 * zeros so unknown usage is never displayed as a confirmed zero cost. */
function applyUsage(msg: UsageMsg): void {
  const rootEl = document.getElementById("vsdb-root");
  if (!rootEl) return;
  let chip = document.getElementById("usageChip") as HTMLSpanElement | null;
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "usageChip";
    const banner = document.getElementById("engineBanner");
    const host = banner ?? rootEl;
    host.appendChild(chip);
  }
  const inTok = Number.isFinite(msg.inputTokens) ? msg.inputTokens : 0;
  const outTok = Number.isFinite(msg.outputTokens) ? msg.outputTokens : 0;
  const inSes = Number.isFinite(msg.sessionTokens?.inputTokens)
    ? msg.sessionTokens.inputTokens
    : 0;
  const outSes = Number.isFinite(msg.sessionTokens?.outputTokens)
    ? msg.sessionTokens.outputTokens
    : 0;
  const turnLabel = msg.unknown
    ? "tokens unknown"
    : `${inTok} in / ${outTok} out`;
  const parts: string[] = [
    `Turn: ${turnLabel}`,
    `Session: ${inSes} in / ${outSes} out`,
  ];
  // The policy notice joins the SAME chip as plain text (textContent only)
  // so a denied turn surfaces its governance notice without any markup.
  if (typeof msg.policyNotice === "string" && msg.policyNotice.length > 0) {
    parts.push(msg.policyNotice);
  }
  chip.className = msg.unknown
    ? "vsdb-chat-usage vsdb-chat-usage-unknown"
    : "vsdb-chat-usage vsdb-chat-usage-known";
  chip.textContent = parts.join(" — ");
  chip.title = "AI token usage for this turn and this panel session";
}

/** TASK-AIX05-103: render the OMP engine runtime lifecycle inside the
 * existing engine banner (`#engineLifecycle` span, textContent only).
 * The state literal is host-enum; the label map is fixed — never rendered
 * verbatim from the wire. */
function applyEngineState(state: string): void {
  const rootEl = document.getElementById("vsdb-root");
  if (!rootEl) return;
  let chip = document.getElementById("engineLifecycle") as HTMLSpanElement | null;
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "engineLifecycle";
    const banner = document.getElementById("engineBanner");
    const host = banner ?? rootEl;
    host.appendChild(chip);
  }
  const labels: Record<string, string> = {
    "stopped": "Stopped",
    "starting": "Starting…",
    "ready": "Ready",
    "cancelling": "Cancelling…",
    "crashed": "Crashed",
    "fallback-builtin": "Fallback to builtin",
  };
  chip.className = `vsdb-chat-engine-state vsdb-chat-engine-state-${state}`;
  chip.textContent = labels[state] ?? state;
}

function applyInit(msg: InitMsg): void {
  state.hasHistory = msg.hasHistory;
  state.visionCapable = msg.visionCapable;
  // init{hasHistory:false} đến sau khi panel từng busy (Clear path) →
  // chắc chắn re-enable input + đóng streaming bubble. Host cũng post
  // done, nhưng done một mình không de-stream nếu panel replay init.
  if (!msg.hasHistory) {
    deStreamOpenBubble();
    setBusy(false);
  }
  // Re-apply attach-button enabled state on every init (visionCapable
  // might have flipped since last init — e.g. role switch in host).
  const attachBtn = document.getElementById("attachBtn") as
    | HTMLButtonElement
    | null;
  if (attachBtn) attachBtn.disabled = state.busy || !state.visionCapable;
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
    case "tool_result":
      appendToolResult(msg.tool, msg.status, msg.summary);
      return;
    case "change_plan":
      appendChangePlan(msg);
      return;
    case "delta":
      appendDelta(msg.text);
      return;
    case "engine":
      applyEngine(msg);
      return;
    case "session_state":
      applySessionState(msg.state);
      return;
    case "engine_state":
      applyEngineState((msg as { state: string }).state);
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
      // TASK-UX1-009 (R11): terminal assistant message settles the thinking
      // row (the turn is over). No-op if no row exists.
      removeThinking();
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
      // TASK-UX1-009 (R11): also settle the assistant-side thinking row.
      // `done` is the terminal lifecycle event for the turn, so any
      // leftover spinner is dishonest state.
      removeThinking();
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
    case "mention_objects":
      // Cache the host shortlist; render the dropdown with the
      // current filter query.
      mentionItems = msg.items;
      filterMentionDropdown(mentionQuery);
      return;
    case "mention_miss":
      renderMentionMiss(msg.token);
      return;
    case "attach_error":
      renderAttachWarning(msg.message);
      return;
    case "grounding_state":
      renderGroundingChips(msg);
      return;
    case "usage":
      applyUsage(msg as UsageMsg);
      return;
  }
});

// ---- TASK-005 — inline miss notice -----------------------------------------

/** Render an inline notice bubble for an unresolved @-mention. Pure DOM
 * text (no innerHTML) — the host only ships the literal token string. */
function renderMentionMiss(token: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-mention-miss";
  div.textContent = `Could not resolve @${token}`;
  thread.appendChild(div);
}

// ---- TASK-002 (cycle AB) — attachment strip + warning bubble ---------------
//
// The strip lives above the textarea, inside the composer card, and is
// rendered as `.vsdb-chat-attachments` with one `.vsdb-chat-thumb` per
// attachment. Each thumb has a `.vsdb-chat-thumb-remove` button (top-right)
// that drops the attachment from local state. The strip is hidden when
// empty (no padding tax for the text-only path).

/** Reset the strip and local attachment state. Called on send + on Clear. */
function clearAttachments(): void {
  state.attachments = [];
  renderAttachStrip();
}

/** Render the attachment strip from `state.attachments`. Idempotent —
 * drops + recreates the strip contents (cheap, ≤4 nodes) so a thumb add /
 * remove doesn't have to track individual nodes. */
function renderAttachStrip(): void {
  const strip = document.getElementById("attachStrip") as
    | HTMLDivElement
    | null;
  if (!strip) return;
  strip.replaceChildren();
  if (state.attachments.length === 0) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  for (const att of state.attachments) {
    const thumb = document.createElement("div");
    thumb.className = "vsdb-chat-thumb";
    thumb.dataset.attachId = att.id;
    const img = document.createElement("img");
    img.alt = "";
    img.src = `data:${att.mime};base64,${att.base64}`;
    thumb.appendChild(img);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "vsdb-chat-thumb-remove";
    rm.setAttribute("aria-label", "Remove attachment");
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      state.attachments = state.attachments.filter((a) => a.id !== att.id);
      renderAttachStrip();
    });
    thumb.appendChild(rm);
    strip.appendChild(thumb);
  }
}

/** Render an amber warning bubble naming the offending attachment. textContent
 * only — host-supplied strings never reach innerHTML. */
function renderAttachWarning(message: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "vsdb-chat-attach-warning";
  div.textContent = message;
  thread.appendChild(div);
}

/** Client-minted attachment id (no apiKey path). Uses crypto.randomUUID when
 * available (modern webview + jsdom 22+), falls back to a counter for older
 * runtimes so the test harness can stay deterministic. */
let __attachCounter = 0;
function mintAttachId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  __attachCounter += 1;
  return `att-${__attachCounter}`;
}

/** Ingest a single File / Blob through the local cap validator. Reads as
 * data URL, splits the base64 payload, checks the byte + count caps and
 * the MIME whitelist, then appends to the strip state. Rejected entries
 * surface an amber warning instead of being silently dropped. */
async function ingestFile(file: File | Blob): Promise<void> {
  const mime = file.type;
  if (!ATTACH_ALLOWED_MIME.has(mime)) {
    renderAttachWarning(
      `Unsupported image type: ${mime || "unknown"}`,
    );
    return;
  }
  if (state.attachments.length >= MAX_ATTACHMENTS_PER_TURN) {
    renderAttachWarning(
      `Too many attachments (limit ${MAX_ATTACHMENTS_PER_TURN})`,
    );
    return;
  }
  const dataUrl = await readAsDataUrl(file);
  if (!dataUrl) {
    renderAttachWarning(`Could not read file — file is unreadable.`);
    return;
  }
  const base64 = dataUrl.split(",")[1] ?? "";
  const bytes = approximateBytesFromBase64(base64);
  if (bytes > MAX_ATTACH_BYTES) {
    renderAttachWarning(
      `Image too large (${Math.round(bytes / 1024 / 1024)} MB > ${MAX_ATTACH_BYTES / 1024 / 1024} MB cap)`,
    );
    return;
  }
  state.attachments.push({
    id: mintAttachId(),
    mime,
    base64,
    bytes,
  });
  renderAttachStrip();
}

/** Read a Blob as a data URL via FileReader. Returns the URL on success;
 * resolves with empty string on failure (caller drops + warns). */
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

/** Best-effort base64 byte length. We don't have Buffer in the webview, so
 * decode the base64 alphabet (4 chars → 3 bytes) with a pad fix-up. Good
 * enough for the cap validator; the host re-validates with the real
 * base64 decoder before forwarding to the model. */
function approximateBytesFromBase64(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64[len - 1] === "=") padding = 1;
  if (len > 1 && b64[len - 2] === "=") padding = 2;
  return Math.floor((len * 3) / 4) - padding;
}

// ---- AIX-01 — grounding chips + panel toggle -------------------------------

/** Render (or clear) the grounding chips strip under the composer. Pure
 * DOM via textContent (CSP-clean). Clicking the strip posts a
 * `grounding_toggle` to the host, which flips its panel-scoped flag and
 * re-posts `grounding_state`. */
function renderGroundingChips(msg: {
  selectionPath: string | null;
  fileCount: number;
  excludedCount: number;
  turnId: string;
}): void {
  let strip = document.getElementById("vsdb-grounding-strip");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "vsdb-grounding-strip";
    strip.className = "vsdb-grounding-strip";
    const composer = document.getElementById("composer") ?? document.body;
    composer.appendChild(strip);
    strip.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "grounding_toggle", enabled: false });
    });
  }
  strip.replaceChildren();
  if (msg.selectionPath === null && msg.fileCount === 0 && msg.excludedCount === 0) {
    // Nothing attached — leave the strip empty (hidden via CSS :empty).
    return;
  }
  const bits: string[] = [];
  if (msg.selectionPath) bits.push(`selection: ${msg.selectionPath}`);
  if (msg.fileCount > 0) bits.push(`${msg.fileCount} file(s)`);
  if (msg.excludedCount > 0) bits.push(`${msg.excludedCount} excluded`);
  const chip = document.createElement("span");
  chip.className = "vsdb-grounding-chip";
  chip.textContent = `Grounded in ${bits.join(" · ")} — click to disable`;
  chip.title = "Click to disable workspace grounding for this panel";
  strip.appendChild(chip);
}

// ---- Boot ------------------------------------------------------------------
renderInitial();
post({ type: "ready" });
