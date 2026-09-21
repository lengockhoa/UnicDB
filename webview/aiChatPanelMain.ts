// webview/aiChatPanelMain.ts — AiChatPanel webview entry (V2-only).
//
// TASK-CHATV2-017 (Lane 3): the V1 header/composer modules and the V1 boot
// are DELETED. `renderInitial()` mounts the V2 shell + controller (the ONE
// keyboard/transport/message owner on `#promptV2`, posting `ready_v2`
// exactly once) plus the legacy `#thread` + `#jumpLatest` affordances. The
// legacy bubble builders remain as the renderer for non-V2 host frames,
// which the controller forwards here via `onLegacyMessage` (one message
// effect; no second `window.message` listener). Bubbles host messages,
// render minimal markdown (no CDN), and text-only ACP permission request
// cards (TEXT RENDERING ONLY — never innerHTML for untrusted host text).
//
// SECURITY: the V2 controller posts typed intents only; the legacy bridge
// here posts send/stop/clear/permission_response / regenerate /
// resume_list / resume_pick / resume_cancel / plan_approve / plan_reject /
// grounding_toggle to host. It NEVER receives apiKey material. Permission
// requests carry a host-generated opaque requestId + opaque optionIds; the
// webview echoes them verbatim or denies (no optionId field on the wire).
// The webview yields AT MOST ONE response per visible request.

import { highlightSql } from "./sqlHighlight";
// TASK-CHATV2-005 — semantic V2 skeleton. Mounted into the live transcript
// region established here; later tasks (006–017) fill the placeholders.
// The V2 stylesheet (webview/aiChat/styles.css) is built as its own esbuild
// CSS entry (dist/aiChatPanel.css) and linked by the panel HTML — NOT
// imported here, so the stdout-bundling test harness stays valid.
import { mountChatShellIfNeeded } from "./aiChat/shell";
// TASK-CHATV2-009 — the single keyboard/transport owner. `vscodeApi` above was
// already acquired once at module scope and is passed in, so the controller
// never calls `acquireVsCodeApi` a second time.
import {
  createChatController,
  type ChatController,
  type VsCodeApiLike,
} from "./aiChat/controller";

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
  | EngineStateMsg
  | PermissionRequestMsg
  | ResumeSessionsMsg
  | HistoryMsg
  | ThoughtMsg
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

/** TASK-AIX05-103 — host reports the OMP runtime lifecycle state. Inline
 * mirror of `AiChatPanelEngineState` (six closed literals — see
 * aiChatPanelMessages.ts). */
interface EngineStateMsg {
  type: "engine_state";
  state: string;
}

/** TASK-CHATV2-009 — the single keyboard/transport owner. Every composer send,
 * stop and draft edit flows through this handle; mounted once by
 * `renderInitial()`. */
let chatController: ChatController | null = null;

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

// ------------------------------------------------------------------
// Helpers (escaped text + a tiny markdown → safe-HTML string helper).
// The canonical implementation lives in `./markdownSafe` (TASK-CLEAN2-007);
// both `aiChatPanelMain.ts` and `aiChatPanelThread.ts` import from there.
// `unescapeHtml` / `wireCopyButtons` stay local — they belong to the
// Copy-button wire-up (the host-side clone layout), not the render pass.
// ------------------------------------------------------------------
import { escapeHtml, renderMarkdown } from "./markdownSafe";

/**
 * TASK-CHATV2-017 (Lane 3) — V2-only boot. The legacy wave-1 header/composer
 * modules (renderHeader / renderComposer) are DELETED; every live surface is
 * owned by the V2 shell + controller.
 *   1. mountChatShellIfNeeded(root) → the semantic `.UnicDB-ai-chat-v2`
 *      skeleton (header / banner / transcript / composer + live regions).
 *      Idempotent on repeat boots.
 *   2. <#thread> — the legacy live message container inside the shell's
 *      transcript mount. The legacy bubble builders (appendUser /
 *      appendAssistant / appendDelta / appendError / …) still write here:
 *      the host keeps emitting non-V2 frames and `handleLegacyHostMessage`
 *      renders them with the suite-pinned legacy class names.
 *   3. createChatController → the ONE keyboard / transport / message owner
 *      on `#promptV2`; mounts the V2 composer, transcript, header, menus and
 *      cards, and posts `ready_v2` exactly once via `announceReady()`.
 *   4. <#jumpLatest> — floating scroll affordance for the legacy thread.
 */
