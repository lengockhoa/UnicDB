// src/ui/__tests__/consolePanelBundle.test.ts — TASK-002 bundle test.
//
// Loads dist/consolePanel.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi, then asserts the TASK-002 test matrix: Run/Save buttons
// post the validated ConsoleToHostMessage payloads, empty execution is
// ignored, only Cmd/Ctrl+Enter executes, and the custom context menu offers
// "Save as SQL file" and posts the save message.
//
// IMPORTANT: must run after `npm run compile` so dist/consolePanel.js exists.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const distPath = resolve(process.cwd(), "dist", "consolePanel.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

function loadBundle(): Array<Record<string, unknown>> {
  if (!bundleSrc) {
    throw new Error(
      "dist/consolePanel.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-form-body"></div>';

  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
    () => api;
  (0, eval)(bundleSrc);
  return received;
}

function editorEl(): HTMLTextAreaElement {
  return document.getElementById("consoleSqlEditor") as HTMLTextAreaElement;
}
function runBtn(): HTMLButtonElement {
  return document.getElementById("consoleRunBtn") as HTMLButtonElement;
}
function saveBtn(): HTMLButtonElement {
  return document.getElementById("consoleSaveBtn") as HTMLButtonElement;
}

function keydownOn(
  target: HTMLTextAreaElement,
  opts: { key: string; ctrlKey?: boolean; metaKey?: boolean },
): { prevented: boolean } {
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: opts.ctrlKey === true,
    metaKey: opts.metaKey === true,
    bubbles: true,
    cancelable: true,
  });
  const pd = vi.spyOn(ev, "preventDefault");
  target.dispatchEvent(ev);
  return { prevented: pd.mock.calls.length > 0 };
}

describe("webview/consolePanelMain.ts bundle (TASK-002)", () => {
  it("#1 bundle exists after compile", () => {
    expect(bundleSrc).not.toBeNull();
    expect(bundleSrc!.length).toBeGreaterThan(0);
    // Pinned user-facing label from the context menu (acceptance criteria).
    expect(bundleSrc!).toContain("Save as SQL file");
  });

  it("#2 initial render: empty SQL textarea plus visible Run and Save controls", () => {
    loadBundle();
    const editor = editorEl();
    expect(editor).toBeTruthy();
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("");
    const run = runBtn();
    const save = saveBtn();
    expect(run).toBeTruthy();
    expect(save).toBeTruthy();
    // Visible: not marked hidden/disabled and attached to the live DOM.
    expect(run.hidden).toBe(false);
    expect(save.hidden).toBe(false);
    expect(run.disabled).toBe(false);
    expect(save.disabled).toBe(false);
    expect((run.textContent ?? "").toLowerCase()).toContain("run");
    expect((save.textContent ?? "").toLowerCase()).toContain("save");
    // The context menu exists up-front but stays out of view until a
    // right-click opens it (pinned further in #7).
    const menu = document.querySelector(
      ".vsdb-console-contextmenu",
    ) as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu!.hidden).toBe(true);
  });

  it("#3 Run button posts exactly { type:'runConsole', sql:'SELECT 1' }", () => {
    const received = loadBundle();
    editorEl().value = "SELECT 1";
    runBtn().click();
    expect(received).toEqual([{ type: "runConsole", sql: "SELECT 1" }]);
  });

  it("#4 Save button posts exactly { type:'saveConsoleAsSql', sql:'SELECT 2' }", () => {
    const received = loadBundle();
    editorEl().value = "SELECT 2";
    saveBtn().click();
    expect(received).toEqual([{ type: "saveConsoleAsSql", sql: "SELECT 2" }]);
  });

  it("#5 edge-empty: empty execution is ignored (no run message)", () => {
    const received = loadBundle();
    editorEl().value = "";
    runBtn().click();
    const runs = received.filter((m) => m.type === "runConsole");
    expect(runs).toHaveLength(0);
  });

  it("#6 edge-shortcut: Cmd/Ctrl+Enter executes with preventDefault; plain Enter does not", () => {
    const received = loadBundle();
    const editor = editorEl();
    editor.value = "SELECT 3";

    // Plain Enter — types a newline locally, no execution.
    const plain = keydownOn(editor, { key: "Enter" });
    expect(plain.prevented).toBe(false);
    expect(received.filter((m) => m.type === "runConsole")).toHaveLength(0);

    // Ctrl+Enter — executes and swallows the keystroke.
    const ctrl = keydownOn(editor, { key: "Enter", ctrlKey: true });
    expect(ctrl.prevented).toBe(true);
    expect(received).toEqual([{ type: "runConsole", sql: "SELECT 3" }]);

    // Cmd+Enter (macOS) — same contract.
    received.length = 0;
    const cmd = keydownOn(editor, { key: "Enter", metaKey: true });
    expect(cmd.prevented).toBe(true);
    expect(received).toEqual([{ type: "runConsole", sql: "SELECT 3" }]);
  });

  it("#7 edge-interaction: contextmenu prevented, exposes 'Save as SQL file', choosing it posts the save message", () => {
    const received = loadBundle();
    const editor = editorEl();
    editor.value = "SELECT 4";

    const menu = document.querySelector(
      ".vsdb-console-contextmenu",
    ) as HTMLElement | null;
    expect(menu).toBeTruthy();
    // Closed before the right-click (initial state).
    expect(menu!.hidden).toBe(true);

    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    const pd = vi.spyOn(ev, "preventDefault");
    editor.dispatchEvent(ev);
    expect(pd.mock.calls.length).toBeGreaterThan(0);
    // Opened after the right-click.
    expect(menu!.hidden).toBe(false);

    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".vsdb-console-context-item"),
    );
    const saveItem = items.find((b) =>
      (b.textContent ?? "").includes("Save as SQL file"),
    );
    expect(saveItem).toBeTruthy();

    saveItem!.click();
    expect(received).toEqual([{ type: "saveConsoleAsSql", sql: "SELECT 4" }]);
    // Choosing an item closes the menu (no stale overlay left behind).
    expect(menu!.hidden).toBe(true);
  });

  function openMenu(editor: HTMLTextAreaElement): HTMLElement {
    editor.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    return document.querySelector(
      ".vsdb-console-contextmenu",
    ) as HTMLElement;
  }

  it("#8 edge-dismissal: Escape closes the open context menu", () => {
    loadBundle();
    const editor = editorEl();
    const menu = openMenu(editor);
    expect(menu.hidden).toBe(false);

    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(menu.hidden).toBe(true);

    // Reopening after Escape still works (single node, not stacked).
    const reopened = openMenu(editor);
    expect(reopened.hidden).toBe(false);
    expect(document.querySelectorAll(".vsdb-console-contextmenu")).toHaveLength(
      1,
    );
  });

  it("#9 edge-dismissal: Cmd/Ctrl+Enter closes the menu at execution; click-away closes it; reopen never stacks duplicates", () => {
    const received = loadBundle();
    const editor = editorEl();
    editor.value = "SELECT 9";

    // Menu is open while the keyboard shortcut executes.
    const menu = openMenu(editor);
    expect(menu.hidden).toBe(false);
    keydownOn(editor, { key: "Enter", ctrlKey: true });
    expect(received).toEqual([{ type: "runConsole", sql: "SELECT 9" }]);
    expect(menu.hidden).toBe(true);

    // Running again with a second shortcut — still exactly one run message.
    keydownOn(editor, { key: "Enter", metaKey: true });
    expect(received).toEqual([
      { type: "runConsole", sql: "SELECT 9" },
      { type: "runConsole", sql: "SELECT 9" },
    ]);

    // Click-away closes an open menu without posting anything.
    const menu2 = openMenu(editor);
    expect(menu2.hidden).toBe(false);
    document.body.click();
    expect(menu2.hidden).toBe(true);
    expect(received).toHaveLength(2);

    // Right-click repeatedly: the menu node must never be duplicated.
    openMenu(editor);
    openMenu(editor);
    openMenu(editor);
    expect(document.querySelectorAll(".vsdb-console-contextmenu")).toHaveLength(
      1,
    );
  });
});

