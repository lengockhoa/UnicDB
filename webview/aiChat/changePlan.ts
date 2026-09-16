// webview/aiChat/changePlan.ts — TASK-CHATV2-014
//
// The reviewed SQL change-plan card (V2 visuals). It mirrors the host's
// `change_plan` frame — intent, per-statement danger tier, drift report — and
// emits exactly ONE semantic outcome (approve / reject).
//
// SAFETY CONTRACT
// - The card is a REVIEW surface, never an executor. It never runs SQL, never
//   talks to the host transport and never routes around consent.
// - `Approve & run` is DISABLED whenever the plan is drifted: a stale plan must
//   never be applied. A drifted card states the drift in plain text.
// - Approval is only a REQUEST. The host funnels it through the existing
//   destructive-statement confirmation (`confirmDangerousStatements`) and the
//   workspace-trust gate; a session bypass can never skip those (the card does
//   not even know the policy).
// - Every SQL statement is written with `textContent` inside `<pre><code>`.
//   A statement carrying `<script>`/quotes renders as literal text.
// - Approve and reject each emit at most once; a double-click after the first
//   emit is inert.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { createChatIcon } from "./icons";

const ROOT_CLASS = "UnicDB-ai-chat-v2";

function cls(name: string): string {
  return `${ROOT_CLASS}-${name}`;
}

/** Marker attribute identifying a change-plan card. */
export const CHANGE_PLAN_MARKER = "data-chat-change-plan";

/** Fixed card title (the frame carries no title of its own). */
export const CHANGE_PLAN_TITLE = "Review change plan";

/** Action copy (pinned). */
export const CHANGE_PLAN_APPROVE_LABEL = "Approve & run";
export const CHANGE_PLAN_REJECT_LABEL = "Reject";

/** Shown on a drifted plan instead of an actionable approve. */
export const CHANGE_PLAN_DRIFT_TITLE = "Plan is stale";

/** One reviewed statement. `sql`/`dangerNote` are display text only. */
export interface ChangePlanStatement {
  readonly sql: string;
  readonly tier: string;
  readonly dangerNote: string;
}

/** The plan body the host frame carries. */
export interface ChangePlanData {
  readonly intent: string;
  readonly statements: readonly ChangePlanStatement[];
  readonly drift: readonly string[];
  readonly drifted: boolean;
}

export interface ChangePlanOptions {
  /** Element the card mounts into (the transcript / activity mount). */
  readonly mount: HTMLElement;
  /** The reviewed plan. */
  readonly plan: ChangePlanData;
  /** Optional tool name the plan came from (shown as safe metadata). */
  readonly tool?: string;
  /** Approve requested. Called at most once; still routes through host consent. */
  readonly onApprove: () => void;
  /** Reject chosen. Called at most once. */
  readonly onReject: () => void;
}

/** The live card handle. */
export interface ChangePlanCard {
  readonly element: HTMLElement;
  /** True while the Approve control can be activated (never when drifted). */
  isApproveEnabled(): boolean;
  /** The single emitted outcome, or null. Test/observability aid. */
  lastOutcome(): "approve" | "reject" | null;
  destroy(): void;
}

/** Visual tone for a danger tier. Unknown tiers are `neutral` — a wire value
 * is never used as a class name. */
export function tierTone(tier: string): "neutral" | "warning" | "danger" {
  const normalized = tier.trim().toLowerCase();
  if (normalized === "red" || normalized === "destructive") return "danger";
  if (normalized === "amber" || normalized === "ddl" || normalized === "dml") return "warning";
  return "neutral";
}

/**
 * Mount a reviewed change-plan card. Idempotent per mount: calling again
 * replaces the previous card there rather than stacking a second one.
 */
