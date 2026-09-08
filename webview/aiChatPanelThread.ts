// webview/aiChatPanelThread.ts — TASK-AGTUI-005
//
// Pure-DOM chat-thread builders extracted from webview/aiChatPanelMain.ts.
// Task 007 (main) will import these functions and replace its local copies
// with the moved versions; this file is the new source of truth.
//
// Design notes (clone layout, per §TASK-AGTUI-001 + plan review):
//   - All wire strings (user text, tool names/summaries, SQL, plan intent,
//     drift lines, usage numbers, markdown body) are written through
//     `textContent` / `createTextNode` / `escapeHtml` — never via
//     `innerHTML` for the user-controlled portion. The markdown path is
//     the ONLY place HTML strings are produced, and those go through
//     `escapeHtml` BEFORE the controlled replacement set is applied
//     (same contract as TASK-002's renderMarkdown).
//   - This module is webview-safe: it imports nothing from `vscode` or
//     `src/`. The only webview-local dep is `./sqlHighlight` (used by
//     the assistant SQL fenced-block coloriser).
//   - Each function takes the target thread (or, in the usage-chip case,
//     the container) explicitly — the helpers never `getElementById`
//     themselves. The caller picks the mount point, which keeps the
//     module composable for the TASK-007 main rewrite and any future
//     "alternate thread" surfaces.
//   - Class names use the §TASK-AGTUI-001 clone layout (the chat-* set
//     becomes chat-msg-* / chat-thought / chat-tool* / chat-plan /
//     chat-error / chat-usage). Existing TASK-002 / TASK-004 / AGTUI-001
//     webview tests that pin the older sub-classes are deliberately
//     left untouched — they exercise Main, which this task does NOT
//     modify (Main ↔ this module swap is TASK-AGTUI-007's job).
//
// SECURITY: this file is part of the webview asset boundary; nothing in
// it may execute on the host. The TASK-002 `vscode` import / webview-
// guard rule applies in full.

import { highlightSql } from "./sqlHighlight";
import { escapeHtml, renderMarkdown } from "./markdownSafe";

// ------------------------------------------------------------------
// Helpers (escaped text + a tiny markdown → safe-HTML string helper).
// The canonical implementation lives in `./markdownSafe` (TASK-CLEAN2-007);
// this module re-exports `renderMarkdown` for back-compat with existing
// external import paths, and keeps its local `unescapeHtml` /
// `wireCopyButtons` helpers untouched (out of scope for the dedup task).
// ------------------------------------------------------------------

/** Re-export the canonical markdown renderer for back-compat. External
 * consumers (e.g. `aiChatPanelThread.test.ts`) keep importing
 * `renderMarkdown` from this module. */
export { renderMarkdown };

/** Reverse the escape table. Used by the Copy buttons (kept here so the
 * module is self-contained; rendered copies of the same fn live in main
 * until TASK-007 lands). */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Wire every `.UnicDB-md-copy` button inside `rootEl` to copy the
 * matching `<pre data-raw>` payload. Called once per assistant bubble
 * (mirrors TASK-002 wireCopyButtons but scoped to whatever root the
 * caller hands in — no document-wide touch). */
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

/** Closed-set of tool-card status modifier suffixes. Anything outside
 * the set falls back to the base `UnicDB-chat-tool` class — the status
 * string is wire text (host enum), so the class suffix is NEVER the raw
 * value (defense-in-depth against weird / future / hostile statuses). */
const TOOL_STATUS_SUFFIX: Readonly<Record<string, string>> = {
  ok: "ok",
  failed: "failed",
  denied: "denied",
};
function toolStatusSuffix(raw: string): string {
  return TOOL_STATUS_SUFFIX[raw] ?? "";
}

// ------------------------------------------------------------------
// Bubble builders. The clone layout (§TASK-AGTUI-001) splits the
// original `UnicDB-chat-user` / `UnicDB-chat-assistant` /
// `UnicDB-chat-error` into `-msg-user` / `-msg-assistant` / `-msg-error`
// so the surface can be styled independently from the older `chat-`
// history-replay card family (which lives on `UnicDB-chat-bubble.*`).
// ------------------------------------------------------------------

/** User bubble: right-aligned by convention, textContent-only. Returns
 * the appended `<div>`. */
export function appendUserBubble(
  thread: HTMLElement,
  text: string,
): HTMLElement {
  const div = document.createElement("div");
  div.className = "UnicDB-chat-msg-user";
  div.textContent = text;
  thread.appendChild(div);
  return div;
}