// ---- ARP-08 TASK-ARP08-003 — webview draft recovery -------------------------

function clearDraftsBtn(): HTMLButtonElement {
  return document.getElementById("consoleClearDraftsBtn") as HTMLButtonElement;
}
/** Pushes a host→webview `state` MessageEvent on window (the render path). */
function postWindowState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}
function inputOn(editor: HTMLTextAreaElement): void {
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}
function updateBuffersOf(
  received: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return received.filter((m) => m.type === "updateBuffer");
}

describe("webview/consolePanelMain.ts bundle — ARP-08 draft recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("#1 happy: editor input posts a debounced { updateBuffer, tabId, buffer } on the trailing edge", () => {
    const received = loadBundle();
    editorEl().value = "SELECT 1";
    inputOn(editorEl());
    // Trailing edge: nothing posted before the ~500ms window elapses.
    expect(updateBuffersOf(received)).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(updateBuffersOf(received)).toEqual([
      { type: "updateBuffer", tabId: "tab-1", buffer: "SELECT 1" },
    ]);
  });

  it("#2 happy: Clear drafts posts { clearDrafts }, empties the editor, and never calls confirm()", () => {
    const received = loadBundle();
    const confirmSpy = vi.spyOn(window, "confirm");
    expect(clearDraftsBtn()).toBeTruthy();
    // The explicit click IS the confirmation — no dialog allowed.
    clearDraftsBtn().click();
    expect(received).toContainEqual({ type: "clearDrafts" });
    expect(editorEl().value).toBe("");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("#3 edge restore-pre-input: a host state message with a non-empty buffer renders into the textarea", () => {
    loadBundle();
    postWindowState({
      type: "state",
      tabs: [
        { id: "tab-1", name: "Query 1", buffer: "SELECT * FROM t", active: true },
      ],
      activeTabId: "tab-1",
      history: [],
    });
    expect(editorEl().value).toBe("SELECT * FROM t");
  });

  it("#4 edge latest-wins: three rapid inputs under one window post exactly ONE updateBuffer carrying the final text", () => {
    const received = loadBundle();
    const editor = editorEl();
    editor.value = "A";
    inputOn(editor);
    editor.value = "B";
    inputOn(editor);
    editor.value = "C";
    inputOn(editor);
    vi.advanceTimersByTime(500);
    expect(updateBuffersOf(received)).toEqual([
      { type: "updateBuffer", tabId: "tab-1", buffer: "C" },
    ]);
  });

  it("#5 edge flush-on-unload: beforeunload flushes the pending buffer immediately, without waiting 500ms", () => {
    const received = loadBundle();
    editorEl().value = "SELECT unload";
    inputOn(editorEl());
    expect(updateBuffersOf(received)).toHaveLength(0);
    window.dispatchEvent(new Event("beforeunload"));
    expect(updateBuffersOf(received)).toEqual([
      { type: "updateBuffer", tabId: "tab-1", buffer: "SELECT unload" },
    ]);
    // The debounce stays cancelled after the flush — no double post.
    vi.advanceTimersByTime(500);
    expect(updateBuffersOf(received)).toHaveLength(1);
  });

  it("#6 edge flush-on-hidden: visibilitychange→hidden flushes the pending buffer immediately", () => {
    const received = loadBundle();
    // jsdom's visibilityState is a prototype getter — shadow it on the
    // instance, then drop the own property in `finally` to restore it.
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    try {
      editorEl().value = "SELECT hidden";
      inputOn(editorEl());
      expect(updateBuffersOf(received)).toHaveLength(0);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(updateBuffersOf(received)).toEqual([
        { type: "updateBuffer", tabId: "tab-1", buffer: "SELECT hidden" },
      ]);
    } finally {
      delete (document as unknown as { visibilityState?: string })
        .visibilityState;
    }
  });

  it("#7 regression divergence: updateBuffer(A) is posted BEFORE switchTab(B) when switching within the debounce window", () => {
    const received = loadBundle();
    postWindowState({
      type: "state",
      tabs: [
        { id: "tab-1", name: "Query 1", buffer: "", active: true },
        { id: "tab-2", name: "Query 2", buffer: "", active: false },
      ],
      activeTabId: "tab-1",
      history: [],
    });
    editorEl().value = "SELECT A";
    inputOn(editorEl());
    // Click tab B within the debounce window — the pending A buffer must
    // reach the host BEFORE the switch, or the host's next `state` push
    // clobbers A's edits (the latent divergence bug this task fixes).
    const tabButtons = document.querySelectorAll<HTMLButtonElement>(
      ".vsdb-console-tab",
    );
    tabButtons[1].click();
    const bufIdx = received.findIndex((m) => m.type === "updateBuffer");
    const switchIdx = received.findIndex((m) => m.type === "switchTab");
    expect(bufIdx).toBeGreaterThanOrEqual(0);
    expect(received[bufIdx]).toEqual({
      type: "updateBuffer",
      tabId: "tab-1",
      buffer: "SELECT A",
    });
    expect(received[switchIdx]).toEqual({ type: "switchTab", tabId: "tab-2" });
    expect(bufIdx).toBeLessThan(switchIdx);
  });

  it("#8 edge clear-cannot-resurrect: pending debounce is cancelled by Clear; the pre-clear text is never posted", () => {
    const received = loadBundle();
    editorEl().value = "SELECT 8";
    inputOn(editorEl());
    clearDraftsBtn().click();
    vi.advanceTimersByTime(500);
    expect(updateBuffersOf(received)).toHaveLength(0);
    expect(received).toContainEqual({ type: "clearDrafts" });
    expect(editorEl().value).toBe("");
  });

  it("#9 edge draftsCleared ack: resets to one fresh empty tab and renders pre-input state", () => {
    loadBundle();
    postWindowState({
      type: "state",
      tabs: [
        { id: "tab-1", name: "Query 1", buffer: "SELECT drafts", active: true },
        { id: "tab-2", name: "Query 2", buffer: "SELECT other", active: false },
      ],
      activeTabId: "tab-1",
      history: ["SELECT drafts"],
    });
    expect(editorEl().value).toBe("SELECT drafts");
    postWindowState({ type: "draftsCleared" });
    expect(editorEl().value).toBe("");
    const tabNodes = document.querySelectorAll<HTMLElement>(".vsdb-console-tab");
    expect(tabNodes).toHaveLength(1);
    // The label text node excludes the "×" close span appended after it.
    expect(tabNodes[0].firstChild?.textContent).toBe("Query 1");
  });
});
// End of bundle tests — AIC-004 ghost-text visual verification is done
// via a manual VS Code smoke test (see docs/AI_HANDOFF/tasks/TASK-AIC-004.md).
// The host seam (ConsolePanel.onAutocomplete) is covered by the unit test
// in src/ui/__tests__/consolePanel.test.ts; the wire shapes are covered
