// src/ui/__tests__/newTableForm.test.ts
// TASK-004 — Host tests cho NewTableForm (DataGrip-style designer dialog).
// Pattern mirror src/ui/__tests__/connectionForm.test.ts (mock vscode, capture
// panel + onDidReceiveMessage). Host uses TASK-001/003 pure fns để compute
// preview; tests assert host contract chứ không assert nội dung SQL của fn
// thuần (đã cover ở TASK-001/003).
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { NewTableForm } from "../newTableForm";
import type { TableSpec } from "../../core/ddl/createTable";
import {
  defaultColumnSpecs,
  generateCreateTable,
  specErrors,
  UUID_DEFAULT_EXPR,
  CREATED_AT_DEFAULT_EXPR,
} from "../../core/ddl/createTable";
import { diffTable } from "../../core/ddl/alterTable";

// ---- vscode mock (subset cần cho NewTableForm) ------------------------------
type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const l of this.listeners.slice()) l(data);
  }
}
interface MockPostMessage {
  mock: { calls: Array<[unknown]> };
}
interface MockOnDidReceiveMessage {
  mock: { calls: Array<[Listener<unknown>]> };
}
interface MockPanel {
  webview: {
    html: string;
    postMessage: MockPostMessage;
    onDidReceiveMessage: MockOnDidReceiveMessage;
    asWebviewUri: (u: unknown) => unknown;
    cspSource: string;
  };
  onDidDispose: (cb: () => void) => { dispose: () => void };
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  visible: boolean;
}
const state = vi.hoisted(() => ({
  panels: [] as MockPanel[],
}));
vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel: MockPanel = {
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined) as unknown as MockPostMessage,
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })) as unknown as MockOnDidReceiveMessage,
          asWebviewUri: vi.fn((u: unknown) => u),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(),
        visible: true,
      };
      state.panels.push(panel);
      return panel;
    }),
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

const extUri = vscode.Uri.file("/ext");

// ---- helpers ---------------------------------------------------------------

/** Flush async handleMessage cho tới khi condition true (deterministic polling). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

/** Lấy postMessage mock + message handler t� panel vừa show(). */
function panelHarness(): {
  panel: MockPanel;
  post: MockPostMessage;
  handler: (msg: unknown) => void;
} {
  const panel = state.panels[state.panels.length - 1];
  return {
    panel,
    post: panel.webview.postMessage,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0][0],
  };
}

function postCalls(panel: MockPanel): unknown[] {
  return panel.webview.postMessage.mock.calls.map((c) => c[0]);
}

interface PreviewMsg {
  type: "preview";
  sql: string;
  errors: string[];
}
interface InitMsg {
  type: "init";
  mode: "create" | "modify";
  schema: string;
  originalTableName?: string;
  spec: TableSpec;
  loadError?: string;
}
function isPreviewMsg(m: unknown): m is PreviewMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "preview";
}
function isInitMsg(m: unknown): m is InitMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function lastPost<T>(panel: MockPanel): T {
  const calls = postCalls(panel);
  return calls[calls.length - 1] as T;
}
function previewCalls(panel: MockPanel): PreviewMsg[] {
  return postCalls(panel).filter(isPreviewMsg);
}
function initCall(panel: MockPanel): InitMsg | undefined {
  return postCalls(panel).find(isInitMsg);
}

beforeEach(() => {
  state.panels.length = 0;
});

