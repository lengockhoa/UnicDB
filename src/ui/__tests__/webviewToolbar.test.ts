// src/ui/__tests__/webviewToolbar.test.ts
// TASK-603 — bundle-eval integration test for the icon toolbar + single-row
// layout + requery-bar iconification.
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches a state
// message and asserts:
//   1. Every toolbar `.vsdb-btn` renders an inline SVG icon with
//      `stroke="currentColor"`, an empty text body, a non-empty `title`,
//      and a non-empty `aria-label` (presentation only — handlers intact).
//   2. The toolbar's children are flat (2 `.vsdb-toolbar-sep` dividers),
//      the search input is the last child, and group order is
//      query│edit│export.
//   3. styles.css pins `flex-wrap: nowrap` so wrapping is impossible by
//      construction at any width.
//   4. Requery-bar `Re-Run` and `Clear` buttons are iconified; clicking
//      them still posts the right messages / empties the inputs.
//
// Mirrors the bundle pattern from src/ui/__tests__/webviewExport.test.ts.
// If dist/webview.js is missing, all tests are skipped — `npm run compile`
// must run first.
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
    ResizeObserver?: unknown;
    matchMedia?: unknown;
  };
  if (typeof g.ResizeObserver === "undefined") {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserverLike;
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
const stylesPath = resolve(process.cwd(), "webview", "styles.css");
const stylesSrc = existsSync(stylesPath) ? readFileSync(stylesPath, "utf8") : null;

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface VsdbDebugSurface {
  simulateCellEdit?: (
    rowId: number,
    colField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
}

function vsdbSimulateCellEdit(): VsdbDebugSurface["simulateCellEdit"] | undefined {
  if (typeof window === "undefined") return undefined;
  const g = (window as unknown as { __vsdb?: VsdbDebugSurface }).__vsdb;
  return g?.simulateCellEdit;
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

  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-webview"></div>';
  const root = document.getElementById("vsdb-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrc);

  return { received, root };
}


function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}
function threeRowsState(): Record<string, unknown> {
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
            [3, "gamma"],
          ],
          rowCount: 3,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

/** Read a button by its toolbar class, fail fast if missing. */
function button(
  root: HTMLElement,
  cls: string,
): HTMLButtonElement {
  const el = root.querySelector(
    `.vsdb-toolbar .${cls}`,
  ) as HTMLButtonElement | null;
  if (!el) {
    throw new Error(`toolbar button .${cls} not found`);
  }
  return el;
}


/** Dispatch a bubbling click on a button. Bypasses the `disabled` flag so
 *  the test exercises the handler-attachment contract (presentation only,
 *  no behavior change) independently of the button's enabled state. */
function clickButton(b: HTMLButtonElement): void {
  b.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}


// Toolbar flat children we expect to find in order. Used to assert
// query│edit│export grouping.
const EXPECTED_ORDER = [
  "vsdb-btn-danger", // Cancel (query group)
  "vsdb-btn", // Refresh (query)
  "vsdb-toolbar-sep", // query│edit divider
  "vsdb-btn", // Add Row
  "vsdb-btn", // Delete Row
  "vsdb-btn", // Undo
  "vsdb-btn", // Redo
  "vsdb-commit", // Commit
  "vsdb-btn", // CSV toggle
  "vsdb-toolbar-sep", // edit│export divider
  "vsdb-export-format",
  "vsdb-export-header",
  "vsdb-export-copy",
  "vsdb-export-file",
  "vsdb-search-input",
];

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts icon toolbar + single-row layout (TASK-603)", () => {
  itIfBundle(
    "1. every toolbar .vsdb-btn has an inline svg icon, currentColor stroke, non-empty title + aria-label, empty text",
    () => {
      const { root } = loadBundle();
      dispatchState(threeRowsState());
      const btns = Array.from(
        root.querySelectorAll(".vsdb-toolbar .vsdb-btn"),
      ).filter(
        (el): el is HTMLButtonElement => el.tagName === "BUTTON",
      ) as HTMLButtonElement[];
      expect(btns.length).toBe(10);

      for (const b of btns) {
        const svg = b.querySelector("svg");
        expect(svg, `button .${b.className} missing <svg>`).toBeTruthy();
        // currentColor for stroke or fill (Export-to-file uses fill on rect).
        const stroke = svg!.getAttribute("stroke");
        const fill = svg!.getAttribute("fill");
        const usesCurrent =
          (stroke !== null && stroke.includes("currentColor")) ||
          (fill !== null && fill.includes("currentColor"));
        expect(usesCurrent, `button .${b.className} svg lacks currentColor`).toBe(true);
        expect(
          b.textContent?.trim(),
          `button .${b.className} must have no visible text`,
        ).toBe("");
        expect(b.title, `button .${b.className} missing title`).not.toBe("");
        expect(b.getAttribute("aria-label"), `button .${b.className} missing aria-label`).not.toBe(
          "",
        );
        // viewBox must be 0 0 16 16 (icon-only sizing).
        expect(svg!.getAttribute("viewBox")).toBe("0 0 16 16");
        // svg must be aria-hidden so screen readers fall back to title/aria-label.
        expect(svg!.getAttribute("aria-hidden")).toBe("true");
      }
    },
  );

  itIfBundle(
    "2. icon buttons still post the right messages (Cancel, Commit, Copy, Export to file, CSV toggle)",
    async () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());
      await new Promise<void>((r) => setTimeout(r, 0));

      // Cancel — should post {type:'cancel'}.
      clickButton(button(root, "vsdb-btn-danger"));
      expect(received.some((m) => m.type === "cancel")).toBe(true);
      received.length = 0;

      // CSV toggle — flips the formatter locally (no message posted).
      const allBtns = Array.from(
        root.querySelectorAll(".vsdb-toolbar .vsdb-btn"),
      ).filter((el): el is HTMLButtonElement => el.tagName === "BUTTON");
      const csv = allBtns.find((b) =>
        (b.title || b.getAttribute("aria-label") || "").toLowerCase().includes("csv"),
      );
      expect(csv, "CSV toggle button not found").toBeTruthy();
      clickButton(csv!);
      // The CSV toggle does not post a message; it flips the formatter
      // locally. Click must at minimum not throw and leave the button in
      // the DOM.
      expect(csv!.isConnected).toBe(true);
      received.length = 0;

      // Commit — no dirty edits → no-op. With one dirty edit it posts a
      // saveEdits batch. We use the bundle's exposed simulateCellEdit
      // hook (same surface as webviewSaveEdits.test.ts).
      const sim = vsdbSimulateCellEdit();
      expect(sim).toBeTruthy();
      sim!(0, "name", "x", "alpha");
      await new Promise<void>((r) => setTimeout(r, 0));
      clickButton(button(root, "vsdb-commit"));
      await new Promise<void>((r) => setTimeout(r, 0));
      const saveMsgs = received.filter((m) => m.type === "saveEdits");
      expect(saveMsgs.length, "commit icon did not post saveEdits").toBe(1);
      received.length = 0;

      clickButton(button(root, "vsdb-export-copy"));

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs.length, "copy icon did not post copy").toBe(1);
      clickButton(button(root, "vsdb-export-file"));

      // Export to file.

      const expMsgs = received.filter((m) => m.type === "exportFile");
      expect(expMsgs.length, "export icon did not post exportFile").toBe(1);
    },
  );

  itIfBundle(
    "3. single flex row: flat children, 2 separators, search is last, query│edit│export order",
    () => {
      const { root } = loadBundle();
      dispatchState(threeRowsState());

      const toolbar = root.querySelector(".vsdb-toolbar") as HTMLDivElement;
      expect(toolbar).toBeTruthy();

      const children = Array.from(toolbar.children) as HTMLElement[];

      // All children have equal offsetTop in jsdom (0), but the planner
      // pinned the structural guarantee in the CSS test (#4). Here we
      // assert the actual DOM contract: flat children, 2 separators,
      // search last, and a stable order.
      const seps = children.filter(
        (c) => c.classList.contains("vsdb-toolbar-sep"),
      );
      expect(seps.length, "expected exactly 2 .vsdb-toolbar-sep dividers").toBe(2);

      const last = children[children.length - 1];
      expect(
        last.classList.contains("vsdb-search-input"),
        "search input must be the last toolbar child",
      ).toBe(true);

      // Order: walk the children and assert the sequence of class
      // predicates. Buttons that share .vsdb-btn are matched in the
      // expected position; the seq uses the predicate string.
      const got: string[] = children.map((c) => {
        if (c.classList.contains("vsdb-btn-danger")) return "vsdb-btn-danger";
        if (c.classList.contains("vsdb-commit")) return "vsdb-commit";
        if (c.classList.contains("vsdb-export-format")) return "vsdb-export-format";
        if (c.classList.contains("vsdb-export-header")) return "vsdb-export-header";
        if (c.classList.contains("vsdb-export-copy")) return "vsdb-export-copy";
        if (c.classList.contains("vsdb-export-file")) return "vsdb-export-file";
        if (c.classList.contains("vsdb-search-input")) return "vsdb-search-input";
        if (c.classList.contains("vsdb-toolbar-sep")) return "vsdb-toolbar-sep";
        if (c.classList.contains("vsdb-btn")) return "vsdb-btn";
        return c.className;
      });
      expect(got).toEqual(EXPECTED_ORDER);
    },
  );

  itIfBundle(
    "4. styles.css pins .vsdb-toolbar to flex-wrap: nowrap (no wrap at any width)",
    () => {
      if (!stylesSrc) {
        throw new Error("webview/styles.css missing");
      }
      // The rule MUST match. Wrapping would require removing this.
      const re = /\.vsdb-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/;
      expect(re.test(stylesSrc), "styles.css must pin .vsdb-toolbar flex-wrap: nowrap").toBe(
        true,
      );
      // Buttons must size SVGs at 16×16 to keep the compact 24–26px height.
      expect(
        /\.vsdb-btn[^}]*\.vsdb-btn\s+svg|\.vsdb-btn\s+svg/.test(stylesSrc),
        "styles.css must define a .vsdb-btn svg sizing rule",
      ).toBe(true);
    },
  );

  itIfBundle(
    "5. requery-bar Re-Run + Clear are icon buttons; click posts {type:'requery', where, orderBy} and Clear empties inputs",
    () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());

      const runBtn = root.querySelector(
        ".vsdb-requery-run",
      ) as HTMLButtonElement | null;
      const clearBtn = root.querySelector(
        ".vsdb-requery-clear",
      ) as HTMLButtonElement | null;
      expect(runBtn).toBeTruthy();
      expect(clearBtn).toBeTruthy();

      // Iconified: empty text, has svg, has title.
      for (const b of [runBtn!, clearBtn!]) {
        expect(b.textContent?.trim()).toBe("");
        expect(b.querySelector("svg")).toBeTruthy();
        expect(b.title).not.toBe("");
        expect(b.getAttribute("aria-label")).not.toBe("");
      }

      // Re-Run with values.
      const whereInput = root.querySelector(
        ".vsdb-requery-where",
      ) as HTMLInputElement | null;
      const orderInput = root.querySelector(
        ".vsdb-requery-order",
      ) as HTMLInputElement | null;
      expect(whereInput).toBeTruthy();
      expect(orderInput).toBeTruthy();
      whereInput!.value = "id > 1";
      orderInput!.value = "id DESC";
      clickButton(runBtn!);
      const requeryMsgs = received.filter((m) => m.type === "requery");
      expect(requeryMsgs).toHaveLength(1);
      expect(requeryMsgs[0]).toEqual({
        type: "requery",
        index: 0,
        where: "id > 1",
        orderBy: "id DESC",
      });

      // Clear empties both inputs.
      clickButton(clearBtn!);
      expect(whereInput!.value).toBe("");
      expect(orderInput!.value).toBe("");
    },
  );
});
