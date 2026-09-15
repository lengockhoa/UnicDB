// webview/aiChat/__tests__/sessions.test.ts — TASK-CHATV2-015
//
// Contract tests for the session UX: the overflow menu inventory, new/clear
// confirmations, inline rename (Enter waits for the host `title_updated` ack,
// Escape reverts, failure keeps the edit + toasts), the <=20-entry cwd-scoped
// resume picker with truthful saved-transcript copy, the export dialog
// (success ONLY on `export_completed`), and stale-response correlation by
// clientRequestId AND sessionId.
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLEAR_CONFIRM_COPY,
  EXPORT_FAILURE_LABEL,
  EXPORT_SUCCESS_LABEL,
  NATIVE_RESUME_DISCLAIMER,
  OVERFLOW_LABEL,
  RESUME_EMPTY_LABEL,
  RESUME_PICKER_LABEL,
  SESSIONS_IDS,
  SESSIONS_MENU_ITEMS,
  createSessionsController,
  type SessionsCallbacks,
  type SessionsController,
  type SessionsViewState,
} from "../sessions";
import type { AiChatHostFrameV2 } from "../../../src/ui/aiChatPanelMessages";

const PREFIX = "UnicDB-ai-chat-v2";
const NATIVE_RESUME_LABEL = RESUME_PICKER_LABEL;

const STYLES = readFileSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"), "utf8");
const SESSIONS_SRC = readFileSync(resolve(process.cwd(), "webview", "aiChat", "sessions.ts"), "utf8");

function baseState(overrides: Partial<SessionsViewState> = {}): SessionsViewState {
  return {
    sessionId: "sess-live",
    title: "Live chat",
    hasHistory: true,
    hasDraft: false,
    busy: false,
    sessions: [],
    diagnosticIds: [],
    engine: "omp",
    model: "unic-sonnet",
    ...overrides,
  };
}

interface Recorder {
  calls: Array<{ kind: string; args: unknown[] }>;
  callbacks: SessionsCallbacks;
}

function makeCallbacks(): Recorder {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const record =
    (kind: string) =>
    (...args: unknown[]): void => {
      calls.push({ kind, args });
    };
  const callbacks: SessionsCallbacks = {
    onNewSession: record("new"),
    onRenameSession: record("rename"),
    onClearSession: record("clear"),
    onExportSession: record("export"),
    onResumeSession: record("resume"),
    onListSessions: record("list"),
    onOpenSettings: record("settings"),
    onCopyDiagnostics: record("copyDiagnostics"),
  };
  return { calls, callbacks };
}

let root: HTMLElement;
let header: HTMLElement;
let status: HTMLElement;
let alert: HTMLElement;
let controller: SessionsController;
let recorder: Recorder;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  root.className = PREFIX;
  header = document.createElement("header");
  header.className = `${PREFIX}-header`;
  const overflow = document.createElement("button");
  overflow.id = SESSIONS_IDS.overflowButton;
  overflow.type = "button";
  header.appendChild(overflow);
  root.appendChild(header);
  status = document.createElement("div");
  alert = document.createElement("div");
  root.appendChild(status);
  root.appendChild(alert);
  document.body.appendChild(root);

  recorder = makeCallbacks();
  controller = createSessionsController(
    { root, header, statusLiveRegion: status, alertLiveRegion: alert },
    recorder.callbacks,
  );
  controller.render(baseState());
});

afterEach(() => {
  controller?.dispose();
  vi.useRealTimers();
});

