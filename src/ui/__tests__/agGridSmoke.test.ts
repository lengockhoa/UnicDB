// @vitest-environment jsdom
// AG Grid Community smoke tests (TASK-201).
// Validates that ag-grid-community package is installed, bundle-able, and that
// createGrid renders rows in jsdom, plus the build emits quartz CSS in dist/webview.css.
import { describe, it, expect, beforeAll } from "vitest";
import {
  createGrid,
  getGridApi,
  AllCommunityModule,
  ModuleRegistry,
} from "ag-grid-community";
import type { GridApi, GridOptions } from "ag-grid-community";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// AG Grid v36 ships row models as separate modules; register AllCommunityModule
// so the grid initializes its row model and getDisplayedRowCount() resolves.
ModuleRegistry.registerModules([AllCommunityModule]);

// Minimal jsdom polyfills for AG Grid browser-only APIs that vitest's jsdom env
// may not expose at module-init time.
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
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as new () => ResizeObserverLike;
  }
  if (typeof g.matchMedia === "undefined") {
    const factory = (query: string): MediaQueryListLike => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    });
    g.matchMedia = factory;
  }
});

function setupHost(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = "600px";
  el.style.height = "300px";
  document.body.appendChild(el);
  return el;
}

describe("ag-grid-community smoke (TASK-201)", () => {
  it("createGrid renders 3 rows (happy)", () => {
    const el = setupHost();
    const options: GridOptions = {
      columnDefs: [{ field: "a" }, { field: "b" }],
      rowData: [
        { a: 1, b: "x" },
        { a: 2, b: "y" },
        { a: 3, b: "z" },
      ],
    };
    let api: GridApi | undefined;
    try {
      createGrid(el, options);
      api = getGridApi(el) as GridApi;
      expect(api).toBeDefined();
      expect(api.getDisplayedRowCount()).toBe(3);
    } finally {
      api?.destroy();
      el.remove();
    }
  });

  it("empty rowData does not throw (edge)", () => {
    const el = setupHost();
    const options: GridOptions = {
      columnDefs: [{ field: "a" }, { field: "b" }],
      rowData: [],
    };
    let api: GridApi | undefined;
    expect(() => {
      createGrid(el, options);
    }).not.toThrow();
    try {
      api = getGridApi(el) as GridApi;
      expect(api).toBeDefined();
      expect(api.getDisplayedRowCount()).toBe(0);
    } finally {
      api?.destroy();
      el.remove();
    }
  });

  it("dist/webview.css: legacy quartz theme NOT bundled; Theming API generates CSS at runtime (fix round 2)", () => {
    const cssPath = resolve(process.cwd(), "dist", "webview.css");
    const css = readFileSync(cssPath, "utf8");
    // Legacy quartz stylesheet must NOT be bundled (AG error #106 conflict).
    expect(css).not.toMatch(/\.ag-theme-quartz\s*,\s*\.ag-theme-quartz-dark/);
    expect(css).toMatch(/\.vsdb-ag-host/);
  });
});