// webview/aiChat/__tests__/permissions.test.ts — TASK-CHATV2-014
//
// Covers the permission POLICY sheet, the bypass warning modal and the anchored
// permission REQUEST sheet from `webview/aiChat/permissions.ts`:
//   #1 security  — Enter/default never approves; Deny is the safe shape.
//   #2 capability — bypass row hidden without capability; warning + Cancel.
//   #3 race      — duplicate/replaced/settled requests emit exactly one answer.
//   #4 a11y      — focus trap, focus restore, Escape semantics.
//   #5 security  — hostile/long detail stays text, collapses >120/newlines.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BYPASS_CANCEL_LABEL,
  BYPASS_ENABLE_LABEL,
  BYPASS_WARNING_COPY,
  PERMISSION_ALLOW_ONCE_LABEL,
  PERMISSION_ALWAYS_ALLOW_LABEL,
  PERMISSION_DETAILS_SHOW_LABEL,
  PERMISSION_DENY_LABEL,
  PERMISSION_DETAIL_COLLAPSE_THRESHOLD,
  PERMISSION_LABEL_ASK,
  PERMISSION_LABEL_BYPASS,
  createBypassWarning,
  createPermissionRequestSheet,
  createPolicySheet,
  permissionChipLabel,
  renderPermissionChip,
  policyDescription,
  shouldCollapseDetail,
  type PermissionRequestInput,
  type PermissionResponse,
} from "../permissions";
import {
  OVERLAY_FOCUS_TRAP_MARKER,
  OVERLAY_MODAL_MARKER,
} from "../overlays";

const ROOT_CLASS = "UnicDB-ai-chat-v2";

function request(overrides: Partial<PermissionRequestInput> = {}): PermissionRequestInput {
  return {
    requestId: "req-opaque-1",
    tool: { id: "tool-1", name: "Run SQL", detail: "delete from users" },
    options: [
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ],
    ...overrides,
  };
}

function mountPoint(): HTMLElement {
  const node = document.createElement("div");
  document.body.appendChild(node);
  return node;
}

/** A focusable stand-in for `promptV2` (the composer restore target). */
function composerPoint(): HTMLElement {
  const node = document.createElement("input");
  document.body.appendChild(node);
  return node;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- #1 composer chip labels + policy sheet --------------------------------

describe("TASK-CHATV2-014 #1 — policy chip + policy sheet", () => {
  it("maps the policy to exactly the pinned chip labels", () => {
    expect(permissionChipLabel("default")).toBe(PERMISSION_LABEL_ASK);
    expect(permissionChipLabel("bypass")).toBe(PERMISSION_LABEL_BYPASS);
    expect(PERMISSION_LABEL_ASK).toBe("Permissions: Ask");
  });

  it("hides the composer chip on an unsupported engine and renders the policy otherwise", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);

    renderPermissionChip(button, false, "default");
    expect(button.hidden).toBe(true);

    renderPermissionChip(button, true, "default");
    expect(button.hidden).toBe(false);
    expect(button.getAttribute("aria-label")).toBe(PERMISSION_LABEL_ASK);
    expect(button.title).toBe(PERMISSION_LABEL_ASK);
    expect(button.querySelector("svg")).not.toBeNull();

    renderPermissionChip(button, true, "bypass");
    expect(button.getAttribute("aria-label")).toBe(PERMISSION_LABEL_BYPASS);
    // A bypass chip uses the alert shield, never the same glyph as "ask".
    expect(button.querySelector('[data-icon="shield-alert"]')).not.toBeNull();
  });

  it("describes the current policy and cannot resolve a pending request", () => {
    const anchor = mountPoint();
    const trigger = document.createElement("button");
    anchor.appendChild(trigger);
    let bypassRequests = 0;
    const sheet = createPolicySheet({
      anchor,
      trigger,
      supportsBypass: true,
      currentPolicy: "default",
      onRequestBypass: () => { bypassRequests += 1; },
    });

    sheet.open();
    const rows = sheet.getRows();
    expect(rows[0].description).toBe(policyDescription("default"));
    // The description row is not selectable.
    expect(rows[0].disabled).toBe(true);
    // Only the bypass row can ever report intent; the sheet has no deny path.
    expect(rows.some((r) => r.id === "deny")).toBe(false);
    sheet.destroy();
    expect(bypassRequests).toBe(0);
  });
});

// ---- #2 capability gate + bypass warning -----------------------------------

