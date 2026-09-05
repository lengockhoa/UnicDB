// tests/webviewRequeryAlignment.test.ts
//
// TASK-009 — Requery bar alignment + set-filter popup alignment (grid D+E).
//
// Verifies the two visual fixes the user asked for:
//   (D) WHERE/ORDER BY bar — label + input + run/clear buttons on one
//       baseline, equal gap, equal height (26px).
//   (E) set-filter popup — Select All + items share the same left indent.
//
// Strategy: parses webview/styles.css + webview/main.ts as plain text and
// asserts structural intent. Also loads dist/webview.js into jsdom,
// dispatches a single state message, and asserts the requery bar element
// is mounted into the persistent DOM.
//
// Skipped if dist/webview.js is missing (`npm run compile` must run).
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs for AG Grid browser APIs ---------------------------

interface ResizeObserverLike {
  observe: () => void;
  unobserve: () => void;
  disconnect: () => void;
}

interface MediaQueryListLike {
  matches: boolean;
  media: string;
  addListener: (cb: () => void) => void;
  removeListener: (cb: () => void) => void;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  dispatchEvent: () => boolean;
}

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface UnicDBGlobal {
  acquireVsCodeApi?: () => UnicDBApi;
}

// Local alias for the global object so we can assign and read typed members
// without inline-cast member access on `globalThis`.
const g: { ResizeObserver?: unknown; matchMedia?: unknown } = globalThis;