/** Assistant bubble: left-aligned by convention. When `markdown` is
 * true, render through `renderMarkdown` and colorise SQL fenced blocks
 * via `highlightSql` (textContent-only fragment). When false, escape the
 * whole payload and assign via `innerHTML` so the escaped form reaches
 * the page as text — this is the SAFE innerHTML path (the content is
 * the escaped version, not the raw wire text). Returns the bubble. */
export function appendAssistantBubble(
  thread: HTMLElement,
  text: string,
  markdown: boolean,
): HTMLElement {
  const div = document.createElement("div");
  div.className = "UnicDB-chat-msg-assistant";
  if (markdown) {
    div.innerHTML = renderMarkdown(text);
    // Colorize SQL fenced blocks AFTER the escaped HTML is in place:
    // reading textContent off the <code> decodes entities back to raw
    // SQL, and highlightSql writes a fragment built with createElement +
    // textContent only — preserving the no-innerHTML-for-user-content
    // contract (mirrors TASK-002 #2).
    for (const code of Array.from(
      div.querySelectorAll<HTMLElement>("code.UnicDB-md-code-lang-sql"),
    )) {
      const frag = highlightSql(code.textContent ?? "");
      code.replaceChildren(frag);
    }
    wireCopyButtons(div);
  } else {
    // Plain-text branch: escape whole payload, no markdown syntax.
    div.innerHTML = escapeHtml(text);
  }
  thread.appendChild(div);
  return div;
}

// ------------------------------------------------------------------
// Thinking / step / tool cards.
// ------------------------------------------------------------------

/** Insert the "AI is thinking…" row. Idempotent — calling twice in a
 * row leaves exactly one row. Returns the row (so the caller can hold
 * onto it for removal). */
export function appendThinkingRow(thread: HTMLElement): HTMLElement {
  const existing = thread.querySelector<HTMLElement>(".UnicDB-chat-thinking-row");
  if (existing) return existing;
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
  return row;
}

/** Remove a thinking row (no-op if already gone). Matches
 * `removeThinking()` semantics in TASK-002. */
export function removeThinkingRow(
  thread: HTMLElement,
  row: HTMLElement,
): void {
  if (row.parentNode === thread) {
    thread.removeChild(row);
  }
}

/** Append a tool step row (host-authored label, prefixed with "→" so
 * the user sees it as a step in the agent's tool sequence). */
export function appendStepRow(
  thread: HTMLElement,
  label: string,
): HTMLElement {
  const step = document.createElement("div");
  step.className = "UnicDB-chat-step";
  step.textContent = `→ ${label}`;
  thread.appendChild(step);
  return step;
}

/** Append a tool-call card. `status` must be one of the closed set
 * `ok | failed | denied`; unknown statuses still render under the base
 * `UnicDB-chat-tool` class. The base class is ALWAYS present (no crash
 * on unknown input). The host pre-formats the summary to carry the tool
 * name (e.g. "✓ sql — 12 rows") and the entire payload reaches the page
 * via textContent only — no innerHTML, never any live markup from the
 * wire string. */
export function appendToolCard(
  thread: HTMLElement,
  tool: string,
  status: "ok" | "failed" | "denied",
  summary: string,
): HTMLElement {
  const suffix = toolStatusSuffix(status);
  const card = document.createElement("div");
  card.className = suffix
    ? `UnicDB-chat-tool UnicDB-chat-tool-${suffix}`
    : "UnicDB-chat-tool";
  // Mirror the original `appendToolResult` contract: the host bakes the
  // tool name into the summary string, so we just assign the whole
  // payload via textContent. `tool` is part of the signature for caller
  // symmetry (TASK-007 main rewrite) but is not rendered as a separate
  // DOM node.
  void tool;
  card.textContent = summary;
  thread.appendChild(card);
  return card;
}

// ------------------------------------------------------------------
// Change-plan card.
// ------------------------------------------------------------------

/** Closed-set of plan-tier suffix labels. Unknown tiers fall back to
 * `tier-amber` so the card always renders inside the family and never
 * carries an attacker-controlled class suffix. */
const PLAN_TIER_SUFFIX: Readonly<Record<string, string>> = {
  red: "red",
  amber: "amber",
  green: "green",
};
function planTierSuffix(raw: string): string {
  return PLAN_TIER_SUFFIX[raw] ?? "amber";
}

/** Review / approve a reviewed change plan. SQL/tier/drift are
 * textContent-only; the Approve and Reject buttons invoke the supplied
 * handlers EXACTLY ONCE each — after the first click both buttons are
 * disabled so a double-dispatch cannot post duplicate wire messages. */
