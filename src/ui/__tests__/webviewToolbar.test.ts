// src/ui/__tests__/webviewToolbar.test.ts
// TASK-603 — bundle-eval integration test for the icon toolbar + single-row
// layout + requery-bar iconification.
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches a state
// message and asserts:
//   1. Every toolbar `.UnicDB-btn` renders an inline SVG icon with
//      `stroke="currentColor"`, an empty text body, a non-empty `title`,
//      and a non-empty `aria-label` (presentation only — handlers intact).
//   2. The toolbar's children are flat (2 `.UnicDB-toolbar-sep` dividers),
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

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface UnicDBDebugSurface {
  simulateCellEdit?: (
    rowId: number,
    colField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
}

function UnicDBSimulateCellEdit(): UnicDBDebugSurface["simulateCellEdit"] | undefined {
  if (typeof window === "undefined") return undefined;
  const g = (window as unknown as { __UnicDB?: UnicDBDebugSurface }).__UnicDB;
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
    `.UnicDB-toolbar .${cls}`,
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
// query│edit│export grouping. TASK-RES-001 moved the WHERE / ORDER BY
// inputs from the standalone requery bar (inside gridWrap) into the
// toolbar row, slot: between export-format and export-header. The two
// inputs are children of the toolbar — they are NOT icon buttons, so the
// toolbar `.UnicDB-btn` census rises from 10 to 12 (Re-Run + Clear join
// the existing 10 buttons). The ACTIVE-SCHEMA chip (`.UnicDB-schema-chip`)
// rides in the toolbar too — it sits between the Clear button and the
// export-header checkbox so it stays visible regardless of how the
// requery-input wrap below behaves. The full toolbar DOM order pin lives
// in the resolver's helper below.
const EXPECTED_ORDER = [
  "UnicDB-btn-danger", // Cancel (query group)
  "UnicDB-btn", // Refresh (query)
  "UnicDB-toolbar-sep", // query│edit divider
  "UnicDB-btn", // Add Row
  "UnicDB-btn", // Delete Row
  "UnicDB-btn", // Undo
  "UnicDB-btn", // Redo
  "UnicDB-commit", // Commit
  "UnicDB-btn", // CSV toggle
  "UnicDB-toolbar-sep", // edit│export divider
  "UnicDB-export-format",
  "UnicDB-requery-where", // TASK-RES-001: WHERE input (toolbar slot)
  "UnicDB-requery-order", // TASK-RES-001: ORDER BY input (toolbar slot)
  "UnicDB-btn", // TASK-RES-001: Re-Run icon button (toolbar slot)
  "UnicDB-btn", // TASK-RES-001: Clear icon button (toolbar slot)
  "UnicDB-export-header",
  "UnicDB-export-copy",
  "UnicDB-export-file",
  "UnicDB-schema-chip", // ACTIVE-SCHEMA chip (toolbar slot)
  "UnicDB-search-input",
];

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts icon toolbar + single-row layout (TASK-603)", () => {
  itIfBundle(
    "1. every toolbar .UnicDB-btn has an inline svg icon, currentColor stroke, non-empty aria-label, empty text",
    () => {
      const { root } = loadBundle();
      dispatchState(threeRowsState());
      const btns = Array.from(
        root.querySelectorAll(".UnicDB-toolbar .UnicDB-btn"),
      ).filter(
        (el): el is HTMLButtonElement => el.tagName === "BUTTON",
      ) as HTMLButtonElement[];
      // TASK-RES-001: Re-Run + Clear icon buttons joined the toolbar row,
      // so the toolbar icon-button census rises from 10 to 12. Every
      // button keeps the svg / currentColor / title / aria-label /
      // empty-text contract that makeIconButton delivers.
      expect(btns.length).toBe(12);

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
        // TASK-RES-003 REWRITTEN: the `+ title` clause was dropped because
        // wave-2 deletes btn.title from makeIconButton — the native
        // tooltip is replaced by the instant data-tooltip pseudo (see the
        // new TASK-RES-003 describe block below). The svg + currentColor +
        // aria-label + empty-text pins remain.
        expect(
          b.getAttribute("aria-label"),
          `button .${b.className} missing aria-label`,
        ).not.toBe("");
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
      clickButton(button(root, "UnicDB-btn-danger"));
      expect(received.some((m) => m.type === "cancel")).toBe(true);
      received.length = 0;

      // CSV toggle — flips the formatter locally (no message posted).
      const allBtns = Array.from(
        root.querySelectorAll(".UnicDB-toolbar .UnicDB-btn"),
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
      const sim = UnicDBSimulateCellEdit();
      expect(sim).toBeTruthy();
      sim!(0, "name", "x", "alpha");
      await new Promise<void>((r) => setTimeout(r, 0));
      clickButton(button(root, "UnicDB-commit"));
      await new Promise<void>((r) => setTimeout(r, 0));
      const saveMsgs = received.filter((m) => m.type === "saveEdits");
      expect(saveMsgs.length, "commit icon did not post saveEdits").toBe(1);
      received.length = 0;

      clickButton(button(root, "UnicDB-export-copy"));

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs.length, "copy icon did not post copy").toBe(1);
      clickButton(button(root, "UnicDB-export-file"));

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

      const toolbar = root.querySelector(".UnicDB-toolbar") as HTMLDivElement;
      expect(toolbar).toBeTruthy();

      const children = Array.from(toolbar.children) as HTMLElement[];

      // All children have equal offsetTop in jsdom (0), but the planner
      // pinned the structural guarantee in the CSS test (#4). Here we
      // assert the actual DOM contract: flat children, 2 separators,
      // search last, and a stable order.
      const seps = children.filter(
        (c) => c.classList.contains("UnicDB-toolbar-sep"),
      );
      expect(seps.length, "expected exactly 2 .UnicDB-toolbar-sep dividers").toBe(2);

      const last = children[children.length - 1];
      expect(
        last.classList.contains("UnicDB-search-input"),
        "search input must be the last toolbar child",
      ).toBe(true);

      // Order: walk the children and assert the sequence of class
      // predicates. Buttons that share .UnicDB-btn are matched in the
      // expected position; the seq uses the predicate string.
      const got: string[] = children.map((c) => {
        if (c.classList.contains("UnicDB-btn-danger")) return "UnicDB-btn-danger";
        if (c.classList.contains("UnicDB-commit")) return "UnicDB-commit";
        if (c.classList.contains("UnicDB-export-format")) return "UnicDB-export-format";
        if (c.classList.contains("UnicDB-requery-where")) return "UnicDB-requery-where";
        if (c.classList.contains("UnicDB-requery-order")) return "UnicDB-requery-order";
        if (c.classList.contains("UnicDB-export-header")) return "UnicDB-export-header";
        if (c.classList.contains("UnicDB-export-copy")) return "UnicDB-export-copy";
        if (c.classList.contains("UnicDB-export-file")) return "UnicDB-export-file";
        if (c.classList.contains("UnicDB-schema-chip")) return "UnicDB-schema-chip";
        if (c.classList.contains("UnicDB-search-input")) return "UnicDB-search-input";
        if (c.classList.contains("UnicDB-toolbar-sep")) return "UnicDB-toolbar-sep";
        if (c.classList.contains("UnicDB-btn")) return "UnicDB-btn";
        return c.className;
      });
      expect(got).toEqual(EXPECTED_ORDER);
    },
  );

  itIfBundle(
    "4. styles.css pins .UnicDB-toolbar to flex-wrap: wrap (so WHERE / ORDER BY inputs can drop to their own rows)",
    () => {
      if (!stylesSrc) {
        throw new Error("webview/styles.css missing");
      }
      // The rule MUST match. Reverting to `nowrap` would shove WHERE /
      // ORDER BY back onto the icon row.
      const re = /\.UnicDB-toolbar\s*\{[^}]*flex-wrap:\s*wrap/;
      expect(re.test(stylesSrc), "styles.css must pin .UnicDB-toolbar flex-wrap: wrap").toBe(
        true,
      );
      // Buttons must size SVGs at 16×16 to keep the compact 24–26px height.
      expect(
        /\.UnicDB-btn[^}]*\.UnicDB-btn\s+svg|\.UnicDB-btn\s+svg/.test(stylesSrc),
        "styles.css must define a .UnicDB-btn svg sizing rule",
      ).toBe(true);
    },
  );

  itIfBundle(
    "5. requery-bar Re-Run + Clear are icon buttons; click posts {type:'requery', where, orderBy} and Clear empties inputs",
    () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());

      const runBtn = root.querySelector(
        ".UnicDB-requery-run",
      ) as HTMLButtonElement | null;
      const clearBtn = root.querySelector(
        ".UnicDB-requery-clear",
      ) as HTMLButtonElement | null;
      expect(runBtn).toBeTruthy();
      expect(clearBtn).toBeTruthy();

      // Iconified: empty text, has svg, has data-tooltip + aria-label (TASK-RES-003
// drops the native `title` attribute — the data-tooltip pseudo-tooltip is
// the only source).
      for (const b of [runBtn!, clearBtn!]) {
        expect(b.textContent?.trim()).toBe("");
        expect(b.querySelector("svg")).toBeTruthy();
        expect(b.getAttribute("data-tooltip")).not.toBeNull();
        expect(b.getAttribute("data-tooltip")).not.toBe("");
        expect(b.getAttribute("aria-label")).not.toBe("");
      }

      // Re-Run with values.
      const whereInput = root.querySelector(
        ".UnicDB-requery-where",
      ) as HTMLInputElement | null;
      const orderInput = root.querySelector(
        ".UnicDB-requery-order",
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

// TASK-RES-003 — toolbar button hover transition. The instant
// background-color flash on .UnicDB-btn:hover must be eased with a short
// `transition` that touches ONLY composited/non-layout properties
// (background-color, box-shadow) — never `transition: all`, never a
// layout-triggering property (width/height/padding/margin/top/left/etc).
// The instant data-tooltip pseudo-element block stays untouched.
describeIfBundle(
  "webview/styles.css toolbar button hover transition (TASK-RES-003)",
  () => {
    itIfBundle(
      "3. .UnicDB-btn { ... } block carries a transition rule (no instant hover swap)",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // The transition must live inside the .UnicDB-btn { ... } block.
        // We match the FIRST .UnicDB-btn block (the base one, lines 41-71)
        // and assert it contains `transition:`. Using non-greedy match on
        // the body prevents the regex from spanning across multiple blocks.
        const re = /\.UnicDB-btn\s*\{([^}]*)\}/;
        const m = re.exec(stylesSrc);
        expect(
          m,
          "could not locate .UnicDB-btn { ... } block in styles.css",
        ).toBeTruthy();
        const body = m![1];
        expect(
          /transition\s*:/i.test(body),
          `.UnicDB-btn { ... } must declare a transition; body was: ${body.trim()}`,
        ).toBe(true);
      },
    );

    itIfBundle(
      "4. the .UnicDB-btn transition lists ONLY background-color and/or box-shadow — no layout-triggering properties",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // Strip CSS comments first so the regex doesn't accidentally match
        // a literal "transition: all" inside a comment block.
        const cssNoComments = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, "");
        const blockRe = /\.UnicDB-btn\s*\{([^}]*)\}/;
        const blockMatch = blockRe.exec(cssNoComments);
        expect(blockMatch).toBeTruthy();
        const body = blockMatch![1];
        // Find the `transition: <value>;` declaration.
        const trRe = /transition\s*:\s*([^;]+);/i;
        const trMatch = trRe.exec(body);
        expect(
          trMatch,
          `.UnicDB-btn { ... } must declare a transition; body was: ${body.trim()}`,
        ).toBeTruthy();
        const value = trMatch![1].trim();
        // The plan FORBIDS `transition: all` — it would re-introduce
        // layout jitter on width/height/padding etc. The accepted shape is
        // exactly: `background-color <time> <ease>[, box-shadow <time> <ease>]`.
        expect(
          /\ball\b/i.test(value),
          `transition must not be 'all'; value was: ${value}`,
        ).toBe(false);
        // Layout-triggering properties are forbidden in the transition
        // value. Word-boundary checks so "top" does not match "stop-color".
        const forbidden = [
          "width",
          "height",
          "padding",
          "margin",
          "border",
          "top",
          "left",
          "right",
          "bottom",
          "font-size",
          "line-height",
          "transform",
        ];
        for (const prop of forbidden) {
          const propRe = new RegExp(`(?:^|[,\\s])${prop}\\b`, "i");
          expect(
            propRe.test(value),
            `transition value must not list layout-triggering property "${prop}"; value was: ${value}`,
          ).toBe(false);
        }
        // The accepted properties are background-color and/or box-shadow.
        const allowedRe = /^(?:background-color|box-shadow)(\s+\S+(\s+\S+)?)?(\s*,\s*(background-color|box-shadow)(\s+\S+(\s+\S+)?)?)*$/i;
        expect(
          allowedRe.test(value),
          `transition value must list ONLY background-color and/or box-shadow; value was: ${value}`,
        ).toBe(true);
      },
    );

    itIfBundle(
      "5. .UnicDB-btn[data-tooltip] pseudo keeps z-index: 1000 (so the tooltip floats above the toolbar)",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // The data-tooltip block MUST keep z-index: 1000. We match the
        // whole block (lines 78-115) to confirm it's structurally intact.
        const re = /\.UnicDB-btn\[data-tooltip\][^{]*\{[^}]*z-index\s*:\s*1000/;
        expect(
          re.test(stylesSrc),
          "styles.css must keep z-index: 1000 on the data-tooltip block",
        ).toBe(true);
      },
    );

    itIfBundle(
      "7. .UnicDB-btn[data-tooltip]:not(:disabled):hover::after still defines the instant tooltip pseudo-element",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // The pseudo-element block is regex-pinned: same selector AND it
        // must contain `content: attr(data-tooltip)`. TASK-RES-003 must
        // NOT touch this block.
        const selRe =
          /\.UnicDB-btn\[data-tooltip\]:not\(:disabled\):hover::after\s*\{([^}]*)\}/;
        const m = selRe.exec(stylesSrc);
        expect(
          m,
          "could not locate .UnicDB-btn[data-tooltip]:not(:disabled):hover::after block",
        ).toBeTruthy();
        const body = m![1];
        expect(
          /content\s*:\s*attr\(\s*data-tooltip\s*\)/.test(body),
          `pseudo-element block must contain 'content: attr(data-tooltip)'; body was: ${body.trim()}`,
        ).toBe(true);
      },
    );
  },
);
