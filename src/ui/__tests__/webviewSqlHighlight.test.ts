// src/ui/__tests__/webviewSqlHighlight.test.ts — TASK-003 case 8.
//
// Bundle integration: loads dist/webview.js (built via `npm run compile`)
// into jsdom, stubs acquireVsCodeApi + ResizeObserver + matchMedia, then
// dispatches a `state` message with status:"error" and drives the Messages
// tab to assert the colorized SQL render:
//   - `pre.UnicDB-msg-sql` contains >= 1 `span.UnicDB-sql-tok-keyword`
//   - its textContent equals the original SQL (no chars dropped/duplicated)
//
// If dist/webview.js is missing the tests are skipped with an explanatory
// message — `npm run compile` must run first (mirrors the skip-if-missing
// guard in src/ui/__tests__/webviewSetFilter.test.ts:15-16).
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs for AG Grid browser APIs ---------------------------
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
    matchMedia?: (q: string) => MediaQueryListLike;
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
    const factory = (query: string): MediaQueryListLike => ({
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
    g.matchMedia = factory;
  }
});

// ---- bundle loading --------------------------------------------------------
const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
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
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrc);

  return { received, root };
}

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

// ---- tests ----------------------------------------------------------------
const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle — TASK-003 SQL coloring (case 8)", () => {
  itIfBundle("Messages tab renders colorized SQL for an error result", () => {
    const { root } = loadBundle();
    const sql = "SELECT * FROM t WHERE status = 'bad' -- hostile";
    dispatchState({
      type: "state",
      header: "err.sql",
      busy: false,
      results: [
        {
          index: 0,
          sql,
          status: "error",
          error: "relation t does not exist",
          durationMs: 1,
        },
      ],
    });

    // Click the Messages tab to render the messages panel.
    const tabs = Array.from(root.querySelectorAll(".UnicDB-tab"));
    const msgTab = tabs.find((t) => (t.textContent ?? "").startsWith("Messages"));
    expect(msgTab).toBeTruthy();
    (msgTab as HTMLButtonElement).click();

    const pre = root.querySelector("pre.UnicDB-msg-sql");
    expect(pre).toBeTruthy();
    const keywords = pre!.querySelectorAll("span.UnicDB-sql-tok-keyword");
    expect(keywords.length).toBeGreaterThanOrEqual(1);
    expect(pre!.textContent).toBe(sql);
  });
});