// ============================================================================
// #1 — create init + preview exact
// ============================================================================
describe("NewTableForm — create mode", () => {
  it("#1 init + preview exact: ready → init default spec; rename → TASK-001 canonical SQL", async () => {
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "create",
      schema: "public",
      runDdl: vi.fn().mockResolvedValue(undefined),
    });
    form.show();
    const { panel, post, handler } = panelHarness();
    expect(panel.webview.html).toContain("Content-Security-Policy");
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toContain("newTableForm.js");
    // ready → init with defaultColumnSpecs("table_name") (table_name is the
    // host-side initial name; spec schema mirrors host option).
    handler({ type: "ready" });
    await until(() => post.mock.calls.length > 0);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "init",
        mode: "create",
        schema: "public",
        spec: expect.objectContaining({
          name: "table_name",
          schema: "public",
          columns: defaultColumnSpecs("table_name"),
          keys: [],
        }),
      }),
    );
    // specChanged: user renamed table to "users"
    const renamed: TableSpec = {
      name: "users",
      schema: "public",
      columns: defaultColumnSpecs("users"),
      keys: [],
    };
    handler({ type: "specChanged", spec: renamed });
    // Compute expected SQL via the same pure fn the host uses.
    const expected = generateCreateTable(renamed);
    expect(expected).toBe(
      'CREATE TABLE "public"."users" (\n' +
        `    "id_users" varchar DEFAULT ${UUID_DEFAULT_EXPR},\n` +
        `    "created_at" varchar DEFAULT ${CREATED_AT_DEFAULT_EXPR}\n` +
        ");\n",
    );
    // Wait until host posts preview after specChanged.
    await until(() => previewCalls(panel).length > 0);
    expect(post).toHaveBeenCalledWith({
      type: "preview",
      sql: expected,
      errors: [],
    });
    form.dispose();
  });
});

// ============================================================================
// #2 — modify loadSpec + diff preview
// ============================================================================
describe("NewTableForm — modify mode", () => {
  it("#2 loadSpec + diff preview: introspected spec + renamed col → diffTable statements joined", async () => {
    // loadSpec contract: returns the BEFORE spec (as introspected).
    const before: TableSpec = {
      name: "users",
      schema: "public",
      columns: [
        { name: "id", type: "bigint" },
        { name: "name", type: "varchar" },
      ],
      keys: [],
    };
    const loadSpec = vi.fn().mockResolvedValue(before);
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "modify",
      schema: "public",
      originalTableName: "users",
      loadSpec,
      runDdl: vi.fn().mockResolvedValue(undefined),
    });
    form.show();
    const { post, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => !!initCall(panelHarness().panel));
    const initMsg = initCall(panelHarness().panel);
    expect(initMsg?.mode).toBe("modify");
    expect(initMsg?.schema).toBe("public");
    expect(initMsg?.originalTableName).toBe("users");
    expect(initMsg?.loadError).toBeUndefined();
    expect(initMsg?.spec).toEqual(before);
    expect(loadSpec).toHaveBeenCalledTimes(1);

    // User renames "id" → "user_id" via edit (sets originalName on renamed col).
    const after: TableSpec = {
      ...before,
      columns: [
        { name: "user_id", type: "bigint", originalName: "id" },
        { name: "name", type: "varchar" },
      ],
    };
    handler({ type: "specChanged", spec: after });
    await until(() => previewCalls(panelHarness().panel).length > 0);
    const expectedSql = diffTable(before, after).statements.join("\n");
    expect(expectedSql).toContain('RENAME COLUMN "id" TO "user_id"');
    expect(post).toHaveBeenCalledWith({
      type: "preview",
      sql: expectedSql,
      errors: [],
    });
    form.dispose();
  });
});

