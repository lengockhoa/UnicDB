// src/ui/__tests__/webviewKeybinding.test.ts
//
// TASK-503 Fix Round 1 — webview bundle tests for input-focus + banner.
//
// These tests load dist/webview.js into jsdom and exercise:
//   - K1: Cmd/Ctrl+Enter inside an HTMLInputElement does NOT trigger commit.
//   - K2: Cmd/Ctrl+Enter inside the searchInput does NOT trigger commit.
//   - K3: banner persists across re-render; refusal ack shows reason.
//   - K4: handleSaveResult with refused:true + reason → banner shows reason.
//
// Tests are RED until webview/main.ts wires `isFilterInput` into the
// Cmd+Enter capture-phase handler.

// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs for AG Grid browser APIs ---------------------------

interface ResizeObserverLike {
  observe(): void;
  unobserve(): void;
  disconnect(): void;
}

interface MediaQueryListLike {
  matches: boolean;
  media: string;
  addListener(): void;
  removeListener(): void;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
}

interface EditStateHandle {
  dirtyCount: number;
}

interface ClipboardDebug {
  simulatePaste?: (text: string) => void;
  getCellRange?: () => unknown;
}

interface UnicDBApiHandle {
  postMessage: (msg: unknown) => void;
  commit?: () => void;
  simulateCellEdit?: (
    rowId: number,
    colField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
  editState?: EditStateHandle;
}

interface UnicDBDebug {
  render?: () => void;
  postToHost?: (msg: unknown) => void;
  formatCell?: (v: unknown) => string;
  gridApi?: GridApi | null;
  editState?: EditStateHandle;
  commit?: () => void;
  simulateCellEdit?: UnicDBApiHandle["simulateCellEdit"];
  debugClipboard?: ClipboardDebug;
}

function UnicDBApi(): UnicDBDebug | null {
  return (window as unknown as { __UnicDB?: UnicDBDebug }).__UnicDB ?? null;
}

function getEditState(): EditStateHandle | null {
  return UnicDBApi()?.editState ?? null;
}

function dispatchPaste(target: EventTarget, text: string): void {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { getData: (_type: string) => text },
  });
  target.dispatchEvent(ev);
}

function dispatchClipboardShortcut(
  target: EventTarget,
  options: { ctrlKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}


beforeAll(() => {
  // jsdom doesn't ship these by default — AG Grid requires them.
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as ResizeObserverLike;
  }
  if (typeof window.matchMedia === "undefined") {
    window.matchMedia = (() => {
      const mql: MediaQueryListLike = {
        matches: false,
        media: "",
        addListener(): void {},
        removeListener(): void {},
        addEventListener(): void {},
        removeEventListener(): void {},
        dispatchEvent(): boolean {
          return true;
        },
      };
      return () => mql;
    }) as unknown as typeof window.matchMedia;
  }
});

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface LoadResult {
  received: Array<{ type?: string; [key: string]: unknown }>;
}

function loadBundle(): LoadResult {
  // Make vscode API a sink for this test.
  const received: Array<{ type?: string; [key: string]: unknown }> = [];
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => {
      if (msg && typeof msg === "object") {
        received.push(msg as { type?: string; [key: string]: unknown });
      }
    },
  });
  // Reset DOM so each test starts clean.
  document.body.innerHTML = '<div id="UnicDB-root"></div>';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(bundleSrc ?? "") as () => void;
  fn();
  return { received };
}