function menuRows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`#${SESSIONS_IDS.menu} button`));
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${PREFIX}-dialog`);
}

function dialogButtons(): HTMLButtonElement[] {
  const d = dialog();
  return d ? Array.from(d.querySelectorAll<HTMLButtonElement>("button")) : [];
}

function key(node: HTMLElement, k: string, init: KeyboardEventInit = {}): void {
  node.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
}

// ---------------------------------------------------------------------------
// menu inventory
// ---------------------------------------------------------------------------

describe("CHATV2-015 #5 — overflow menu", () => {
  it("lists New chat, Rename, Export, Clear, Diagnostics, Settings in order", () => {
    controller.openMenu();
    expect(menuRows().map((r) => r.textContent)).toEqual([
      "New chat",
      "Rename",
      "Export",
      "Clear",
      "Diagnostics",
      "Settings",
    ]);
    expect(controller.isMenuOpen()).toBe(true);
    expect(header.querySelector(`#${SESSIONS_IDS.overflowButton}`)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("rows are >=40px and dialogs declare modal semantics in CSS/source", () => {
    // Row height is a CSS contract (jsdom cannot prove layout).
    expect(STYLES).toMatch(/\.UnicDB-ai-chat-v2-menu-row[\s\S]*?min-height:\s*(4[0-9]|[5-9][0-9])px/);
    controller.openExportDialog();
    const d = dialog()!;
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
  });

  it("Escape closes the menu and ArrowDown moves the roving focus", () => {
    controller.openMenu();
    key(document.body, "ArrowDown");
    const rows = menuRows();
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    key(document.body, "Escape");
    expect(controller.isMenuOpen()).toBe(false);
    expect(header.querySelector(`#${SESSIONS_IDS.overflowButton}`)!.getAttribute("aria-expanded")).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// new / clear confirmations
// ---------------------------------------------------------------------------

describe("CHATV2-015 #5 — new / clear confirmations", () => {
  it("New with history asks first, then preserves the old session", () => {
    controller.openMenu();
    menuRows().find((r) => r.textContent === "New chat")!.click();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("keeps this chat saved");
    // Cancel → nothing emitted.
    dialogButtons().find((b) => b.textContent === "Cancel")!.click();
    expect(recorder.calls.filter((c) => c.kind === "new")).toHaveLength(0);

    controller.openMenu();
    menuRows().find((r) => r.textContent === "New chat")!.click();
    dialogButtons().find((b) => b.textContent === "Start new chat")!.click();
    const created = recorder.calls.find((c) => c.kind === "new");
    expect(created).toBeDefined();
    // The old session id rides along so the host can preserve it.
    expect(created!.args[1]).toBe("sess-live");
  });

  it("New with a clean empty session skips the confirmation", () => {
    controller.render(baseState({ hasHistory: false, hasDraft: false }));
    controller.openMenu();
    menuRows().find((r) => r.textContent === "New chat")!.click();
    expect(dialog()).toBeNull();
    expect(recorder.calls.filter((c) => c.kind === "new")).toHaveLength(1);
  });

  it("Clear states it clears only the current transcript and never deletes siblings", () => {
    controller.openMenu();
    menuRows().find((r) => r.textContent === "Clear")!.click();
    expect(dialog()!.textContent).toContain("other saved UnicDB chats are kept");
    dialogButtons().find((b) => b.textContent === "Clear transcript")!.click();
    const clearCall = recorder.calls.find((c) => c.kind === "clear");
    expect(clearCall).toBeDefined();
    expect(clearCall!.args[1]).toBe("sess-live");
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("CHATV2-015 #5 — inline rename", () => {
  it("Enter emits a rename request and waits for the title_updated ack", () => {
    controller.beginRename();
    const input = document.querySelector<HTMLInputElement>(`#${SESSIONS_IDS.titleInput}`)!;
    expect(input).not.toBeNull();
    input.value = "Renamed chat";
    key(input, "Enter");
    const call = recorder.calls.find((c) => c.kind === "rename");
    expect(call).toBeDefined();
    expect(call!.args[1]).toBe("sess-live");
    expect(call!.args[2]).toBe("Renamed chat");
    // Still editing until the host acks.
    expect(document.querySelector(`#${SESSIONS_IDS.titleInput}`)).not.toBeNull();

    const frame: AiChatHostFrameV2 = {
      protocolVersion: 2,
      sessionId: "sess-live",
      sequence: 2,
      kind: "title_updated",
      title: "Renamed chat",
    };
    controller.applyHostFrame(frame);
    expect(document.querySelector(`#${SESSIONS_IDS.titleInput}`)).toBeNull();
    expect(header.textContent).toContain("Renamed chat");
  });

  it("Escape reverts without emitting a request", () => {
    controller.beginRename();
    const input = document.querySelector<HTMLInputElement>(`#${SESSIONS_IDS.titleInput}`)!;
    input.value = "discard me";
    key(input, "Escape");
    expect(document.querySelector(`#${SESSIONS_IDS.titleInput}`)).toBeNull();
    expect(recorder.calls.filter((c) => c.kind === "rename")).toHaveLength(0);
    expect(header.textContent).toContain("Live chat");
  });

  it("a failed save keeps the edit visible and toasts a safe message", () => {
    controller.beginRename();
    const input = document.querySelector<HTMLInputElement>(`#${SESSIONS_IDS.titleInput}`)!;
    input.value = "Keep me";
    key(input, "Enter");
    const requestId = recorder.calls.find((c) => c.kind === "rename")!.args[0] as string;
    controller.notifyRenameFailed(requestId, "The title could not be saved.");
    // The input (with the user's edit) survives the failure.
    expect(document.querySelector<HTMLInputElement>(`#${SESSIONS_IDS.titleInput}`)?.value).toBe("Keep me");
    expect(alert.textContent).toContain("Rename failed");
  });
});

// ---------------------------------------------------------------------------
// resume picker
// ---------------------------------------------------------------------------

describe("CHATV2-015 #5/#7 — resume picker", () => {
  it("labels the picker as a saved UnicDB chat and never claims native resume", () => {
    controller.openResumePicker();
    expect(recorder.calls.some((c) => c.kind === "list")).toBe(true);
    const d = dialog()!;
    expect(d.getAttribute("aria-label")).toBe(NATIVE_RESUME_LABEL);
    expect(NATIVE_RESUME_LABEL).toBe("Resume saved UnicDB chat");
    expect(d.textContent).toContain(NATIVE_RESUME_DISCLAIMER);
    expect(d.dataset["nativeResume"]).toBe("false");
  });

  it("renders <=20 entries with opaque exact-echo ids and resumes on select", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      sessionId: `s-${i}`,
      label: `chat ${i}`,
      detail: `${i} messages`,
    }));
    controller.applyHostFrame({
      protocolVersion: 2,
      sessionId: "sess-live",
      sequence: 3,
      kind: "sessions",
      items: entries,
    });
    controller.openResumePicker();
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>(`.${PREFIX}-resume-row`));
    expect(rows).toHaveLength(20);
    expect(rows[0]!.dataset["sessionId"]).toBe("s-0");
    rows[4]!.click();
    const resume = recorder.calls.find((c) => c.kind === "resume");
    expect(resume!.args[1]).toBe("s-4");
  });

  it("shows an honest empty state", () => {
    controller.openResumePicker();
    expect(dialog()!.textContent).toContain(RESUME_EMPTY_LABEL);
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe("CHATV2-015 #6 — export dialog", () => {
  it("emits a format choice and announces success ONLY on export_completed", () => {
    controller.openExportDialog();
    dialogButtons().find((b) => b.textContent === "JSON")!.click();
    const call = recorder.calls.find((c) => c.kind === "export");
    expect(call).toBeDefined();
    expect(call!.args[1]).toBe("sess-live");
    expect(call!.args[2]).toBe("json");
    // No optimistic success.
    expect(status.textContent).not.toBe(EXPORT_SUCCESS_LABEL);

    controller.applyHostFrame({
      protocolVersion: 2,
      sessionId: "sess-live",
      sequence: 4,
      kind: "export_completed",
      format: "json",
      name: "chat.json",
    });
    expect(status.textContent).toBe(EXPORT_SUCCESS_LABEL);
  });

  it("failure surfaces the exact 'Could not export chat' copy plus a safe reason", () => {
    controller.openExportDialog();
    dialogButtons().find((b) => b.textContent === "Markdown")!.click();
    controller.applyHostFrame({
      protocolVersion: 2,
      sessionId: "sess-live",
      sequence: 5,
      kind: "export_failed",
      safeMessage: "The destination was not writable.",
      diagnosticId: "exp-abc",
    });
    expect(alert.textContent).toContain(EXPORT_FAILURE_LABEL);
    expect(alert.textContent).not.toBe(EXPORT_SUCCESS_LABEL);
  });

  it("cancel closes the dialog with no request and no success", () => {
    controller.openExportDialog();
    dialogButtons().find((b) => b.textContent === "Cancel")!.click();
    expect(dialog()).toBeNull();
    expect(recorder.calls.filter((c) => c.kind === "export")).toHaveLength(0);
    expect(status.textContent).not.toBe(EXPORT_SUCCESS_LABEL);
  });
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

describe("CHATV2-015 — diagnostics", () => {
  it("copies the short id + safe metadata only, never raw trace", () => {
    controller.render(baseState({ diagnosticIds: ["diag-1"] }));
    controller.openDiagnostics();
    const pre = dialog()!.querySelector(`.${PREFIX}-diagnostics-body`)!;
    expect(pre.textContent).toContain("sess-live");
    expect(pre.textContent).toContain("diag-1");
    expect(pre.textContent).not.toMatch(/stderr|trace|stack/i);
    dialogButtons().find((b) => b.textContent === "Copy")!.click();
    const copy = recorder.calls.find((c) => c.kind === "copyDiagnostics");
    expect(copy!.args[0]).toContain("sess-live");
  });
});

// ---------------------------------------------------------------------------
// race: stale response
// ---------------------------------------------------------------------------

describe("CHATV2-015 #9 — stale response correlation", () => {
  it("an old session's export ack cannot announce success on the live session", () => {
    controller.openExportDialog();
    dialogButtons().find((b) => b.textContent === "JSON")!.click();
    // The user switched sessions before the ack arrived.
    controller.render(baseState({ sessionId: "sess-other", title: "Other" }));
    controller.applyHostFrame({
      protocolVersion: 2,
      sessionId: "sess-live",
      sequence: 6,
      kind: "export_completed",
      format: "json",
      name: "chat.json",
    });
    expect(status.textContent).not.toBe(EXPORT_SUCCESS_LABEL);
  });

  it("a rename ack for another session cannot mutate the live title", () => {
    controller.beginRename();
    const input = document.querySelector<HTMLInputElement>(`#${SESSIONS_IDS.titleInput}`)!;
    input.value = "Stale";
    key(input, "Enter");
    controller.render(baseState({ sessionId: "sess-other", title: "Other" }));
    controller.applyHostFrame({
      protocolVersion: 2,
      sessionId: "sess-live",
      sequence: 7,
      kind: "title_updated",
      title: "Stale",
    });
    expect(header.textContent).not.toContain("Stale");
    expect(header.textContent).toContain("Other");
  });
});

// ---------------------------------------------------------------------------
// architecture boundary
// ---------------------------------------------------------------------------

describe("CHATV2-015 — boundaries", () => {
  it("the session module never scrapes the DOM for content or uses browser storage", () => {
    expect(SESSIONS_SRC).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(SESSIONS_SRC).not.toMatch(/innerText|innerHTML|outerHTML/);
    expect(SESSIONS_SRC).not.toMatch(/from ["']vscode["']/);
  });

  it("uses the closed menu inventory constant", () => {
    expect(SESSIONS_MENU_ITEMS.map((i) => i.action)).toEqual([
      "new",
      "rename",
      "export",
      "clear",
      "diagnostics",
      "settings",
    ]);
  });
});
