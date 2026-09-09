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
// Test #1 — happy: requery input CSS rules (TASK-RES-001 toolbar slot)
// -----------------------------------------------------------------------
//
// TASK-009 D tested the OLD standalone requery bar — .UnicDB-requery-bar
// (display:flex + align-items:center wrapper) and .UnicDB-requery-label
// (shared 26px baseline label). TASK-RES-001 moved the inputs into the
// toolbar row, dropped the bar wrapper + labels, and re-tuned the input
// height to 24px so it lines up with the 24-26px .UnicDB-btn height in
// the same flex row. The buttons are .UnicDB-btn (height from the shared
// rule) and need no extra height override.
//
// TASK-COLLAPSE-002: the toolbar is now a column of two `.UnicDB-toolbar-row`
// wrappers, each `flex-wrap: nowrap` + `overflow: hidden` so a third row
// can never appear. The WHERE / ORDER BY inputs live on row 2 and SHARE
// the leftover horizontal space inside that nowrap row via
// `flex: 1 1 100%; min-width: 0` — `flex-basis: 100%` + `flex-shrink: 1`
// just lets them split whatever space the fixed-size buttons leave.
// The old single-row contract (`flex: 1 1 140px; min-width: 80px`) is
// FORBIDDEN.

describe("TASK-RES-001 / TASK-COLLAPSE-002 — requery input CSS alignment (row-2 toolbar slot)", () => {
  it(".UnicDB-requery-input sets height:24px + box-sizing:border-box", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-requery-input");
    expect(body, "rule body for .UnicDB-requery-input").not.toBe("");
    expect(body).toMatch(/height\s*:\s*24px/);
    expect(body).toMatch(/box-sizing\s*:\s*border-box/);
  });

  it(".UnicDB-requery-input.UnicDB-requery-where fills row 2 (flex 1 1 100% + min-width 0, NOT 140px/80px)", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-requery-input.UnicDB-requery-where");
    expect(body, "rule body for .UnicDB-requery-input.UnicDB-requery-where").not.toBe("");
    expect(body).toMatch(/flex\s*:\s*1\s+1\s+100\s*%/);
    expect(body).toMatch(/min-width\s*:\s*0/);
    // The OLD single-row TASK-RES-002 / TASK-COLLAPSE-001 contract used
    // px-based sizes (`flex: 1 1 140px; min-width: 80px`); under the
    // 2-row layout those px floors would clip Re-Run / Clear on
    // moderate widths. The new contract must NOT use the px shapes.
    expect(body).not.toMatch(/flex\s*:\s*1\s+1\s+140px/);
    expect(body).not.toMatch(/min-width\s*:\s*80px/);
  });

  it(".UnicDB-requery-input.UnicDB-requery-order fills row 2 (flex 1 1 100% + min-width 0, NOT 140px/80px)", () => {
    const body = readRuleBody(stylesSrc, ".UnicDB-requery-input.UnicDB-requery-order");
    expect(body, "rule body for .UnicDB-requery-input.UnicDB-requery-order").not.toBe("");
    expect(body).toMatch(/flex\s*:\s*1\s+1\s+100\s*%/);
    expect(body).toMatch(/min-width\s*:\s*0/);
    expect(body).not.toMatch(/flex\s*:\s*1\s+1\s+140px/);
    expect(body).not.toMatch(/min-width\s*:\s*80px/);
  });

  it("button.UnicDB-requery-run + button.UnicDB-requery-clear set flex:0 0 auto", () => {
    const runBody = readRuleBody(stylesSrc, "button.UnicDB-requery-run");
    const clearBody = readRuleBody(stylesSrc, "button.UnicDB-requery-clear");
    expect(runBody, "rule body for button.UnicDB-requery-run").not.toBe("");
    expect(clearBody, "rule body for button.UnicDB-requery-clear").not.toBe("");
    expect(runBody).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    expect(clearBody).toMatch(/flex\s*:\s*0\s+0\s+auto/);
  });

  it(".UnicDB-requery-bar + .UnicDB-requery-label rules are gone (TASK-RES-001 removed them)", () => {
    // The bar wrapper and label were dropped when the inputs moved into
    // the toolbar. Make sure no stale rules survive.
    expect(readRuleBody(stylesSrc, ".UnicDB-requery-bar")).toBe("");
    expect(readRuleBody(stylesSrc, ".UnicDB-requery-label")).toBe("");
  });
});

// -----------------------------------------------------------------------
// Test #2 — edge: requery inputs + buttons mount into the toolbar (not a bar)
// -----------------------------------------------------------------------

describeIfBundle("TASK-RES-001 — requery elements mounted in toolbar", () => {
  itIfBundle(
    "bundle mounts the WHERE / ORDER BY inputs + Re-Run / Clear buttons in the toolbar (no requery bar)",
    async () => {
      const { root } = loadBundle();
      dispatchState(oneStatementState());
      await flushGridEvents();

      // No standalone requery-bar wrapper.
      expect(root.querySelector(".UnicDB-requery-bar")).toBeNull();
      expect(root.querySelector("[data-UnicDB-requery-bar]")).toBeNull();

      // Toolbar owns all four elements.
      const toolbar = root.querySelector(".UnicDB-toolbar") as HTMLElement | null;
      expect(toolbar, "expected .UnicDB-toolbar element").toBeTruthy();
      if (!toolbar) return;

      const whereInput = toolbar.querySelector(
        ".UnicDB-requery-where",
      ) as HTMLInputElement | null;
      const orderInput = toolbar.querySelector(
        ".UnicDB-requery-order",
      ) as HTMLInputElement | null;
      const runBtn = toolbar.querySelector(
        "button.UnicDB-requery-run",
      ) as HTMLButtonElement | null;
      const clearBtn = toolbar.querySelector(
        "button.UnicDB-requery-clear",
      ) as HTMLButtonElement | null;
      expect(whereInput).toBeTruthy();
      expect(orderInput).toBeTruthy();
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