beforeAll(() => {
  if (typeof g.ResizeObserver === "undefined") {
    const Stub: { new (): ResizeObserverLike } = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    g.ResizeObserver = Stub;
  }
  if (typeof g.matchMedia === "undefined") {
    const Stub = (query: string): MediaQueryListLike => ({
      matches: false,
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    g.matchMedia = Stub;
  }
});

// ---- bundle loading --------------------------------------------------------

const stylesPath = resolve(process.cwd(), "webview", "styles.css");
const mainPath = resolve(process.cwd(), "webview", "main.ts");
const distPath = resolve(process.cwd(), "dist", "webview.js");

const stylesSrc = existsSync(stylesPath) ? readFileSync(stylesPath, "utf8") : "";
const mainSrc = existsSync(mainPath) ? readFileSync(mainPath, "utf8") : "";
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface BundleHandle {
  root: HTMLDivElement;
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const root = document.getElementById("UnicDB-root");
  if (!root) {
    throw new Error("UnicDB-root missing after body.innerHTML");
  }
  const api: UnicDBApi = { postMessage: () => {} };
  const UnicDBGlobal: UnicDBGlobal = globalThis;
  UnicDBGlobal.acquireVsCodeApi = () => api;
  // eslint-disable-next-line no-eval
  (0, eval)(bundleSrc);
  return { root };
}

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

// Flush microtasks so the bundle's message handler can complete its async
// render. Pattern matches the existing webviewEditHighlight.test.ts. The
// `setTimeout(0)` here is a deterministic task-yield (no guessed duration
// — the awaited condition is the next-tick promise resolution).
function flushGridEvents(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function oneStatementState(): Record<string, unknown> {
  return {
    type: "state",
    header: "test.sql",
    busy: false,
    results: [
      {
        index: 0,
        sql: "SELECT * FROM t",
        status: "done",
        result: {
          columns: ["id", "name"],
          rows: [
            [1, "alpha"],
            [2, "beta"],
          ],
          rowCount: 2,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

// -----------------------------------------------------------------------
// Helpers — pure functions over `stylesSrc` to avoid inline casts.
// -----------------------------------------------------------------------

function readRuleBody(src: string, selector: string): string {
  const idx = src.indexOf(selector);
  if (idx < 0) return "";
  const openBrace = src.indexOf("{", idx);
  if (openBrace < 0) return "";
  const closeBrace = src.indexOf("}", openBrace);
  if (closeBrace < 0) return "";
  return src.slice(openBrace + 1, closeBrace);
}

// -----------------------------------------------------------------------
// Test #1 — happy: requery bar CSS rules for one-baseline alignment
// -----------------------------------------------------------------------

describe("TASK-009 D — requery bar CSS alignment", () => {
  it("declares .UnicDB-requery-bar with display:flex + align-items:center", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-requery-bar");
    expect(body, "rule body for .UnicDB-requery-bar").not.toBe("");
    expect(body).toMatch(/display\s*:\s*flex/);
    expect(body).toMatch(/align-items\s*:\s*center/);
  });

  it(".UnicDB-requery-label sets line-height to 26px (shared baseline)", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-requery-label");
    expect(body, "rule body for .UnicDB-requery-label").not.toBe("");
    expect(body).toMatch(/line-height\s*:\s*26px/);
  });

  it(".UnicDB-requery-input sets height:26px + box-sizing:border-box", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-requery-input");
    expect(body, "rule body for .UnicDB-requery-input").not.toBe("");
    expect(body).toMatch(/height\s*:\s*26px/);
    expect(body).toMatch(/box-sizing\s*:\s*border-box/);
  });

  it("button.UnicDB-requery-run sets height:26px", () => {
    const body = readRuleBody(stylesSrc, "button.UnicDB-requery-run");
    expect(body, "rule body for button.UnicDB-requery-run").not.toBe("");
    expect(body).toMatch(/height\s*:\s*26px/);
  });

  it("button.UnicDB-requery-clear sets height:26px", () => {
    const body = readRuleBody(stylesSrc, "button.UnicDB-requery-clear");
    expect(body, "rule body for button.UnicDB-requery-clear").not.toBe("");
    expect(body).toMatch(/height\s*:\s*26px/);
  });
});

// -----------------------------------------------------------------------
// Test #2 — edge: requery bar element class exists + CSS rule applied
// -----------------------------------------------------------------------

describeIfBundle("TASK-009 D — requery bar element in DOM", () => {
  itIfBundle(
    "bundle mounts the requery bar after a state message",
    async () => {
      const { root } = loadBundle();
      // The requery bar lives inside the persistent gridWrap; gridWrap is
      // only attached to the panel when a statement is active. Dispatch a
      // minimal 2-row state so the panel takes the grid branch.
      dispatchState(oneStatementState());
      await flushGridEvents();
      const bar = root.querySelector(".UnicDB-requery-bar");
      expect(
        bar,
        "expected .UnicDB-requery-bar element in persistent DOM",
      ).toBeTruthy();
      if (!bar) return;
      const label = bar.querySelector(".UnicDB-requery-label");
      const input = bar.querySelector(".UnicDB-requery-input");
      const runBtn = bar.querySelector("button.UnicDB-requery-run");
      const clearBtn = bar.querySelector("button.UnicDB-requery-clear");
      expect(label).toBeTruthy();
      expect(input).toBeTruthy();
      expect(runBtn).toBeTruthy();
      expect(clearBtn).toBeTruthy();
    },
  );
});

// -----------------------------------------------------------------------
// Test #3 — edge: set-filter alignment — Select All + items share indent
// -----------------------------------------------------------------------

describe("TASK-009 E — set-filter popup left alignment", () => {
  function extractLeftPadding(selector: string): string {
    const body = readRuleBody(stylesSrc, selector);
    if (!body) return "";
    const shorthandMatch = body.match(/padding\s*:\s*([^;]+);/);
    if (shorthandMatch) {
      const shorthand = shorthandMatch[1];
      if (!shorthand) return "";
      const parts = shorthand.trim().split(/\s+/);
      // shorthand `a b c d` or `a b` — left = parts[3] ?? parts[1]
      const left = parts[3] ?? parts[1] ?? "";
      return left;
    }
    const longhandMatch = body.match(/padding-left\s*:\s*([^;]+);/);
    if (longhandMatch) {
      const left = longhandMatch[1];
      return left ? left.trim() : "";
    }
    return "";
  }

  it(".UnicDB-setfilter-selectall-row declares padding (left indent)", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-setfilter-selectall-row");
    expect(body, "selector .UnicDB-setfilter-selectall-row must exist").not.toBe("");
    expect(body).toMatch(/padding(-left)?\s*:/);
  });

  it(".UnicDB-setfilter-entry declares padding (left indent)", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-setfilter-entry");
    expect(body, "selector .UnicDB-setfilter-entry must exist").not.toBe("");
    expect(body).toMatch(/padding(-left)?\s*:/);
  });

  it("both select-all-row and entry rules use the same left padding value", () => {
    const selectAllLeft = extractLeftPadding(".UnicDB-setfilter-selectall-row");
    const entryLeft = extractLeftPadding(".UnicDB-setfilter-entry");
    expect(selectAllLeft, "select-all-row must have a left padding value").not.toBe("");
    expect(entryLeft, "entry must have a left padding value").not.toBe("");
    expect(selectAllLeft).toBe(entryLeft);
  });
});

// -----------------------------------------------------------------------
// Test #4 — regression: themeQuartz.withParams preserves all existing params
// -----------------------------------------------------------------------

describe("TASK-009 — themeQuartz.withParams regression guard", () => {
  it("webview/main.ts keeps the existing four theme params", () => {
    // Read main.ts region containing the `themeQuartz.withParams({...})` call.
    // We assert each of the four existing keys is still present in source so
    // an accidental removal fails this test before review.
    expect(mainSrc).toMatch(/backgroundColor\s*:\s*"var\(--vscode-editor-background/);
    expect(mainSrc).toMatch(/foregroundColor\s*:\s*"var\(--vscode-foreground/);
    expect(mainSrc).toMatch(/accentColor\s*:\s*"var\(--vscode-focusBorder/);
    expect(mainSrc).toMatch(/borderColor\s*:\s*"var\(--vscode-panel-border/);
  });
});