function renderInitial(): void {
  const shell = mountChatShellIfNeeded(root);

  const thread = document.createElement("div");
  thread.id = "thread";
  thread.className = "UnicDB-chat-thread";
  thread.setAttribute("aria-live", "polite");
  shell.transcript.appendChild(thread);

  chatController = createChatController({
    root,
    vscode: vscodeApi as VsCodeApiLike | null,
    onLegacyMessage: (data) => handleLegacyHostMessage(data),
    // REVIEW-CHATV2-R1 P1-1/P1-3: while a V2 turn is live the V2 seam is the
    // ONLY renderer for assistant text/reasoning, the tool timeline, inline
    // attach notices and the permission sheet. The gate flips synchronously
    // with turn_started/turn_finished so a legacy twin arriving in the very
    // next message is already suppressed.
    onV2TurnGate: (live) => {
      v2TurnOwnsStreaming = live;
    },
  });
  chatController.announceReady();

  const jump = document.createElement("button");
  jump.type = "button";
  jump.id = "jumpLatest";
  jump.className = "UnicDB-chat-jump";
  jump.hidden = true;
  jump.textContent = "Jump to latest";
  root.appendChild(jump);

  wireJumpLatest();
}

// TASK-UX1-009 (R11) — turn-state flag. The "AI is thinking…" row is
// only meant for live turns the user just sent; history replay (resume
// picks) must NOT surface a spinner that no turn is producing. Toggled
// true in the composer send path and false on terminal assistant /
// error / first-delta settle.
let liveTurnPending = false;

function appendUser(text: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "UnicDB-chat-bubble UnicDB-chat-user UnicDB-chat-queued";
  div.textContent = text;
  // Queued marker — child element with the same class so test #8 can find
  // it via both classList and a descendant selector. Resolved by
  // resolveQueuedUserBubble() on first delta/error/done.
  const queued = document.createElement("span");
  queued.className = "UnicDB-chat-queued";
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
  // History replay also routes through appendUser, so gate on the
  // liveTurnPending flag (set by the composer send path) to avoid
  // leaving an orphan spinner after a resume_pick history post.
  if (liveTurnPending) appendThinking();
}

/** TASK-UX1-009 (R11) — append a separate "AI is thinking…" row BELOW
 * the just-sent user bubble. Pure DOM text (no innerHTML, no markdown)
 * so a hostile host cannot inject anything through the thinking label.
 * Idempotent — calling it twice in a row still leaves exactly one row. */
function appendThinking(): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  // Idempotency: never stack multiple thinking rows on the same turn.
  if (thread.querySelector(".UnicDB-chat-thinking-row")) return;
  const row = document.createElement("div");
  row.className = "UnicDB-chat-thinking-row";
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "UnicDB-chat-thinking-spinner";
  spinner.setAttribute("aria-hidden", "true");
  row.appendChild(spinner);
  const label = document.createElement("span");
  label.className = "UnicDB-chat-thinking-label";
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
    thread.querySelectorAll<HTMLElement>(".UnicDB-chat-thinking-row"),
  )) {
    row.remove();
  }
  // The turn this row belonged to is settled — clear the live-turn flag
  // so the next appendUser() (from history replay or the next send) is
  // a clean slate.
  liveTurnPending = false;
}

/** Resolve the queued marker on the latest user bubble (the just-sent
 * prompt). Called on first delta / error / done so the placeholder is
 * never left spinning on a settled turn. No-op if there's no queued
 * bubble (e.g. error before any user bubble). */
