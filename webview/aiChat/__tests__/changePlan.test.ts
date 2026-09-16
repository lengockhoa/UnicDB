// webview/aiChat/__tests__/changePlan.test.ts — TASK-CHATV2-014
//
// Covers the reviewed SQL change-plan card (`webview/aiChat/changePlan.ts`):
//   - a clean plan renders title/intent/statements and enables Approve;
//   - a DRIFTED plan disables `Approve & run` and states the drift;
//   - SQL is DOM-safe (a `<script>` statement renders as literal text);
//   - approve and reject each emit EXACTLY ONCE under a double-click;
//   - approval stays a request: the card runs no SQL and calls no transport.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHANGE_PLAN_APPROVE_LABEL,
  CHANGE_PLAN_DRIFT_TITLE,
  CHANGE_PLAN_MARKER,
  CHANGE_PLAN_REJECT_LABEL,
  CHANGE_PLAN_TITLE,
  renderChangePlanCard,
  tierTone,
  type ChangePlanCard,
  type ChangePlanData,
} from "../changePlan";

const ROOT_CLASS = "UnicDB-ai-chat-v2";

function plan(overrides: Partial<ChangePlanData> = {}): ChangePlanData {
  return {
    intent: "add a not-null column",
    statements: [
      { sql: "ALTER TABLE users ADD COLUMN c int", tier: "amber", dangerNote: "DDL" },
      { sql: "UPDATE users SET c = 1", tier: "red", dangerNote: "writes rows" },
    ],
    drift: [],
    drifted: false,
    ...overrides,
  };
}

function mount(): HTMLElement {
  const node = document.createElement("div");
  document.body.appendChild(node);
  return node;
}

function render(
  data: ChangePlanData,
  onApprove = vi.fn(),
  onReject = vi.fn(),
): { card: ChangePlanCard; onApprove: ReturnType<typeof vi.fn>; onReject: ReturnType<typeof vi.fn>; host: HTMLElement } {
  const host = mount();
  const card = renderChangePlanCard({ mount: host, plan: data, tool: "plan_change", onApprove, onReject });
  return { card, onApprove, onReject, host };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("TASK-CHATV2-014 change plan — rendering", () => {
  it("renders the title, intent and every statement with its tier", () => {
    const { host } = render(plan());
    expect(host.querySelector(`[${CHANGE_PLAN_MARKER}]`)).not.toBeNull();
    expect(host.querySelector(`.${ROOT_CLASS}-change-plan-title`)!.textContent).toBe(CHANGE_PLAN_TITLE);
    expect(host.querySelector(`.${ROOT_CLASS}-change-plan-intent`)!.textContent).toBe("add a not-null column");
    const statements = host.querySelectorAll(`.${ROOT_CLASS}-change-plan-statement`);
    expect(statements).toHaveLength(2);
    expect(statements[0].getAttribute("data-tier")).toBe("warning");
    expect(statements[1].getAttribute("data-tier")).toBe("danger");
  });

  it("maps wire tiers to the closed visual set and never uses the wire value as a class", () => {
    expect(tierTone("red")).toBe("danger");
    expect(tierTone("amber")).toBe("warning");
    expect(tierTone("none")).toBe("neutral");
    // A hostile tier is neutral, never a class name.
    const hostile = `<img src=x>` as string;
    expect(tierTone(hostile)).toBe("neutral");
    const { host } = render(plan({ statements: [{ sql: "SELECT 1", tier: hostile, dangerNote: "" }] }));
    const badge = host.querySelector(`.${ROOT_CLASS}-change-plan-tier`)!;
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.textContent).toBe(hostile);
    expect(host.querySelector("img")).toBeNull();
  });

  it("writes SQL as DOM-safe text inside a code element", () => {
    const evilSql = `DROP TABLE x; -- <script>window.__pwned=1</script>`;
    const { host } = render(plan({ statements: [{ sql: evilSql, tier: "red", dangerNote: "" }] }));
    const code = host.querySelector(`.${ROOT_CLASS}-change-plan-sql code`)!;
    expect(code.textContent).toBe(evilSql);
    expect(code.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("TASK-CHATV2-014 change plan — drift gates Approve", () => {
  it("enables Approve on a clean plan and disables it when drifted", () => {
    const clean = render(plan());
    expect(clean.card.isApproveEnabled()).toBe(true);
    const approve = clean.host.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
    expect(approve.disabled).toBe(false);

    const drifted = render(plan({ drifted: true, drift: ["column b was dropped"] }));
    expect(drifted.card.isApproveEnabled()).toBe(false);
    const disabled = drifted.host.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
    expect(disabled.disabled).toBe(true);
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    // The drift is stated in plain text.
    expect(drifted.host.querySelector(`.${ROOT_CLASS}-change-plan-drift-title`)!.textContent).toBe(
      CHANGE_PLAN_DRIFT_TITLE,
    );
    expect(drifted.host.querySelector(`.${ROOT_CLASS}-change-plan-drift-list`)!.textContent).toContain(
      "column b was dropped",
    );
  });

  it("a drifted Approve is inert even when clicked programmatically", () => {
    const data = plan({ drifted: true, drift: ["x"] });
    const { onApprove, host } = render(data);
    host.querySelector<HTMLButtonElement>('[data-action="approve"]')!.dispatchEvent(new MouseEvent("click"));
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe("TASK-CHATV2-014 change plan — single outcome", () => {
  it("approve emits exactly once under a double-click", () => {
    const { card, onApprove, host } = render(plan());
    const approve = host.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
    approve.dispatchEvent(new MouseEvent("click"));
    approve.dispatchEvent(new MouseEvent("click"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(card.lastOutcome()).toBe("approve");
  });

  it("reject emits exactly once and blocks a later approve", () => {
    const { card, onApprove, onReject, host } = render(plan());
    const reject = host.querySelector<HTMLButtonElement>('[data-action="reject"]')!;
    reject.dispatchEvent(new MouseEvent("click"));
    reject.dispatchEvent(new MouseEvent("click"));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(card.lastOutcome()).toBe("reject");
    // A stale double-click on approve after reject sends nothing.
    host.querySelector<HTMLButtonElement>('[data-action="approve"]')!.dispatchEvent(new MouseEvent("click"));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("labels the two actions with the pinned copy", () => {
    const { host } = render(plan());
    expect(host.querySelector('[data-action="approve"]')!.textContent).toBe(CHANGE_PLAN_APPROVE_LABEL);
    expect(host.querySelector('[data-action="reject"]')!.textContent).toBe(CHANGE_PLAN_REJECT_LABEL);
  });
});
