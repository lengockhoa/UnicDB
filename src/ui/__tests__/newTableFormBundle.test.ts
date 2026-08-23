// src/ui/__tests__/newTableFormBundle.test.ts
// TASK-004 — jsdom bundle test for webview/newTableFormMain.ts.
//
// Loads dist/newTableForm.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches an init
// message and asserts the DOM zones, live preview, OK-button gating, Escape
// → cancel, and the syncIdColumn break-on-manual-rename boundary.
//
// IMPORTANT: This test MUST run after `npm run compile` so that
// dist/newTableForm.js exists — see TASK-004 §Verification Commands. If
// missing, the test is skipped with an explanatory message.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs (AG Grid bundle compatibility if loaded as side effect)
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

const distPath = resolve(process.cwd(), "dist", "newTableForm.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface BundleHandle {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/newTableForm.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-form-body"></div>';
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

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

interface InitPayload {
  type: "init";
  mode: "create" | "modify";
  schema: string;
  originalTableName?: string;
  spec: {
    name: string;
    schema: string;
    columns: Array<{
      name: string;
      type: string;
      default?: string;
      nullable?: boolean;
      originalName?: string;
    }>;
    keys: Array<Record<string, unknown>>;
  };
  loadError?: string;
}

interface PreviewPayload {
  type: "preview";
  sql: string;
  errors: string[];
}

function isInit(m: unknown): m is InitPayload {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isSpecChanged(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "specChanged";
}
function isPreview(m: unknown): m is PreviewPayload {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "preview";
}

function last<T>(arr: Array<T>): T | undefined {
  return arr[arr.length - 1];
}

describeIfBundle("webview/newTableFormMain.ts bundle (TASK-004)", () => {
  itIfBundle("#8 DOM zones + counts on create init", () => {
    const { received } = loadBundle();
    // The bundle auto-posts {type:"ready"} on load → host answers with init.
    dispatch({
      type: "init",
      mode: "create",
      schema: "public",
      spec: {
        name: "table_name",
        schema: "public",
        columns: [
          { name: "id_table_name", type: "varchar", default: "uuid_in(...)" },
          { name: "created_at", type: "varchar", default: "now()" },
        ],
        keys: [],
      },
    });
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    // Sections with live counts.
    const sectionLabels = Array.from(
      root.querySelectorAll(
        ".vsdb-designer-section-title, .vsdb-designer-section h3, h3, h2, h4",
      ),
    )
      .map((el) => (el as HTMLElement).textContent ?? "")
      .join(" | ");
    expect(sectionLabels).toMatch(/COLUMNS \(2\)/);
    expect(sectionLabels).toMatch(/KEYS \(0\)/);
    // Placeholder shown when nothing selected.
    const placeholder = root.textContent ?? "";
    expect(placeholder).toContain(
      "Select a column or key from the left panel to edit.",
    );
    // Bottom SQL preview.
    expect(root.querySelector("#sql-preview")).not.toBeNull();
    // OK enabled for create with default valid spec.
    const ok = root.querySelector("#okBtn") as HTMLButtonElement;
    expect(ok).not.toBeNull();
    expect(ok.disabled).toBe(false);
    // bundle already posted ready; the host would reply with init in real flow.
    expect(received.some((m) => (m as { type?: string }).type === "ready")).toBe(true);
  });

  itIfBundle("#9 live preview + id tracking when table renamed", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      mode: "create",
      schema: "public",
      spec: {
        name: "table_name",
        schema: "public",
        columns: [
          { name: "id_table_name", type: "varchar", default: "uuid_in(...)" },
          { name: "created_at", type: "varchar", default: "now()" },
        ],
        keys: [],
      },
    });
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    // The table-name input must exist; rename it to "orders" + dispatch input.
    const tableNameInput = root.querySelector("#tableName") as HTMLInputElement;
    expect(tableNameInput).not.toBeNull();
    tableNameInput.value = "orders";
    tableNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    tableNameInput.dispatchEvent(new Event("change", { bubbles: true }));
    // Look for the most recent specChanged message and assert column[0].name.
    const specChanged = received.filter(isSpecChanged);
    expect(specChanged.length).toBeGreaterThan(0);
    const lastSpecChanged = last(specChanged) as {
      spec: { columns: Array<{ name: string }>; name: string };
    };
    expect(lastSpecChanged.spec.name).toBe("orders");
    expect(lastSpecChanged.spec.columns[0].name).toBe("id_orders");
    // The bottom <pre> must reflect the live preview (after host posts preview).
    dispatch({
      type: "preview",
      sql: 'CREATE TABLE "public"."orders" (\n    "id_orders" varchar\n);\n',
      errors: [],
    });
    const pre = root.querySelector("#sql-preview") as HTMLPreElement;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain('CREATE TABLE "public"."orders"');
  });

  itIfBundle("#10 OK disabled on duplicate column names + errors visible", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      mode: "create",
      schema: "public",
      spec: {
        name: "users",
        schema: "public",
        columns: [
          { name: "id", type: "bigint" },
          { name: "name", type: "varchar" },
        ],
        keys: [],
      },
    });
    // Click the first column row to select it.
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    const colItem = root.querySelector('[data-section="columns"] li, .vsdb-designer-col-item, .vsdb-designer-item') as HTMLElement | null;
    if (colItem) colItem.click();
    // Simulate host posting errors.
    dispatch({
      type: "preview",
      sql: "",
      errors: ["Duplicate column name: id", "Column type is required: name"],
    });
    const ok = root.querySelector("#okBtn") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    const allText = root.textContent ?? "";
    expect(allText).toContain("Duplicate column name: id");
    expect(allText).toContain("Column type is required: name");
    void received;
  });

  itIfBundle("#11 Escape keydown → cancel posted", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      mode: "create",
      schema: "public",
      spec: {
        name: "table_name",
        schema: "public",
        columns: [{ name: "id_table_name", type: "varchar" }],
        keys: [],
      },
    });
    // Dispatch a global keydown Escape.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(received.some((m) => (m as { type?: string }).type === "cancel")).toBe(true);
  });

  itIfBundle("#12 tracking breaks: manual id rename stops auto-rename forever", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      mode: "create",
      schema: "public",
      spec: {
        name: "table_name",
        schema: "public",
        columns: [
          { name: "id_table_name", type: "varchar" },
          { name: "created_at", type: "varchar" },
        ],
        keys: [],
      },
    });
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    // Click the first column item to select it.
    const firstLi = root.querySelector('li[data-section="columns"]') as HTMLElement | null;
    expect(firstLi).not.toBeNull();
    firstLi!.click();
    // After click, edit pane should show column editor with #colName.
    const edit = root.querySelector("#colName") as HTMLInputElement | null;
    expect(edit).not.toBeNull();
    edit!.value = "pk";
    edit!.dispatchEvent(new Event("input", { bubbles: true }));
    edit!.dispatchEvent(new Event("change", { bubbles: true }));
    // Now rename table to "x" → id column must STAY "pk".
    const tableNameInput = root.querySelector("#tableName") as HTMLInputElement;
    expect(tableNameInput).not.toBeNull();
    tableNameInput.value = "x";
    tableNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    tableNameInput.dispatchEvent(new Event("change", { bubbles: true }));
    const specChanged = received.filter(isSpecChanged);
    const lastSpec = last(specChanged) as {
      spec: { name: string; columns: Array<{ name: string }> };
    };
    expect(lastSpec.spec.name).toBe("x");
    expect(lastSpec.spec.columns[0].name).toBe("pk");
  });
});