function resolveQueuedUserBubble(): void {
  const queued = root.querySelector(
    ".UnicDB-chat-bubble.UnicDB-chat-user.UnicDB-chat-queued",
  ) as HTMLDivElement | null;
  if (!queued) return;
  queued.classList.remove("UnicDB-chat-queued");
  for (const m of Array.from(
    queued.querySelectorAll(".UnicDB-chat-queued"),
  )) m.remove();
}

function appendStep(label: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const step = document.createElement("div");
  step.className = "UnicDB-chat-step";
  step.textContent = `→ ${label}`;
  thread.appendChild(step);
}

/** AIX-03: visible tool-call outcome card. DOM text only — the summary is
 * host-authored shape text, rendered via textContent (never innerHTML).
 *
 * TASK-AGTUI-008 polish: the card is now a collapsible container with a
 * clickable header (.UnicDB-chat-tool-header → toggles
 * .UnicDB-chat-tool-collapsed on the parent). The header carries NO
 * visible text — its glyph is delivered via a CSS pseudo-element
 * (::before) so the card's textContent remains EQUAL to the original
 * summary string (DbAwareWebview test pins that invariant).
 *
 * The body hosts the existing summary text. The card STAYS in the DOM
 * in both states; collapsed only hides the body via CSS (max-height → 0,
 * opacity → 0, 150ms ease). The legacy
 * `.UnicDB-chat-tool-result.UnicDB-chat-tool-result-<status>` class hook
 * stays so the existing suite keeps passing. */
function appendToolResult(tool: string, status: string, summary: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const container = document.createElement("div");
  container.className = `UnicDB-chat-tool-result UnicDB-chat-tool-result-${status} UnicDB-chat-tool-collapsible`;
  container.dataset.toolResult = "true";

  const header = document.createElement("div");
  header.className = "UnicDB-chat-tool-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "true");
  header.setAttribute(
    "aria-label",
    `Toggle tool result: ${tool} (${status})`,
  );
  header.title = `${tool} — ${status}`;

  // Intentionally NO textContent on the header. The 12×12 caret glyph is
  // delivered via the .UnicDB-chat-tool-glyph::before pseudo-element in
  // styles.css so card.textContent remains exactly the summary string.

  const body = document.createElement("div");
  body.className = "UnicDB-chat-tool-body";
  body.textContent = summary; // host already formats "✓ tool — shape"

  const toggle = (): void => {
    const collapsed = container.classList.toggle("UnicDB-chat-tool-collapsed");
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (ev: KeyboardEvent) => {
    // Space / Enter also toggles (the ARIA `role="button"` contract).
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle();
    }
  });

  container.appendChild(header);
  container.appendChild(body);
  thread.appendChild(container);
  autoScroll(container);
}

/** AIX-04: consent card for a reviewed change plan. DOM text only —
 * SQL/tier/drift rendered via textContent (never innerHTML). Buttons post
 * plan_approve / plan_reject; Approve disabled while drifted. */