describe("TASK-CHATV2-014 #2 — bypass capability + warning", () => {
  it("hides the bypass row when the host capability is false", () => {
    const anchor = mountPoint();
    const trigger = document.createElement("button");
    anchor.appendChild(trigger);
    const sheet = createPolicySheet({
      anchor,
      trigger,
      supportsBypass: false,
      currentPolicy: "default",
      onRequestBypass: () => {},
    });
    expect(sheet.getRows().some((r) => r.id === "bypass")).toBe(false);
    sheet.destroy();
  });

  it("shows the exact warning copy with Cancel as the safe default", () => {
    const mount = mountPoint();
    let enabled = 0;
    let cancelled = 0;
    const warning = createBypassWarning({
      mount,
      onEnable: () => { enabled += 1; },
      onCancel: () => { cancelled += 1; },
    });
    warning.open();

    const body = document.querySelector(`.${ROOT_CLASS}-overlay-modal-body`);
    expect(body!.textContent).toBe(BYPASS_WARNING_COPY);
    expect(warning.focusedActionId()).toBe("cancel");
    expect(document.activeElement?.textContent).toBe(BYPASS_CANCEL_LABEL);

    // Escape cancels — it can never enable.
    document.querySelector(`.${ROOT_CLASS}-overlay-modal`)!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(enabled).toBe(0);
    expect(cancelled).toBe(1);
    expect(warning.isOpen()).toBe(false);

    // Explicit Enable is the only path that reports intent.
    warning.open();
    const enableBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(`.${ROOT_CLASS}-overlay-modal-action`),
    ).find((b) => b.textContent === BYPASS_ENABLE_LABEL)!;
    enableBtn.dispatchEvent(new MouseEvent("click"));
    expect(enabled).toBe(1);
  });
});

// ---- #3 race: one/zero exact response --------------------------------------

describe("TASK-CHATV2-014 #3 — one opaque response per request", () => {
  it("emits exactly one response with the exact opaque optionId", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const responses: PermissionResponse[] = [];
    const sheet = createPermissionRequestSheet({
      anchor,
      composer,
      onRespond: (r) => responses.push(r),
    });

    sheet.show(request());
    const allowBtn = anchor.querySelector<HTMLButtonElement>('[data-action="allow-once"]')!;
    allowBtn.dispatchEvent(new MouseEvent("click"));
    // Late duplicate click is inert.
    allowBtn.dispatchEvent(new MouseEvent("click"));

    expect(responses).toEqual([{ requestId: "req-opaque-1", optionId: "allow-once" }]);
    sheet.destroy();
  });

  it("Deny emits the requestId with no optionId (never a fabricated allow)", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const responses: PermissionResponse[] = [];
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: (r) => responses.push(r) });
    sheet.show(request());
    anchor.querySelector<HTMLButtonElement>('[data-action="deny"]')!.dispatchEvent(new MouseEvent("click"));
    expect(responses).toEqual([{ requestId: "req-opaque-1" }]);
    expect(responses[0].optionId).toBeUndefined();
    sheet.destroy();
  });

  it("a replaced request's old controls send nothing after replacement", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const responses: PermissionResponse[] = [];
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: (r) => responses.push(r) });
    sheet.show(request({ requestId: "req-1" }));
    const firstDeny = anchor.querySelector<HTMLButtonElement>('[data-action="deny"]')!;
    // Replace with a new request; the old button is detached and sealed.
    sheet.show(request({ requestId: "req-2" }));
    firstDeny.dispatchEvent(new MouseEvent("click"));
    expect(responses).toEqual([]);
    // The new sheet still answers its own request.
    anchor.querySelector<HTMLButtonElement>('[data-action="deny"]')!.dispatchEvent(new MouseEvent("click"));
    expect(responses).toEqual([{ requestId: "req-2" }]);
    sheet.destroy();
  });

  it("offers Always allow only when the host exposes the session option", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const onRespond = vi.fn();
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond });

    sheet.show(request());
    expect(anchor.textContent).toContain(PERMISSION_ALLOW_ONCE_LABEL);
    expect(anchor.textContent).not.toContain(PERMISSION_ALWAYS_ALLOW_LABEL);
    expect(anchor.textContent).toContain(PERMISSION_DENY_LABEL);

    sheet.show(
      request({
        requestId: "req-2",
        options: [
          { optionId: "allow-once", label: "Allow once" },
          { optionId: "allow-session", label: "Allow for this session" },
          { optionId: "deny", label: "Deny" },
        ],
      }),
    );
    expect(anchor.textContent).toContain(PERMISSION_ALWAYS_ALLOW_LABEL);
    anchor.querySelector<HTMLButtonElement>('[data-action="allow-session"]')!.dispatchEvent(new MouseEvent("click"));
    expect(onRespond).toHaveBeenCalledWith({ requestId: "req-2", optionId: "allow-session" });
    sheet.destroy();
  });
});

// ---- #4 a11y: focus trap / restore / Escape --------------------------------