export function appendChangePlanCard(
  thread: HTMLElement,
  plan: {
    intent: string;
    statements: Array<{ sql: string; tier: string; dangerNote: string }>;
    drift: string[];
    drifted: boolean;
  },
  handlers: { onApprove(): void; onReject(): void },
): HTMLElement {
  const card = document.createElement("div");
  card.className = "UnicDB-chat-plan";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "reviewed change plan");

  const head = document.createElement("div");
  head.className = "UnicDB-chat-plan-head";
  head.textContent = `Change plan — ${plan.intent || "no intent"}`;
  card.appendChild(head);

  for (const st of plan.statements) {
    const row = document.createElement("div");
    row.className = `UnicDB-chat-plan-stmt UnicDB-chat-plan-tier-${planTierSuffix(st.tier)}`;
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

  if (plan.drift.length > 0) {
    const driftBox = document.createElement("div");
    driftBox.className = "UnicDB-chat-plan-drift";
    const title = document.createElement("div");
    title.textContent = plan.drifted
      ? "Schema drift detected — plan is stale. Re-run the suggestion before approving."
      : "Drift notes:";
    driftBox.appendChild(title);
    for (const line of plan.drift) {
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
  approve.disabled = plan.drifted;
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "UnicDB-chat-plan-reject";
  reject.textContent = "Reject";

  // Caller-supplied handlers fire exactly once; each button disables
  // itself on first click so a subsequent click on the SAME button
  // cannot post a second wire reply. The other button stays enabled so
  // the user can still change their mind after a partial action.
  let approveFired = false;
  let rejectFired = false;
  approve.addEventListener("click", () => {
    if (approveFired) return;
    approveFired = true;
    handlers.onApprove();
    approve.disabled = true;
  });
  reject.addEventListener("click", () => {
    if (rejectFired) return;
    rejectFired = true;
    handlers.onReject();
    reject.disabled = true;
  });

  actions.appendChild(approve);
  actions.appendChild(reject);
  card.appendChild(actions);

  thread.appendChild(card);
  return card;
}

// ------------------------------------------------------------------
// Error / notice bubbles.
// ------------------------------------------------------------------

/** Append an error bubble (apiKey-free per the wire contract). */
export function appendErrorBubble(
  thread: HTMLElement,
  message: string,
): HTMLElement {
  const div = document.createElement("div");
  div.className = "UnicDB-chat-error";
  div.textContent = message;
  thread.appendChild(div);
  return div;
}

/** Append a local notice bubble (e.g. transcript-exported confirmation,
 * context summary). Reuses the TASK-002 notice class so the existing
 * stylesheet continues to apply. */
export function appendNoticeBubble(
  thread: HTMLElement,
  message: string,
): HTMLElement {
  const div = document.createElement("div");
  div.className = "UnicDB-chat-local-notice";
  div.textContent = message;
  thread.appendChild(div);
  return div;
}

// ------------------------------------------------------------------
// Usage chip (per-turn + session totals + policy notice).
// ------------------------------------------------------------------

/** Render the per-turn + session usage chip inside `container`. The
 * `usage` frame is SHAPE-SAFE by contract (numeric + notice-string
 * only); the chip is textContent-ONLY — no innerHTML, no child nodes
 * other than the chip itself. `unknown: true` renders a fixed
 * "tokens unknown" label instead of the per-turn zeros, so the
 * displayed value is never a confirmed zero-cost turn. */
export function renderUsageChip(
  container: HTMLElement,
  usage: {
    inputTokens: number;
    outputTokens: number;
    unknown: boolean;
    sessionTokens: { inputTokens: number; outputTokens: number };
    policyNotice: string;
  },
): void {
  const inTok = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outTok = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  const inSes = Number.isFinite(usage.sessionTokens?.inputTokens)
    ? usage.sessionTokens.inputTokens
    : 0;
  const outSes = Number.isFinite(usage.sessionTokens?.outputTokens)
    ? usage.sessionTokens.outputTokens
    : 0;
  const turnLabel = usage.unknown
    ? "tokens unknown"
    : `${inTok} in / ${outTok} out`;
  const parts: string[] = [
    `Turn: ${turnLabel}`,
    `Session: ${inSes} in / ${outSes} out`,
  ];
  if (typeof usage.policyNotice === "string" && usage.policyNotice.length > 0) {
    parts.push(usage.policyNotice);
  }
  const chip = document.createElement("span");
  chip.className = usage.unknown
    ? "UnicDB-chat-usage UnicDB-chat-usage-unknown"
    : "UnicDB-chat-usage UnicDB-chat-usage-known";
  chip.textContent = parts.join(" — ");
  chip.title = "AI token usage for this turn and this panel session";
  container.appendChild(chip);
}
