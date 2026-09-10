// src/ui/__tests__/webviewClipboardCopy.test.ts
// TASK-CLIP-001 — jsdom bundle tests for spreadsheet-style clipboard copy.
//
// These tests load dist/webview.js after `npm run compile` and exercise the
// actual grid DOM/event path used by Cmd/Ctrl+C.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type ResizeObserverLike = {
  observe(): void;
  unobserve(): void;
  disconnect(): void;
};

type MediaQueryListLike = {
  matches: boolean;
  media: string;
  onchange: null;
  addListener(): void;
  removeListener(): void;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
};

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: new () => ResizeObserverLike;
    matchMedia?: (query: string) => MediaQueryListLike;
  };
  if (typeof g.ResizeObserver === "undefined") {
    class StubResizeObserver implements ResizeObserverLike {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as new () => ResizeObserverLike;
  }
  if (typeof g.matchMedia === "undefined") {
    g.matchMedia = (query: string): MediaQueryListLike => ({
      matches: false,
      media: query,
      onchange: null,
      addListener(): void {},
      removeListener(): void {},
      addEventListener(): void {},
      removeEventListener(): void {},
      dispatchEvent(): boolean {
        return false;
      },
    });
  }
});

// AG Grid queues state/render work on timers. Drain it before jsdom teardown
// so stale listeners from the bundle do not report late window errors.
afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
});

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface UnicDBDebug {
  gridApi?: GridApi;
  debugSetSpecs?: (specs: ReadonlyArray<Record<string, unknown>>) => void;
}

function loadBundle(): {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
} {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const root = document.getElementById("UnicDB-root") as HTMLDivElement;
  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => received.push(msg as Record<string, unknown>),
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;
  (0, eval)(bundleSrc);
  return { received, root };
}

function dispatchState(rows: unknown[][], columns = ["id", "name"]): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "state",
        header: "test.sql",
        busy: false,
        results: [
          {
            index: 0,
            sql: "SELECT * FROM t",
            status: "done",
            result: {
              columns,
              rows,
              rowCount: rows.length,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      },
    }),
  );
}

async function flushGrid(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function getDebug(): UnicDBDebug {
  return (window as unknown as { __UnicDB: UnicDBDebug }).__UnicDB;
}

function getCell(root: HTMLElement, row: number, field: string): HTMLElement {
  const cell = root.querySelector(
    `.ag-row[row-index="${row}"] [col-id="${field}"]`,
  );
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`missing cell row=${row} field=${field}`);
  }
  return cell;
}

function drag(start: HTMLElement, end: HTMLElement): void {
  start.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  end.dispatchEvent(
    new MouseEvent("mousemove", { bubbles: true, cancelable: true }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function ctrlC(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function copyMessages(received: Array<Record<string, unknown>>): Array<{ text: string }> {
  return received.filter((message) => message.type === "copy") as Array<{ text: string }>;
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts clipboard copy shapes (TASK-CLIP-001)", () => {
  itIfBundle("1x1 range Cmd+C copies the single cell", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"], [3, "gamma"]]);
    await flushGrid();
    const cell = getCell(root, 0, "name");
    drag(cell, cell);
    ctrlC(root.querySelector(".UnicDB-grid-host")!);
    const copies = copyMessages(received);
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toBe("alpha");
    expect(copies[0].text).not.toMatch(/[\t\n]/);
  });

  itIfBundle("2x2 rectangle copies rows tab-joined, lines newline-joined", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"], [3, "gamma"]]);
    await flushGrid();
    drag(getCell(root, 0, "id"), getCell(root, 1, "name"));
    ctrlC(root.querySelector(".UnicDB-grid-host")!);
    const copies = copyMessages(received);
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toBe("1\talpha\n2\tbeta");
  });

  itIfBundle("checkbox row selection copies 2 rows", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"], [3, "gamma"]]);
    await flushGrid();
    const grid = getDebug().gridApi!;
    let index = 0;
    grid.forEachNode((node) => {
      if (index < 2 && node.data) node.setSelected(true, false, "api");
      index++;
    });
    ctrlC(root.querySelector(".UnicDB-grid-host")!);
    const copies = copyMessages(received);
    expect(copies).toHaveLength(1);
    expect(copies[0].text.split("\n")).toHaveLength(2);
    expect(copies[0].text.split("\n").every((line) => line.includes("\t"))).toBe(true);
  });

  itIfBundle("single-column strip drag copies one column", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"], [3, "gamma"]]);
    await flushGrid();
    drag(getCell(root, 0, "name"), getCell(root, 2, "name"));
    ctrlC(root.querySelector(".UnicDB-grid-host")!);
    const copies = copyMessages(received);
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toBe("alpha\nbeta\ngamma");
    expect(copies[0].text).not.toContain("\t");
  });

  itIfBundle("hidden column excluded from range copy", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"]]);
    await flushGrid();
    drag(getCell(root, 0, "id"), getCell(root, 1, "name"));
    getDebug().debugSetSpecs!([
      { field: "id", headerName: "id", kind: "number", hidden: true },
      { field: "name", headerName: "name", kind: "string", hidden: false },
    ]);
    await flushGrid();
    ctrlC(root.querySelector(".UnicDB-grid-host")!);
    const copies = copyMessages(received);
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toBe("alpha\nbeta");
    expect(copies[0].text).not.toContain("1");
    expect(copies[0].text).not.toContain("2");
  });

  itIfBundle("Cmd+C with no selection and no focused cell posts nothing", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"], [3, "gamma"]]);
    await flushGrid();
    ctrlC(root.querySelector(".UnicDB-grid-host")!);
    expect(copyMessages(received)).toHaveLength(0);
  });

  itIfBundle("range clipped to displayed rows", async () => {
    const { received, root } = loadBundle();
    dispatchState([[1, "alpha"], [2, "beta"], [3, "gamma"]]);
    await flushGrid();
    const gridHost = root.querySelector(".UnicDB-grid-host")!;
    const grid = getDebug().gridApi!;
    grid.setFocusedCell(0, "name");
    const first = getCell(root, 0, "name");
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 9; i++) {
      gridHost.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    ctrlC(gridHost);
    const copies = copyMessages(received);
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toBe("alpha\nbeta\ngamma");
  });
});