function appendChangePlan(msg: ChangePlanMsg): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const card = document.createElement("div");
  card.className = "UnicDB-chat-plan";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "reviewed change plan");

  const head = document.createElement("div");
  head.className = "UnicDB-chat-plan-head";
  head.textContent = `Change plan — ${msg.plan.intent || "no intent"}`;
  card.appendChild(head);

  for (const st of msg.plan.statements) {
    const row = document.createElement("div");
    row.className = `UnicDB-chat-plan-stmt UnicDB-chat-plan-tier-${st.tier}`;
    const code = document.createElement("code");
    code.textContent = st.sql;
    row.appendChild(code);
    if (st.dangerNote) {
      const note = document.createElement("span");
      note.className = "UnicDB-chat-plan-note";
      note.textContent = st.dangerNote;
      row.appendChild(note);
    }
    card.appendChild(row);
  }

  if (msg.plan.drift.length > 0) {
    const driftBox = document.createElement("div");
    driftBox.className = "UnicDB-chat-plan-drift";
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
  actions.className = "UnicDB-chat-plan-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "UnicDB-chat-plan-approve";
  approve.textContent = "Approve & run";
  approve.disabled = msg.plan.drifted;
  approve.addEventListener("click", () => post({ type: "plan_approve" }));
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "UnicDB-chat-plan-reject";
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
  div.className = "UnicDB-chat-bubble UnicDB-chat-assistant";
  // TASK-003: colorize SQL fenced blocks AFTER the escaped HTML is in place.
  // renderMarkdown escapes user text first; reading `textContent` off the
  // already-escaped <code> node decodes entities back to the raw SQL, and
  // highlightSql writes a fragment built with createElement + textContent
  // only — preserving the no-innerHTML-for-user-content contract (hostile
  // agent output never reaches the page as live nodes).
  div.innerHTML = markdown ? renderMarkdown(text) : escapeHtml(text);
  if (markdown) {
    for (const code of Array.from(
      div.querySelectorAll<HTMLElement>("code.UnicDB-md-code-lang-sql"),
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
  div.className = "UnicDB-chat-bubble UnicDB-chat-error";
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
    ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
  );
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className =
      "UnicDB-chat-bubble UnicDB-chat-assistant UnicDB-chat-streaming";
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
  //
  // The accumulated source is a per-bubble dataset attribute, NOT
  // `bubble.textContent`. Once a fence closes the rendered HTML contains
  // a copy-button label and the fence markers are consumed — re-rendering
  // from textContent on a SECOND closing fence would inline the previous
  // code + the literal word "Copy" into the next markdown pass. Storing
  // the raw stream in a dataset attribute keeps the source intact.
  // (dataset converts dashed names to camelCase: "UnicDBRawStream".)
  const previous = bubble.dataset.UnicDBRawStream ?? "";
  const accumulated = previous + text;
  bubble.dataset.UnicDBRawStream = accumulated;
  if (/```[\s\S]*?```/.test(accumulated)) {
    const caret = bubble.querySelector(".UnicDB-chat-caret");
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
    ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
  );
  for (const bubble of Array.from(open)) {
    bubble.classList.remove("UnicDB-chat-streaming");
    const caret = bubble.querySelector(".UnicDB-chat-caret");
    if (caret) caret.remove();
    // Clear the raw-stream scratch — the streaming bubble is now closed
    // and the terminal assistant message owns the final text.
    delete bubble.dataset.UnicDBRawStream;
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
  const existing = bubble.querySelector(".UnicDB-chat-caret");
  if (existing) {
    // Re-append (move) to the end so the caret trails the latest text.
    bubble.removeChild(existing);
  }
  const caret = document.createElement("span");
  caret.className = "UnicDB-chat-caret";
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
    details.className = "UnicDB-chat-thinking";
    details.id = "thinkingBlock";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "UnicDB-chat-thinking-body";
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

/** Wire all `.UnicDB-md-copy` buttons inside a bubble root so a click
 * copies the raw code (data-raw attribute, un-escaped) via clipboard. */
function wireCopyButtons(rootEl: HTMLElement): void {
  for (const btn of Array.from(
    rootEl.querySelectorAll<HTMLButtonElement>(".UnicDB-md-copy"),
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
  action.className = "UnicDB-chat-copy-msg";
  action.textContent = "Copy";
  action.title = "Copy message";
  action.addEventListener("click", () => {
    void navigator.clipboard?.writeText(rawSource).catch(() => {
      // Silent degrade.
    });
  });
  bubble.appendChild(action);
}

const root = document.getElementById("UnicDB-root") as HTMLDivElement;

/** TASK-ARP06-005: render the per-turn usage + policy notice chip. The
 * `usage` frame is SHAPE-SAFE (numeric fields + notice string only — no
 * prompt/SQL/secret/trace/tool args ever ride on it), but the notice is a
 * host string, so the chip is textContent-ONLY: no innerHTML, no child
 * nodes, numbers rendered through fixed label templates — never verbatim
 * wire text. `unknown: true` renders an "unknown" label instead of the
 * zeros so unknown usage is never displayed as a confirmed zero cost. */
function applyUsage(msg: UsageMsg): void {
  // CHATUX2-001: the chip renders INSIDE the V2 header's -usage span — never
  // as an implicit grid child of #UnicDB-root (that stacked a stray bar
  // under the composer). Fallback: the V2 header itself.
  const usageEl = document.getElementById("UnicDB-ai-chat-v2-usage");
  const host =
    usageEl ??
    document.querySelector<HTMLElement>(
      "#UnicDB-root .UnicDB-ai-chat-v2-header",
    );
  if (!host) return;
  let chip = document.getElementById("usageChip") as HTMLSpanElement | null;
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "usageChip";
  }
  if (chip.parentElement !== host) host.appendChild(chip);
  if (usageEl) usageEl.hidden = false;
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
    ? "UnicDB-chat-usage UnicDB-chat-usage-unknown"
    : "UnicDB-chat-usage UnicDB-chat-usage-known";
  chip.textContent = parts.join(" — ");
  chip.title = "AI token usage for this turn and this panel session";
}

/** TASK-AIX05-103: render the OMP engine runtime lifecycle inside the V2
 * header's `-engine-state` span (`#engineLifecycle` chip, textContent only).
 * The state literal is host-enum; the label map is fixed — never rendered
 * verbatim from the wire. */
function applyEngineState(state: string): void {
  // CHATUX2-001: same retarget as applyUsage — the chip lives inside the V2
  // header's -engine-state span, never appended to #UnicDB-root.
  const stateEl = document.getElementById("UnicDB-ai-chat-v2-engine-state");
  const host =
    stateEl ??
    document.querySelector<HTMLElement>(
      "#UnicDB-root .UnicDB-ai-chat-v2-header",
    );
  if (!host) return;
  let chip = document.getElementById("engineLifecycle") as HTMLSpanElement | null;
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "engineLifecycle";
  }
  if (chip.parentElement !== host) host.appendChild(chip);
  if (stateEl) stateEl.hidden = false;
  const labels: Record<string, string> = {
    "stopped": "Stopped",
    "starting": "Starting…",
    "ready": "Ready",
    "cancelling": "Cancelling…",
    "crashed": "Crashed",
    "fallback-builtin": "Fallback to builtin",
  };
  chip.className = `UnicDB-chat-engine-state UnicDB-chat-engine-state-${state}`;
  chip.textContent = labels[state] ?? state;
}

/** TASK-CHATV2-017 (Lane 3) — init{hasHistory:false} arrives after the panel
 * was busy (Clear path) → de-stream any orphaned streaming bubble. The V2
 * controller owns busy state; the host also posts `done`, but `done` alone
 * does not de-stream when the panel replays init. */
function applyInit(msg: InitMsg): void {
  if (!msg.hasHistory) {
    deStreamOpenBubble();
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
    `.UnicDB-chat-permission[data-request-id="${cssEscape(requestId)}"]`,
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
    div.className = "UnicDB-chat-permission-tool-detail";
    div.textContent = detail;
    return div;
  }
  const details = document.createElement("details");
  details.className = "UnicDB-chat-permission-tool-detail";
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
  card.className = "UnicDB-chat-permission";
  card.dataset.requestId = msg.requestId;

  const header = document.createElement("div");
  header.className = "UnicDB-chat-permission-header";
  header.textContent = "Permission required";
  card.appendChild(header);

  const toolId = document.createElement("div");
  toolId.className = "UnicDB-chat-permission-tool-id";
  toolId.textContent = msg.tool.id;
  card.appendChild(toolId);

  const toolName = document.createElement("div");
  toolName.className = "UnicDB-chat-permission-tool-name";
  toolName.textContent = msg.tool.name;
  card.appendChild(toolName);

  // Detail rendering: short single-line → plain div; long → collapsible
  // <details><summary>…</summary><pre>; empty → omit node. textContent only.
  const detailNode = permissionDetailNode(msg.tool.detail);
  if (detailNode !== null) card.appendChild(detailNode);

  const actions = document.createElement("div");
  actions.className = "UnicDB-chat-permission-actions";
  for (const opt of msg.options) {
    const btn = document.createElement("button");
    btn.className =
      opt.optionId === "deny"
        ? "UnicDB-chat-secondary UnicDB-chat-permission-deny"
        : "UnicDB-chat-primary UnicDB-chat-permission-allow";
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
  card.className = "UnicDB-chat-resume-picker";

  const header = document.createElement("div");
  header.className = "UnicDB-chat-resume-header";
  header.textContent = "Resume a previous session";
  card.appendChild(header);

  for (const s of msg.sessions) {
    const row = document.createElement("div");
    row.className = "UnicDB-chat-resume-row";
    row.dataset.sessionId = s.sessionId;

    const label = document.createElement("div");
    label.className = "UnicDB-chat-resume-row-label";
    label.textContent = s.label;
    row.appendChild(label);

    const detail = document.createElement("div");
    detail.className = "UnicDB-chat-resume-row-detail";
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
  cancelBtn.className = "UnicDB-chat-secondary UnicDB-chat-resume-cancel";
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
  const existing = document.querySelector(".UnicDB-chat-resume-picker");
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
    notice.className = "UnicDB-chat-history-truncated";
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
      row.className = "UnicDB-chat-history-tool";
      row.textContent = item.text;
      thread.appendChild(row);
    }
    // Any other kind (host shouldn't ship thought/skip — silently dropped).
  }
  thread.scrollTop = thread.scrollHeight;
}

// ---- Wire host messages ----------------------------------------------------
//
// TASK-CHATV2-009 — the controller is the ONLY `window.message` listener now.
//
// REVIEW-CHATV2-R1 P1-1/P1-3 — single-renderer cutover seam. While a V2 turn
// is live, the V2 transcript/timeline OWNS every family it covers: assistant
// text + reasoning (text_delta / reasoning_delta), the tool timeline
// (tool_started / tool_finished) and the permission sheet
// (permission_requested). The legacy twins of those families are suppressed
// below so one logical event can never render twice. Families with NO live
// V2 counterpart (init, change_plan, error, done, engine_state, usage,
// grounding, mention_miss, resume, history, attach_error — whose V2 notices
// are store-only) keep rendering through this bridge for every host path
// still using them, and legacy-only tests that never open a V2 turn are
// unaffected.

let v2TurnOwnsStreaming = false;

// This legacy dispatcher is invoked BY the controller (via `onLegacyMessage`)
// for non-V2 frames, so V1 frame handling survives without a second listener.
function handleLegacyHostMessage(data: unknown): void {
   const msg = data as HostMsg;
   switch (msg.type) {
    case "init":
      applyInit(msg);
      return;
    case "step":
      // V2 seam owns live activity while a turn is open (tool timeline +
      // reasoning block). Out-of-turn notices (plan-apply progress) still
      // render here — the gate is closed between turns.
      if (v2TurnOwnsStreaming) return;
      appendStep(msg.label);
      return;
    case "tool_result":
      if (v2TurnOwnsStreaming) return;
      appendToolResult(msg.tool, msg.status, msg.summary);
      return;
    case "change_plan":
      // No V2 host emitter exists for change_plan — always legacy-owned.
      appendChangePlan(msg);
      return;
    case "delta":
      if (v2TurnOwnsStreaming) return;
      appendDelta(msg.text);
      return;
    case "engine_state":
      // TASK-CHATV2-017 (Lane 3): engine identity is owned by the V2 header
      // pill (from the V2 `capabilities` frame); this legacy OMP lifecycle
      // frame still surfaces the runtime state (Stopped/Starting/Ready/…).
      applyEngineState((msg as { state: string }).state);
      return;
    case "assistant":
      // Final assistant message: replace any open streaming bubble with a
      // rendered markdown version. If no streaming bubble exists, render a
      // new one (builtin path). Suppressed while a V2 turn owns the seam —
      // the V2 transcript already holds the streamed text and the
      // turn_finished seal closes it (out-of-turn notices like
      // "Plan applied: …" keep rendering here).
      if (v2TurnOwnsStreaming) return;
      {
        const thread = document.getElementById("thread");
        const streaming = thread?.querySelector(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
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
      // The thinking block stays visible after `done` — it summarizes
      // the just-finished turn's reasoning for the user. The next user
      // send drops it via appendUser -> resetThinkingBlock.
      return;
    case "thought":
      // V2 seam owns reasoning while a turn is open (reasoning_delta).
      if (v2TurnOwnsStreaming) return;
      applyThought(msg.text);
      return;
    case "permission_request":
      // P1-3: the V2 anchored sheet is the ONE permission surface while a
      // V2 turn is live. A legacy card mounted beside it would leave a
      // stale second answer path that wedges the composer keyboard.
      if (v2TurnOwnsStreaming) return;
      renderPermissionRequest(msg);
      return;
    case "resume_sessions":
      renderResumePicker(msg);
      return;
    case "history":
      renderHistory(msg);
      return;
    case "mention_miss":
      renderMentionMiss(msg.token);
      return;
    case "attach_error":
      // The host posts this family on both wires (postAttachError), but the
      // V2 store's attachNotices have NO live V2 renderer yet (store-only
      // state) — the legacy amber bubble is the ONE visible surface, so it
      // must stay mounted even while a V2 turn owns the other families.
      renderAttachWarning(msg.message);
      return;
    case "grounding_state":
      renderGroundingChips(msg);
      return;
    case "usage":
      applyUsage(msg as UsageMsg);
      return;
  }
}

// ---- TASK-005 — inline miss notice -----------------------------------------

/** Render an inline notice bubble for an unresolved @-mention. Pure DOM
 * text (no innerHTML) — the host only ships the literal token string. */
function renderMentionMiss(token: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "UnicDB-chat-mention-miss";
  div.textContent = `Could not resolve @${token}`;
  thread.appendChild(div);
}

/** Render an amber warning bubble naming the offending attachment. textContent
 * only — host-supplied strings never reach innerHTML. */
function renderAttachWarning(message: string): void {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "UnicDB-chat-attach-warning";
  div.textContent = message;
  thread.appendChild(div);
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
  let strip = document.getElementById("UnicDB-grounding-strip");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "UnicDB-grounding-strip";
    strip.className = "UnicDB-grounding-strip";
    // The V1 composer card is deleted (CHATV2-017); the strip mounts on
    // <body> and positions via the `.UnicDB-grounding-strip` rules.
    document.body.appendChild(strip);
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
  chip.className = "UnicDB-grounding-chip";
  chip.textContent = `Grounded in ${bits.join(" · ")} — click to disable`;
  chip.title = "Click to disable workspace grounding for this panel";
  strip.appendChild(chip);
}

// ---- Boot ------------------------------------------------------------------
renderInitial();
// TASK-CHATV2-009 — the boot readiness signal rides the V2 seam
// (`{kind:"ready_v2", protocolVersion:2}`) emitted by the controller inside
// `renderInitial`. The legacy `{type:"ready"}` is NOT also sent: the host's
// `handleReady` is not idempotent (it re-posts the init/models/capabilities
// fan-out each time), so a second ready would duplicate the hydration fan-out
// and create a competing message path. Deleted in CHATV2-017 with the rest of
// the V1 wire.
