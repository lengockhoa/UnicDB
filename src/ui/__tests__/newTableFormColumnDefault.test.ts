// src/ui/__tests__/newTableFormColumnDefault.test.ts
// TASK-004 — jsdom source-level tests cho webview/newTableFormMain.ts.
//
// Imports the webview TS module directly (NOT the dist bundle — unlike
// newTableFormBundle.test.ts). The module guards `declare const
// acquireVsCodeApi` via `typeof acquireVsCodeApi === "function"`, so we
// install a stub via vi.stubGlobal. Per-test module reset is done with
// vi.resetModules() + dynamic import — exception: a test that exercises
// module-loading lifecycle intentionally.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- minimal DOM stubs -----------------------------------------------------

interface ReceivedMsg {
  type: string;
  spec?: {
    columns: Array<{ name: string; type: string; default?: string; nullable?: boolean }>;
    [k: string]: unknown;
  };
}
beforeEach(() => {
  // data-vsdb-skip-auto-init tells the webview module NOT to call render()
  // + post({type:"ready"}) at import time — tests drive the lifecycle
  // explicitly via dispatchInit() so each test gets a clean render against
  // its own spec without leaking the previous test's selectedColumn.
  document.body.innerHTML = '<div id="vsdb-root" data-vsdb-skip-auto-init="true"></div>';
  const received: ReceivedMsg[] = [];
  const api = { postMessage: (m: unknown) => received.push(m as ReceivedMsg) };
  vi.stubGlobal("acquireVsCodeApi", () => api);
  (window as unknown as { __vsdbReceived: ReceivedMsg[] }).__vsdbReceived = received;
});