export function renderChangePlanCard(options: ChangePlanOptions): ChangePlanCard {
  const { mount, plan } = options;
  const previous = mount.querySelector<HTMLElement>(`[${CHANGE_PLAN_MARKER}]`);
  if (previous !== null) previous.remove();

  let emitted: "approve" | "reject" | null = null;

  const card = document.createElement("div");
  card.className = cls("change-plan");
  card.setAttribute(CHANGE_PLAN_MARKER, "1");
  card.setAttribute("role", "group");
  card.setAttribute("data-drifted", String(plan.drifted === true));

  const header = document.createElement("div");
  header.className = cls("change-plan-header");
  const title = document.createElement("span");
  title.className = cls("change-plan-title");
  // textContent only — fixed copy.
  title.textContent = CHANGE_PLAN_TITLE;
  header.appendChild(title);
  if (typeof options.tool === "string" && options.tool.length > 0) {
    const meta = document.createElement("span");
    meta.className = cls("change-plan-tool");
    meta.textContent = options.tool;
    header.appendChild(meta);
  }
  card.appendChild(header);

  const intent = document.createElement("div");
  intent.className = cls("change-plan-intent");
  // The intent is host copy; it renders as text, never markup.
  intent.textContent = plan.intent;
  card.appendChild(intent);

  if (plan.drifted === true) {
    const drift = document.createElement("div");
    drift.className = cls("change-plan-drift");
    drift.setAttribute("data-tone", "warning");
    const driftTitle = document.createElement("div");
    driftTitle.className = cls("change-plan-drift-title");
    driftTitle.textContent = CHANGE_PLAN_DRIFT_TITLE;
    drift.appendChild(driftTitle);
    if (plan.drift.length > 0) {
      const list = document.createElement("ul");
      list.className = cls("change-plan-drift-list");
      for (const entry of plan.drift) {
        const item = document.createElement("li");
        // textContent only — a hostile drift entry cannot become markup.
        item.textContent = entry;
        list.appendChild(item);
      }
      drift.appendChild(list);
    }
    card.appendChild(drift);
  }

  const statements = document.createElement("ol");
  statements.className = cls("change-plan-statements");
  for (const statement of plan.statements) {
    const item = document.createElement("li");
    item.className = cls("change-plan-statement");
    item.setAttribute("data-tier", tierTone(statement.tier));

    const head = document.createElement("div");
    head.className = cls("change-plan-statement-head");
    const badge = document.createElement("span");
    badge.className = cls("change-plan-tier");
    badge.setAttribute("data-tone", tierTone(statement.tier));
    // The tier literal is untrusted wire data: written as text, never a class.
    badge.textContent = statement.tier;
    head.appendChild(badge);
    if (statement.dangerNote.length > 0) {
      const note = document.createElement("span");
      note.className = cls("change-plan-danger-note");
      note.textContent = statement.dangerNote;
      head.appendChild(note);
    }
    item.appendChild(head);

    // SQL is DOM-safe: a `<pre><code>` with textContent, never innerHTML.
    const code = document.createElement("pre");
    code.className = cls("change-plan-sql");
    const codeText = document.createElement("code");
    codeText.textContent = statement.sql;
    code.appendChild(codeText);
    item.appendChild(code);

    statements.appendChild(item);
  }
  card.appendChild(statements);

  const actions = document.createElement("div");
  actions.className = cls("change-plan-actions");

  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = cls("change-plan-action");
  reject.setAttribute("data-action", "reject");
  reject.textContent = CHANGE_PLAN_REJECT_LABEL;
  reject.addEventListener("click", () => {
    if (emitted !== null) return;
    emitted = "reject";
    lock();
    options.onReject();
  });

  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = cls("change-plan-action");
  approve.setAttribute("data-action", "approve");
  approve.textContent = CHANGE_PLAN_APPROVE_LABEL;
  // A drifted plan can never be approved.
  approve.disabled = plan.drifted === true;
  approve.setAttribute("aria-disabled", String(plan.drifted === true));
  if (plan.drifted === true) {
    approve.title = "This plan is stale. Review the drift before approving.";
  }
  approve.addEventListener("click", () => {
    if (emitted !== null || approve.disabled) return;
    emitted = "approve";
    lock();
    // Approval is a REQUEST. The host still runs the destructive-statement
    // confirmation and workspace-trust gates — bypass can never skip them.
    options.onApprove();
  });

  actions.append(reject, approve);
  card.appendChild(actions);

  // A small shield marks the card as a reviewed/consented surface.
  const mark = document.createElement("span");
  mark.className = cls("change-plan-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(createChatIcon(plan.drifted === true ? "shield-alert" : "shield-check", 16));
  header.insertBefore(mark, header.firstChild);

  function lock(): void {
    reject.disabled = true;
    approve.disabled = true;
  }

  mount.appendChild(card);

  return {
    element: card,
    isApproveEnabled: () => emitted === null && approve.disabled === false,
    lastOutcome: () => emitted,
    destroy(): void {
      card.remove();
    },
  };
}
