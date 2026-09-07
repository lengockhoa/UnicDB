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
interface UnicDBApi { postMessage: (msg: unknown) => void; }
interface UnicDBDebug { getActiveTab: () => number; gridApi?: unknown; }

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
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const root = document.getElementById("UnicDB-root") as HTMLDivElement;
  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = { postMessage: (msg) => received.push(msg as Record<string, unknown>) };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi = () => api;
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
function debug(): UnicDBDebug {
  return (window as unknown as { __UnicDB: UnicDBDebug }).__UnicDB;
}
function tabs(root: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".UnicDB-tab"));
}

describeIfBundle("TASK-AH-003 append-only result tabs", () => {
  itIfBundle("growth state post grows the tab strip and activates the first newly-appended tab (Messages first, reverse-chrono)", async () => {
    const { root } = loadBundle();
    const firstRun = [result(0, { runNo: 1, runStmtNo: 1 }), result(1, { runNo: 1, runStmtNo: 2 })];
    dispatch(state(firstRun));
    await flush();
    const oldTabs = tabs(root);
    // Messages tab first, then 2 result tabs in REVERSE chronological order
    // (newest = result[1] sits at visual position 1, result[0] at position 2).
    expect(oldTabs).toHaveLength(3);
    expect(oldTabs[0]?.textContent ?? "").toMatch(/^Messages/);
    expect(oldTabs[1]?.textContent ?? "").toMatch(/^Run 1 · SELECT 1/);
    expect(oldTabs[2]?.textContent ?? "").toMatch(/^Run 1 · SELECT 0/);
    // After the first dispatch, active = first appended = canonical 0 →
    // visual tabs[2] (result[0] is the first item of the run that was active
    // when activeTab was last set; appendBase logic picks the first new tab).
    expect(oldTabs[oldTabs.length - 1]?.classList.contains("UnicDB-tab-active")).toBe(true);
    dispatch(state([
      ...firstRun,
      result(2, { runNo: 2, runStmtNo: 1 }),
      result(3, { runNo: 2, runStmtNo: 2 }),
      result(4, { runNo: 2, runStmtNo: 3 }),
    ]));
    await flush();
    const nextTabs = tabs(root);
    // Messages + 5 results = 6 tabs (still under the 10-tab cap).
    expect(nextTabs).toHaveLength(6);
    // Visual order: Messages, result[4] (newest), result[3], result[2] (ACTIVE),
    // result[1], result[0]. The active tab is the FIRST newly-appended
    // (canonical 2 → visual tabs[3]).
    expect(nextTabs[0]?.textContent ?? "").toMatch(/^Messages/);
    expect(nextTabs[3]?.textContent ?? "").toMatch(/^Run 2 · SELECT 2/);
    expect(nextTabs[3]?.classList.contains("UnicDB-tab-active")).toBe(true);
    expect(debug().getActiveTab()).toBe(2);
  });

  itIfBundle("stamped entries show Run N · <hint> (SQL/label/Stmt M) — Messages-first + reverse-chrono", async () => {
    const { root } = loadBundle();
    dispatch(state([
      result(0, { runNo: 2, runStmtNo: 1 }),
      { ...result(1), label: "public.users" },
      result(2),
    ]));
    await flush();
    // Visual order: Messages, then result tabs in REVERSE chronological.
    //   tabs[0] = Messages
    //   tabs[1] = result[2] (newest = sql "SELECT 2")
    //   tabs[2] = result[1] (label "public.users")
    //   tabs[3] = result[0] (oldest = sql "SELECT 0")
    const rendered = tabs(root).slice(0, 4).map((tab) => tab.textContent ?? "");
    // TASK-UX2-002 — tab title is "Run N · <hint>". Hint preference:
    //   error → label || first 30 chars of sql || "failed"
    //   label → r.label (this is `public.users`)
    //   sql   → first 30 chars of r.sql
    //   else  → "Stmt M"  (only when sql is empty AND no label)
    expect(rendered[0]).toMatch(/^Messages/); // Messages always first
    expect(rendered[1]).toMatch(/^Run 3 · SELECT 2/); // newest — sql path
    expect(rendered[2]).toMatch(/^Run 2 · public\.users/); // label path (runNo defaults to i+1=2)
    expect(rendered[3]).toMatch(/^Run 2 · SELECT 0/); // oldest
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
    // After append: active = first newly appended = canonical 2.
    expect(debug().getActiveTab()).toBe(2);
    // Visual order after append (6 tabs): Messages, r4, r3, r2 (active), r1, r0.
    // Click visual tabs[5] = result[0] (canonical 0) → verify DISTINCT cache
    // survives the append for that tab.
    tabs(root)[5]?.click();
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
    // Messages tab + 1 surviving result = 2 tabs.
    expect(tabs(root)).toHaveLength(2);
  });

  itIfBundle("replace-mode equal-length post keeps the user-clicked tab active (clamp to surviving)", async () => {
    const { root } = loadBundle();
    dispatch(state([result(0), result(1), result(2)]));
    await flush();
    // Visual order: Messages, result[2], result[1], result[0].
    // Click visual tabs[3] = result[0] (canonical 0).
    tabs(root)[3]?.click();
    await flush();
    expect(debug().getActiveTab()).toBe(0);
    dispatch(state([result(10), result(11), result(12)]));
    await flush();
    // New state has 3 results at canonical 0..2. The previously-clicked
    // canonical index 0 still survives → active stays at 0.
    expect(debug().getActiveTab()).toBe(0);
    // Visual tabs[3] in NEW order = result[10] (canonical 0) → still active.
    expect(tabs(root)[3]?.classList.contains("UnicDB-tab-active")).toBe(true);
  });

  itIfBundle("switching between accumulated tabs keeps each tab's rows readable", async () => {
    const { root } = loadBundle();
    const firstRun = [result(0, { runNo: 1, runStmtNo: 1 }), result(1, { runNo: 1, runStmtNo: 2 })];
    dispatch(state(firstRun));
    await flush();
    dispatch(state([...firstRun, result(2, { runNo: 2, runStmtNo: 1 }), result(3, { runNo: 2, runStmtNo: 2 }), result(4, { runNo: 2, runStmtNo: 3 })]));
    await flush();
    // Visual order (6 tabs): Messages, r4, r3, r2, r1, r0.
    // Click Messages → active = results.length sentinel = 5.
    tabs(root)[0]?.click();
    await flush();
    expect(debug().getActiveTab()).toBe(5);
    // Visual tabs[5] = result[0] (canonical 0).
    tabs(root)[5]?.click();
    await flush();
    expect(debug().getActiveTab()).toBe(0);
    expect(root.querySelector(".ag-root-wrapper")).toBeTruthy();
  });
});