function dispatchHost(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function dispatchState(): void {
  // Minimal state so the bundle renders the grid wrap and registers the
  // capture-phase keydown listeners on it.
  dispatchHost({
    type: "state",
    header: "h",
    busy: false,
    results: [
      {
        index: 0,
        sql: "SELECT id, name FROM t",
        status: "done",
        result: {
          columns: ["id", "name"],
          rows: [[1, "a"], [2, "b"]],
          rowCount: 2,
          durationMs: 0,
        },
        durationMs: 0,
      },
    ],
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts — keybinding filter (Fix R1)", () => {
  itIfBundle("K1. Cmd+Enter while focus is in <input> does NOT post saveEdits", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();

    const editState = getEditState();
    expect(editState).toBeTruthy();
    const sim = UnicDBApi()?.simulateCellEdit;
    expect(sim).toBeTruthy();
    sim!(0, "name", "x", "a");
    await flush();

    // Build a stand-alone <input> appended INSIDE the grid wrap (so the
    // capture-phase listener on the wrap actually sees the event).
    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement | null;
    expect(wrap).toBeTruthy();
    const input = document.createElement("input");
    wrap!.appendChild(input);
    input.focus();

    received.length = 0;
    // Simulate Cmd+Enter (Meta+Enter). The capture-phase handler on gridWrap
    // listens to ALL keydown events; the gate must skip when target is an input.
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: false,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    // Dispatch on the input — bubbles to gridWrap capture listener.
    input.dispatchEvent(ev);
    await flush();

    const saveMsgs = received.filter((m) => m.type === "saveEdits");
    expect(saveMsgs).toHaveLength(0);
  });

  itIfBundle("K2. Ctrl+Enter inside search input does NOT post saveEdits", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();

    const editState = getEditState();
    const sim = UnicDBApi()?.simulateCellEdit;
    sim!(0, "name", "x", "a");
    await flush();
    expect(editState!.dirtyCount).toBe(1);

    // The persistent searchInput lives inside the grid wrap toolbar.
    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement | null;
    expect(wrap).toBeTruthy();
    const input = document.createElement("input");
    input.type = "search";
    wrap!.appendChild(input);
    input.focus();

    received.length = 0;
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      metaKey: false,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(ev);
    await flush();

    const saveMsgs = received.filter((m) => m.type === "saveEdits");
    expect(saveMsgs).toHaveLength(0);
  });

  itIfBundle("K3. Cmd+Enter on the grid wrap (no input focus) STILL posts saveEdits", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();

    const editState = getEditState();
    const sim = UnicDBApi()?.simulateCellEdit;
    sim!(0, "name", "x", "a");
    await flush();
    expect(editState!.dirtyCount).toBe(1);

    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement | null;
    expect(wrap).toBeTruthy();

    received.length = 0;
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: false,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    // Dispatch ON the wrap (target is the wrap itself, not an input).
    wrap!.dispatchEvent(ev);
    await flush();

    const saveMsgs = received.filter((m) => m.type === "saveEdits");
    expect(saveMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

describeIfBundle("webview/main.ts — Cmd/Ctrl+V clipboard round-trip", () => {
  itIfBundle("Cmd+V pastes host clipboard text through the round-trip exactly once", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    const api = UnicDBApi()!;
    api.gridApi!.setFocusedCell(0, "id");
    received.length = 0;

    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    const ev = dispatchClipboardShortcut(wrap, { metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(received.filter((m) => m.type === "readClipboard")).toHaveLength(1);

    dispatchHost({ type: "clipboardText", text: "7\tseven" });
    await flush();
    expect(api.editState!.dirtyCount).toBe(2);
    expect(api.gridApi!.getRowNode("0")!.data.id).toBe("7");
    expect(api.gridApi!.getRowNode("0")!.data.name).toBe("seven");
  });

  itIfBundle("Ctrl+V behaves identically to Cmd+V", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    const api = UnicDBApi()!;
    api.gridApi!.setFocusedCell(0, "id");
    received.length = 0;

    dispatchClipboardShortcut(document.querySelector(".UnicDB-grid-host")!, { ctrlKey: true });
    expect(received.filter((m) => m.type === "readClipboard")).toHaveLength(1);
    dispatchHost({ type: "clipboardText", text: "8\teight" });
    await flush();
    expect(api.editState!.dirtyCount).toBe(2);
    expect(api.gridApi!.getRowNode("0")!.data.id).toBe("8");
  });

  itIfBundle("clicking a non-cell clears stale range before paste", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    const api = UnicDBApi()!;
    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    const first =
      (wrap.querySelector('.ag-cell[row-index="0"][col-id="id"]') as HTMLElement | null) ??
      (wrap.querySelector('.ag-row[row-index="0"] .ag-cell[col-id="id"]') as HTMLElement | null);
    const last =
      (wrap.querySelector('.ag-cell[row-index="1"][col-id="name"]') as HTMLElement | null) ??
      (wrap.querySelector('.ag-row[row-index="1"] .ag-cell[col-id="name"]') as HTMLElement | null);
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    last.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(api.debugClipboard?.getCellRange?.()).not.toBeNull();

    const toolbar = document.querySelector(".UnicDB-toolbar") as HTMLElement;
    toolbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(api.debugClipboard?.getCellRange?.()).toBeNull();
    api.gridApi!.setFocusedCell(0, "id");
    received.length = 0;
    dispatchPaste(wrap, "focused");
    await flush();
    expect(api.editState!.dirtyCount).toBe(1);
    expect(api.gridApi!.getRowNode("0")!.data.id).toBe("focused");
    expect(api.gridApi!.getRowNode("1")!.data.name).toBe("b");
  });

  itIfBundle("Cmd+V in a filter input is not intercepted", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    const input = document.createElement("input");
    wrap.appendChild(input);
    input.focus();
    received.length = 0;
    dispatchClipboardShortcut(input, { metaKey: true });
    await flush();
    expect(received.filter((m) => m.type === "readClipboard")).toHaveLength(0);
    expect(getEditState()!.dirtyCount).toBe(0);
  });

  itIfBundle("clipboardText with empty text is a silent no-op", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    received.length = 0;
    const wrap = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    dispatchClipboardShortcut(wrap, { metaKey: true });
    dispatchHost({ type: "clipboardText", text: "" });
    await flush();
    expect(getEditState()!.dirtyCount).toBe(0);
  });

  itIfBundle("clipboard round-trip without state is a safe no-op", async () => {
    const { received } = loadBundle();
    received.length = 0;
    const root = document.getElementById("UnicDB-root")!;
    dispatchClipboardShortcut(root, { ctrlKey: true });
    expect(received.filter((m) => m.type === "readClipboard")).toHaveLength(1);
    dispatchHost({ type: "clipboardText", text: "orphan" });
    await flush();
    expect(getEditState()!.dirtyCount).toBe(0);
  });
});

describeIfBundle("webview/main.ts — banner refusal persistence (Fix R1)", () => {
  itIfBundle("B1. refused ack (ok:true, refused:true, reason) shows banner with reason", async () => {
    loadBundle();
    dispatchState();
    await flush();

    dispatchHost({
      type: "saveResult",
      index: 0,
      ok: true,
      refused: true,
      reason: "mysql has no PRIMARY KEY for users; cannot save.",
    });
    await flush();

    const banner = document.querySelector(".UnicDB-save-banner");
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("PRIMARY KEY");
    // Banner is visible (no hidden attribute).
    const hidden =
      banner!.classList.contains("UnicDB-hidden") ||
      banner!.classList.contains("UnicDB-save-banner-hidden") ||
      banner!.getAttribute("hidden") !== null;
    expect(hidden).toBe(false);
  });

  itIfBundle("B2. banner PERSISTS across re-render (no_clear on renderGrid)", async () => {
    loadBundle();
    dispatchState();
    await flush();

    dispatchHost({
      type: "saveResult",
      index: 0,
      ok: false,
      errors: ["ERROR: column foo does not exist"],
    });
    await flush();

    const before = document.querySelector(".UnicDB-save-banner");
    expect(before).toBeTruthy();
    const beforeText = before!.textContent;

    // Re-render with new state — banner MUST still be in the DOM with same text.
    dispatchHost({
      type: "state",
      header: "h2",
      busy: false,
      results: [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: {
            columns: ["id"],
            rows: [[1]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
    });
    await flush();

    const after = document.querySelector(".UnicDB-save-banner");
    expect(after).toBeTruthy();
    expect(after!.textContent).toBe(beforeText);
  });
});
