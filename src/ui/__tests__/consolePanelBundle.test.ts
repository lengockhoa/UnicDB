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
import { describe, expect, it, vi } from "vitest";

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
// End of bundle tests — AIC-004 ghost-text visual verification is done
// via a manual VS Code smoke test (see docs/AI_HANDOFF/tasks/TASK-AIC-004.md).
// The host seam (ConsolePanel.onAutocomplete) is covered by the unit test
// in src/ui/__tests__/consolePanel.test.ts; the wire shapes are covered