// ============================================================================
// #3 — submit → runDdl(lastPreviewSql) + dispose
// ============================================================================
describe("NewTableForm — submit / cancel / errors", () => {
  it("#3 submit → runDdl called ONCE with the last previewed sql + panel disposed", async () => {
    const runDdl = vi.fn().mockResolvedValue(undefined);
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "create",
      schema: "public",
      runDdl,
    });
    form.show();
    const { panel, post, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => previewCalls(panel).length > 0);
    // specChanged with valid spec → host posts preview.
    const spec: TableSpec = {
      name: "users",
      schema: "public",
      columns: defaultColumnSpecs("users"),
      keys: [],
    };
    handler({ type: "specChanged", spec });
    await until(() =>
      previewCalls(panel).some((p) => p.sql.includes('"users"')),
    );
    const previewSql = generateCreateTable(spec);
    handler({ type: "submit", spec });
    await until(() => runDdl.mock.calls.length > 0);
    expect(runDdl).toHaveBeenCalledTimes(1);
    expect(runDdl).toHaveBeenCalledWith(previewSql, spec);
    await until(() => panel.dispose.mock.calls.length > 0);
    expect(panel.dispose).toHaveBeenCalled();
    form.dispose();
  });

  // #4 — failure path
  it("#4 runDdl rejects → NOT disposed, posts preview with errors containing message", async () => {
    const runDdl = vi.fn().mockRejectedValue(new Error("relation exists"));
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "create",
      schema: "public",
      runDdl,
    });
    form.show();
    const { panel, post, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => previewCalls(panel).length > 0);
    const spec: TableSpec = {
      name: "users",
      schema: "public",
      columns: defaultColumnSpecs("users"),
      keys: [],
    };
    handler({ type: "specChanged", spec });
    await until(() => previewCalls(panel).length >= 2);
    handler({ type: "submit", spec });
    // Wait for the rejection to be reported as preview error.
    await until(() =>
      previewCalls(panel).some((p) => p.errors.some((e) => e.includes("relation exists"))),
    );
    expect(panel.dispose).not.toHaveBeenCalled();
    const lastPreview = lastPost<PreviewMsg>(panel);
    expect(lastPreview.type).toBe("preview");
    expect(lastPreview.sql).toBe("");
    expect(lastPreview.errors.some((e) => e.includes("relation exists"))).toBe(true);
    form.dispose();
  });

  // #5 — invalid spec → errors + sql "" + submit no-op
  it("#5 invalid spec: specChanged with duplicate columns → errors, sql '', submit does NOT call runDdl", async () => {
    const runDdl = vi.fn().mockResolvedValue(undefined);
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "create",
      schema: "public",
      runDdl,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => previewCalls(panel).length > 0);
    const dupSpec: TableSpec = {
      name: "users",
      schema: "public",
      columns: [
        { name: "id", type: "bigint" },
        { name: "id", type: "varchar" },
        { name: "id", type: "text" },
      ],
      keys: [],
    };
    handler({ type: "specChanged", spec: dupSpec });
    await until(() => previewCalls(panel).length >= 2);
    const expectedErrors = specErrors(dupSpec);
    expect(expectedErrors.length).toBeGreaterThanOrEqual(2);
    const lastPreview = lastPost<PreviewMsg>(panel);
    expect(lastPreview.sql).toBe("");
    expect(lastPreview.errors.length).toBe(expectedErrors.length);
    handler({ type: "submit", spec: dupSpec });
    await Promise.resolve();
    await Promise.resolve();
    expect(runDdl).not.toHaveBeenCalled();
    form.dispose();
  });

  // #6 — cancel
  it("#6 cancel → disposed, runDdl 0 calls", async () => {
    const runDdl = vi.fn();
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "create",
      schema: "public",
      runDdl,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "cancel" });
    await until(() => panel.dispose.mock.calls.length > 0);
    expect(panel.dispose).toHaveBeenCalled();
    expect(runDdl).not.toHaveBeenCalled();
    form.dispose();
  });

  // #7 — loadSpec rejects → init carries loadError + later specChanged still answers
  it("#7 loadSpec rejects → init has loadError + empty spec; later specChanged still answers", async () => {
    const loadSpec = vi.fn().mockRejectedValue(new Error("introspect failed"));
    const runDdl = vi.fn().mockResolvedValue(undefined);
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "modify",
      schema: "public",
      originalTableName: "users",
      loadSpec,
      runDdl,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => !!initCall(panel));
    const initMsg = initCall(panel);
    expect(initMsg?.spec.name).toBe("users");
    expect(initMsg?.spec.schema).toBe("public");
    expect(initMsg?.spec.columns).toEqual([]);
    expect(initMsg?.spec.keys).toEqual([]);
    expect(initMsg?.loadError).toBe("introspect failed");
    // Even after loadError, host must still answer specChanged with preview.
    const spec: TableSpec = {
      name: "users",
      schema: "public",
      columns: defaultColumnSpecs("users"),
      keys: [],
    };
    handler({ type: "specChanged", spec });
    await until(() => previewCalls(panel).length > 0);
    form.dispose();
  });
});

// ============================================================================
// show() reveal / dispose pattern
// ============================================================================
describe("NewTableForm — lifecycle", () => {
  it("show() twice → reveal() (not creating second panel)", () => {
    const form = new NewTableForm({
      extensionUri: extUri,
      mode: "create",
      schema: "public",
      runDdl: vi.fn(),
    });
    form.show();
    form.show();
    expect(state.panels).toHaveLength(1);
    const panel = state.panels[0];
    expect(panel.reveal).toHaveBeenCalled();
    form.dispose();
  });
});