describe("TASK-CHATV2-014 #4 — focus handling", () => {
  it("traps Tab among the sheet controls and never leaves the sheet", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: () => {} });
    sheet.show(request());
    expect(sheet.element.getAttribute(OVERLAY_FOCUS_TRAP_MARKER)).toBe("1");

    const buttons = Array.from(anchor.querySelectorAll<HTMLButtonElement>("button"));
    buttons[0].focus();
    // Shift+Tab from the first control wraps to the last.
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    // Tab from the last wraps back to the first.
    buttons[buttons.length - 1].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
    sheet.destroy();
  });

  it("restores the composer on dispose and never approves on Escape", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const responses: PermissionResponse[] = [];
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: (r) => responses.push(r) });
    composer.focus();
    sheet.show(request());
    // Escape with no host contract must NOT approve or deny.
    sheet.handleKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(responses).toEqual([]);
    expect(sheet.isOpen()).toBe(true);

    sheet.settle();
    expect(document.activeElement).toBe(composer);
    expect(sheet.isOpen()).toBe(false);
    sheet.destroy();
  });

  it("ordinary Escape chooses Deny only when the host contract defines it", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const responses: PermissionResponse[] = [];
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: (r) => responses.push(r) });
    sheet.show(request({ escapeChoosesDeny: true }));
    sheet.handleKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(responses).toEqual([{ requestId: "req-opaque-1" }]);
    sheet.destroy();
  });

  it("destructive Escape opens a deny confirmation whose safe default is not Deny", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const responses: PermissionResponse[] = [];
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: (r) => responses.push(r) });
    sheet.show(request({ tool: { id: "t", name: "Drop table", detail: "drop table x", destructive: true } }));

    sheet.handleKey(new KeyboardEvent("keydown", { key: "Escape" }));
    // No approval, no implicit deny — a confirmation is shown instead.
    expect(responses).toEqual([]);
    const confirm = document.querySelector(`[${OVERLAY_MODAL_MARKER}]`);
    expect(confirm).not.toBeNull();
    expect(confirm!.getAttribute("role")).toBe("alertdialog");
    // The safe default is "keep waiting".
    expect(document.activeElement?.textContent).toBe("Keep waiting");

    // Only the explicit deny inside the confirmation answers.
    Array.from(document.querySelectorAll<HTMLButtonElement>(`.${ROOT_CLASS}-overlay-modal-action`))
      .find((b) => b.textContent === PERMISSION_DENY_LABEL)!
      .dispatchEvent(new MouseEvent("click"));
    expect(responses).toEqual([{ requestId: "req-opaque-1" }]);
    sheet.destroy();
  });

  it("announces exactly one concise line per request", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const live = mountPoint();
    const sheet = createPermissionRequestSheet({ anchor, composer, liveRegion: live, onRespond: () => {} });
    sheet.show(request({ tool: { id: "t", name: "Run SQL", detail: "x".repeat(400) } }));
    expect(live.textContent).toBe("Permission needed: Run SQL");
    // The hostile 400-char detail is never announced.
    expect(live.textContent).not.toContain("xxxx");
    sheet.destroy();
  });
});

// ---- #5 hostile / long detail ----------------------------------------------

describe("TASK-CHATV2-014 #5 — hostile and long tool details", () => {
  it("renders a script payload as text and collapses a long detail", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const hostile = `<img src=x onerror="window.__pwned=1">`;
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: () => {} });
    sheet.show(request({ tool: { id: "t", name: hostile, detail: "y".repeat(200) } }));

    // No element was created from the payload.
    expect(anchor.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(anchor.querySelector(`.${ROOT_CLASS}-permission-tool-name`)!.textContent).toBe(hostile);

    // Long detail collapses behind the toggle and starts hidden.
    const detailText = anchor.querySelector<HTMLElement>(`.${ROOT_CLASS}-permission-tool-detail-text`)!;
    expect(shouldCollapseDetail("y".repeat(200))).toBe(true);
    expect(detailText.hidden).toBe(true);
    expect(anchor.textContent).toContain(PERMISSION_DETAILS_SHOW_LABEL);

    // Copy stays absent unless the host marked the detail safe.
    expect(anchor.querySelector('[data-action="copy-detail"]')).toBeNull();
    sheet.destroy();
  });

  it("collapses a multiline detail even when it is short", () => {
    expect(shouldCollapseDetail("line1\nline2")).toBe(true);
    expect(shouldCollapseDetail("short")).toBe(false);
    expect(shouldCollapseDetail("z".repeat(PERMISSION_DETAIL_COLLAPSE_THRESHOLD))).toBe(false);
    expect(shouldCollapseDetail("z".repeat(PERMISSION_DETAIL_COLLAPSE_THRESHOLD + 1))).toBe(true);
  });

  it("offers Copy only when the host marks the detail copyable", () => {
    const anchor = mountPoint();
    const composer = composerPoint();
    const onCopyDetail = vi.fn();
    const sheet = createPermissionRequestSheet({ anchor, composer, onRespond: () => {}, onCopyDetail });
    sheet.show(request({ tool: { id: "t", name: "Run SQL", detail: "safe detail", copyable: true } }));
    const copy = anchor.querySelector<HTMLButtonElement>('[data-action="copy-detail"]')!;
    copy.dispatchEvent(new MouseEvent("click"));
    expect(onCopyDetail).toHaveBeenCalledWith("safe detail");
    sheet.destroy();
  });
});
