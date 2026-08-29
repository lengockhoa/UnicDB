// tests/webviewMultiRunTabs.test.ts
// TASK-AH-003 — append-only result tabs and per-tab DISTINCT cache safety.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface ResizeObserverLike { observe(): void; unobserve(): void; disconnect(): void; }
interface MediaQueryListLike {
  matches: boolean; media: string; onchange: null;
  addListener(): void; removeListener(): void; addEventListener(): void;
  removeEventListener(): void; dispatchEvent(): boolean;
}
interface VsdbApi { postMessage: (msg: unknown) => void; }
interface VsdbDebug { getActiveTab: () => number; gridApi?: unknown; }

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: typeof ResizeObserver;
    matchMedia?: (q: string) => MediaQueryListLike;
  };
  if (typeof g.ResizeObserver === "undefined") {
    class StubResizeObserver implements ResizeObserverLike {
      observe(): void {} unobserve(): void {} disconnect(): void {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  }
  if (typeof g.matchMedia === "undefined") {
    g.matchMedia = (_query: string): MediaQueryListLike => ({
      matches: false, media: _query, onchange: null,
      addListener(): void {}, removeListener(): void {},
      addEventListener(): void {}, removeEventListener(): void {},
      dispatchEvent(): boolean { return false; },
    });
  }
});

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;
const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function loadBundle(): { received: Array<Record<string, unknown>>; root: HTMLDivElement } {
  if (!bundleSrc) throw new Error("dist/webview.js missing — run `npm run compile` first");
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-webview"></div>';
  const root = document.getElementById("vsdb-root") as HTMLDivElement;
  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = { postMessage: (msg) => received.push(msg as Record<string, unknown>) };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi = () => api;
  (0, eval)(bundleSrc);
  return { received, root };
}

function flush(): Promise<void> {
  return new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}
function result(index: number, opts: { runNo?: number; runStmtNo?: number; cursorClosed?: boolean } = {}): Record<string, unknown> {
  return {
    index, sql: `SELECT ${index}`, status: "done",
    result: { columns: ["value"], rows: [[index]], rowCount: 1, durationMs: 1 },
    durationMs: 1, ...opts,
  };
}
function state(results: Record<string, unknown>[]): Record<string, unknown> {
  return { type: "state", header: "test.sql", busy: false, results };
}
function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}
function debug(): VsdbDebug {
  return (window as unknown as { __vsdb: VsdbDebug }).__vsdb;
}
function tabs(root: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".vsdb-tab"));
}

describeIfBundle("TASK-AH-003 append-only result tabs", () => {
  itIfBundle("growth state post grows the tab strip and activates the first new tab", async () => {
    const { root } = loadBundle();
    const firstRun = [result(0, { runNo: 1, runStmtNo: 1 }), result(1, { runNo: 1, runStmtNo: 2 })];
    dispatch(state(firstRun));
    await flush();
    const oldTabs = tabs(root);
    expect(oldTabs).toHaveLength(3);
    const oldLabels = oldTabs.slice(0, 2).map((tab) => tab.textContent);
    dispatch(state([
      ...firstRun,
      result(2, { runNo: 2, runStmtNo: 1 }),
      result(3, { runNo: 2, runStmtNo: 2 }),
      result(4, { runNo: 2, runStmtNo: 3 }),
    ]));
    await flush();
    const nextTabs = tabs(root);
    expect(nextTabs).toHaveLength(6);
    expect(nextTabs.slice(0, 2).map((tab) => tab.textContent)).toEqual(oldLabels);
    expect(nextTabs[2]?.classList.contains("vsdb-tab-active")).toBe(true);
    expect(debug().getActiveTab()).toBe(2);
  });

  itIfBundle("stamped entries show Run N · Stmt M and unstamped entries keep fallback labels", async () => {
    const { root } = loadBundle();
    dispatch(state([
      result(0, { runNo: 2, runStmtNo: 1 }),
      { ...result(1), label: "public.users" },
      result(2),
    ]));
    await flush();
    const rendered = tabs(root).slice(0, 3).map((tab) => tab.textContent ?? "");
    expect(rendered[0]).toMatch(/^Run 2 · Stmt 1/);
    expect(rendered[1]).toMatch(/^public\.users/);
    expect(rendered[2]).toMatch(/^Statement 3/);
  });

  itIfBundle("append post preserves old DISTINCT cache while activating a new tab", async () => {
    const { root, received } = loadBundle();
    const firstRun = [result(0, { runNo: 1, runStmtNo: 1 }), result(1, { runNo: 1, runStmtNo: 2 })];
    dispatch(state(firstRun));
    await flush();
    const getFilter = (): Promise<unknown> => {
      const api = debug().gridApi as { getColumnFilterInstance?: (column: string) => Promise<unknown> };
      return api.getColumnFilterInstance?.("value") ?? Promise.resolve(null);
    };
    expect(await getFilter()).toBeTruthy();
    dispatch({ type: "distinctValues", index: 0, column: "value", values: [0, 99], truncated: false });
    await flush();
    const requestsBeforeAppend = received.filter((msg) => msg.type === "requestDistinctValues" && msg.index === 0).length;
    dispatch(state([
      ...firstRun,
      result(2, { runNo: 2, runStmtNo: 1 }),
      result(3, { runNo: 2, runStmtNo: 2 }),
      result(4, { runNo: 2, runStmtNo: 3 }),
    ]));
    await flush();
    expect(debug().getActiveTab()).toBe(2);
    tabs(root)[0]?.click();
    await flush();
    const restored = await getFilter() as { getGui?: () => HTMLElement };
    await flush();
    expect(restored.getGui?.().textContent).toContain("99");
    const requestsAfterRestore = received.filter((msg) => msg.type === "requestDistinctValues" && msg.index === 0).length;
    expect(requestsAfterRestore).toBe(requestsBeforeAppend);
  });

  itIfBundle("replace-run shrink still clamps activeTab to the surviving result", async () => {
    const { root } = loadBundle();
    dispatch(state([result(0), result(1), result(2), result(3), result(4)]));
    await flush();
    dispatch(state([result(0)]));
    await flush();
    expect(debug().getActiveTab()).toBe(0);
    expect(tabs(root)).toHaveLength(2);
  });

  itIfBundle("replace-mode equal-length post does not pin the first new tab", async () => {
    const { root } = loadBundle();
    dispatch(state([result(0), result(1), result(2)]));
    await flush();
    tabs(root)[2]?.click();
    await flush();
    dispatch(state([result(10), result(11), result(12)]));
    await flush();
    expect(debug().getActiveTab()).toBe(2);
    expect(tabs(root)[2]?.classList.contains("vsdb-tab-active")).toBe(true);
  });

  itIfBundle("switching between accumulated tabs keeps each tab's rows readable", async () => {
    const { root } = loadBundle();
    const firstRun = [result(0, { runNo: 1, runStmtNo: 1 }), result(1, { runNo: 1, runStmtNo: 2 })];
    dispatch(state(firstRun));
    await flush();
    dispatch(state([...firstRun, result(2, { runNo: 2, runStmtNo: 1 }), result(3, { runNo: 2, runStmtNo: 2 }), result(4, { runNo: 2, runStmtNo: 3 })]));
    await flush();
    tabs(root)[0]?.click();
    await flush();
    expect(debug().getActiveTab()).toBe(0);
    tabs(root)[4]?.click();
    await flush();
    expect(debug().getActiveTab()).toBe(4);
    expect(root.querySelector(".ag-root-wrapper")).toBeTruthy();
  });
});