afterEach(async () => {
  // Wait one tick so any pending async work from the module finishes before
  // we tear down. Without this the next beforeEach can observe a stale
  // `selectedColumn` from the previous render when the module is re-imported.
  await new Promise<void>((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
});

function receivedMsgs(): ReceivedMsg[] {
  return (window as unknown as { __vsdbReceived: ReceivedMsg[] }).__vsdbReceived;
}

function lastSpecChanged(): ReceivedMsg {
  const msgs = receivedMsgs().filter((m) => m.type === "specChanged");
  if (msgs.length === 0) throw new Error("no specChanged emitted");
  return msgs[msgs.length - 1]!;
}

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

function dispatchInit(msg: InitPayload): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

// Dynamic import justified: each test needs a fresh module instance because
// newTableFormMain.ts has module-level state (spec, realTypes, etc.) and runs
// render() + post({type:"ready"}) at import time. Static import would lock
// state for the whole file — tests can't reset cleanly.
async function importModuleFresh(): Promise<void> {
  await import("../../../webview/newTableFormMain");
}

// ============================================================================
// #1 — dropdown has exactly 3 options, varchar default on new column
// ============================================================================
describe("newTableFormMain — Type dropdown + default auto-fill", () => {
  it("#1 dropdown has exactly 3 options, varchar default on new column", async () => {
    await importModuleFresh();
    dispatchInit({
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
    const addBtn = document.getElementById("addColBtn") as HTMLButtonElement;
    addBtn.click();
    const colType = document.getElementById("colType");
    expect(colType).not.toBeNull();
    if (!colType) throw new Error("colType missing");
    expect(colType.tagName).toBe("SELECT");
    const select = colType as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["varchar", "numeric", "boolean"]);
    expect(select.value).toBe("varchar");
  });

  // ==========================================================================
  // #2 — default auto-fill + refresh on type change
  // ==========================================================================
  it("#2 default auto-fill + refresh on type change", async () => {
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "create",
      schema: "public",
      spec: { name: "table_name", schema: "public", columns: [], keys: [] },
    });
    const addBtn = document.getElementById("addColBtn") as HTMLButtonElement;
    addBtn.click();
    const defaultEl = document.getElementById("colDefault") as HTMLInputElement;
    expect(defaultEl.value).toBe("''");
    const typeEl = document.getElementById("colType") as HTMLSelectElement;
    typeEl.value = "numeric";
    typeEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(defaultEl.value).toBe("0");
    typeEl.value = "boolean";
    typeEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(defaultEl.value).toBe("FALSE");
    typeEl.value = "varchar";
    typeEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(defaultEl.value).toBe("''");
    const last = lastSpecChanged();
    expect(last.spec).toBeDefined();
    const cols = last.spec!.columns;
    expect(cols[cols.length - 1]!.default).toBe("''");
  });

  // ==========================================================================
  // #3 — manual default then type change preserves override
  // ==========================================================================
  it("#3 manual default then type change preserves override", async () => {
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "create",
      schema: "public",
      spec: { name: "table_name", schema: "public", columns: [], keys: [] },
    });
    const addBtn = document.getElementById("addColBtn") as HTMLButtonElement;
    addBtn.click();
    const defaultEl = document.getElementById("colDefault") as HTMLInputElement;
    defaultEl.value = "42";
    defaultEl.dispatchEvent(new Event("input", { bubbles: true }));
    const typeEl = document.getElementById("colType") as HTMLSelectElement;
    typeEl.value = "numeric";
    typeEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(defaultEl.value).toBe("42");
  });

  // ==========================================================================
  // #4 — modify-mode: host-loaded column with empty default, dropdown untouched
  // ==========================================================================
  it("#4 modify-mode: host-loaded column with empty default, dropdown untouched", async () => {
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "modify",
      schema: "public",
      originalTableName: "orders",
      spec: {
        name: "orders",
        schema: "public",
        columns: [{ name: "ts", type: "timestamp", default: "" }],
        keys: [],
      },
    });
    const firstLi = document.querySelector('li[data-section="columns"]') as HTMLElement;
    firstLi.click();
    const defaultEl = document.getElementById("colDefault") as HTMLInputElement;
    expect(defaultEl.value).toBe("");
    const typeEl = document.getElementById("colType") as HTMLSelectElement;
    expect(typeEl.value).toBe("varchar");
    const nameEl = document.getElementById("colName") as HTMLInputElement;
    nameEl.value = "ts";
    nameEl.dispatchEvent(new Event("input", { bubbles: true }));
    const last = lastSpecChanged();
    expect(last.spec).toBeDefined();
    expect(last.spec!.columns[0]!.default).toBe("");
    expect(last.spec!.columns[0]!.type).toBe("timestamp");
  });

  // ==========================================================================
  // #5a — exotic real type preservation: timestamp, user only renamed column
  // ==========================================================================
  it("#5a timestamp — user only renamed column → real type preserved", async () => {
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "modify",
      schema: "public",
      originalTableName: "events",
      spec: {
        name: "events",
        schema: "public",
        columns: [{ name: "ts", type: "timestamp", default: "" }],
        keys: [],
      },
    });
    const firstLi = document.querySelector('li[data-section="columns"]') as HTMLElement;
    firstLi.click();
    const nameEl = document.getElementById("colName") as HTMLInputElement;
    nameEl.value = "created_at";
    nameEl.dispatchEvent(new Event("input", { bubbles: true }));
    const last = lastSpecChanged();
    expect(last.spec!.columns[0]!.name).toBe("created_at");
    expect(last.spec!.columns[0]!.type).toBe("timestamp");
  });

  // ==========================================================================
  // #5b — jsonb, dropdown switched to numeric → emit numeric
  // ==========================================================================
  it("#5b jsonb — dropdown switched to numeric (intentional change) → emit numeric", async () => {
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "modify",
      schema: "public",
      originalTableName: "events",
      spec: {
        name: "events",
        schema: "public",
        columns: [{ name: "payload", type: "jsonb" }],
        keys: [],
      },
    });
    const firstLi = document.querySelector('li[data-section="columns"]') as HTMLElement;
    firstLi.click();
    const typeEl = document.getElementById("colType") as HTMLSelectElement;
    typeEl.value = "numeric";
    typeEl.dispatchEvent(new Event("change", { bubbles: true }));
    const last = lastSpecChanged();
    expect(last.spec!.columns[0]!.type).toBe("numeric");
  });

  // ==========================================================================
  // #6 — defaultColumnDefault mapping (pure)
  // ==========================================================================
  it("#6 defaultColumnDefault mapping", async () => {
    const mod = await importModuleFresh();
    // Module side-effects only; we still need the exported helper.
    void mod;
    const helpers = await import("../../../webview/newTableFormColumnHelpers");
    expect(helpers.defaultColumnDefault("varchar")).toBe("''");
    expect(helpers.defaultColumnDefault("numeric")).toBe("0");
    expect(helpers.defaultColumnDefault("boolean")).toBe("FALSE");
    expect(helpers.defaultColumnDefault("timestamp")).toBe("");
    expect(helpers.defaultColumnDefault("")).toBe("");
  });

  // ==========================================================================
  // #7 — mapTypeToForm mapping (pure)
  // ==========================================================================
  it("#7 mapTypeToForm mapping", async () => {
    const mod = await importModuleFresh();
    void mod;
    const helpers = await import("../../../webview/newTableFormColumnHelpers");
    const varcharLike = ["text", "varchar", "char", "uuid", "json", "xml"];
    for (const t of varcharLike) expect(helpers.mapTypeToForm(t)).toBe("varchar");
    const numericLike = [
      "int",
      "serial",
      "decimal",
      "numeric",
      "real",
      "double",
      "float",
      "money",
    ];
    for (const t of numericLike) expect(helpers.mapTypeToForm(t)).toBe("numeric");
    expect(helpers.mapTypeToForm("boolean")).toBe("boolean");
    expect(helpers.mapTypeToForm("bool")).toBe("boolean");
    // Unknown / exotic → varchar fallback
    expect(helpers.mapTypeToForm("timestamp")).toBe("varchar");
    expect(helpers.mapTypeToForm("date")).toBe("varchar");
    expect(helpers.mapTypeToForm("jsonb")).toBe("varchar");
    expect(helpers.mapTypeToForm("_int4")).toBe("varchar");
  });
  it("#8 regression — double dynamic import does not throw on re-init", async () => {
    // R4.5 critical finding: vitest previously leaked listeners across
    // dynamic imports. Force the scenario: re-import the module AFTER
    // dispatching an init message, then dispatch another init and assert
    // (a) no uncaught exception, (b) the new init reaches the live
    // module instance (colType select is rendered for the new columns).
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "create",
      schema: "public",
      spec: { name: "first", schema: "public", columns: [], keys: [] },
    });
    expect(document.getElementById("colType")).toBeNull(); // no selected col yet
    // Re-import: simulate a new test importing the module after the
    // first one's DOM has been torn down. The previous instance's
    // listener must be replaced, not duplicated.
    vi.resetModules();
    document.body.innerHTML = '<div id="vsdb-root" data-vsdb-skip-auto-init="true"></div>';
    const received2: ReceivedMsg[] = [];
    vi.stubGlobal("acquireVsCodeApi", () => ({
      postMessage: (m: unknown) => received2.push(m as ReceivedMsg),
    }));
    (window as unknown as { __vsdbReceived: ReceivedMsg[] }).__vsdbReceived = received2;
    await importModuleFresh();
    dispatchInit({
      type: "init",
      mode: "create",
      schema: "public",
      spec: { name: "second", schema: "public", columns: [], keys: [] },
    });
    // No uncaught exception — the fix replaces the previous listener so
    // the stale instance no longer fires render() against a detached root.
    // This init reaches the live module (whose root is connected) and
    // render() ran successfully — proven by #tableName now existing.
    expect(document.getElementById("tableName")).not.toBeNull();
  });
 });
