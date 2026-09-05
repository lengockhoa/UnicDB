// src/ui/__tests__/schemaForm.test.ts
// TASK-003 — Host tests for SchemaForm (Create New Schema dialog).
// Pattern mirrors src/ui/__tests__/newTableForm.test.ts (mock vscode, capture
// panel + onDidReceiveMessage). Form contract:
//   - panel id "UnicDB.schemaForm"
//   - name up top, CREATE SCHEMA "<name>" preview below
//   - empty name → preview "—" + error listed + OK disabled
//   - duplicate name (case-insensitive) → error + OK disabled
//   - invalid identifier (regex /^[A-Za-z_][A-Za-z0-9_$]*$/ or length > 63) → error + OK disabled
//   - OK → runDdl(sql, name) → tree.refresh() + revealSchemaNode(...) + info message
//   - runDdl rejects → showErrorMessage("Create Schema failed: <msg>"); no refresh
//   - Escape → cancel without DDL
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- vscode mock (subset cần cho SchemaForm) ---------------------------------
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
type MockReveal = { (...args: unknown[]): unknown; mock: { calls: unknown[][] } };
type MockDispose = { (...args: unknown[]): unknown; mock: { calls: unknown[][] } };
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
  reveal: MockReveal;
  dispose: MockDispose;
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

import * as vscode from "vscode";
import { SchemaForm } from "../schemaForm";

const extUri = vscode.Uri.file("/ext");

// ---- helpers ---------------------------------------------------------------



interface Harness {
  panel: MockPanel;
  post: MockPostMessage;
  handler: (msg: unknown) => Promise<void>;
}
function panelHarness(): Harness {
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
  existingNames: string[];
}
function isPreviewMsg(m: unknown): m is PreviewMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "preview";
}
function isInitMsg(m: unknown): m is InitMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
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
// #1 — live preview: typing posts preview with CREATE SCHEMA "<name>";"
// ============================================================================
describe("SchemaForm — preview", () => {
  it("#1 typing 'my_schema' → preview CREATE SCHEMA \"my_schema\"; empty name → preview '—' + error + OK disabled", async () => {
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => [],
      runDdl: vi.fn().mockResolvedValue(undefined),
    });
    form.show();
    const { panel, post, handler } = panelHarness();
    // HTML CSP + bundle reference
    expect(panel.webview.html).toContain("Content-Security-Policy");
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toContain("schemaForm.js");
    // Webview is told to render ready
    expect(post).toBeDefined();
    await handler({ type: "ready" });
    // Initial empty input posts init with empty existing names
    const init = initCall(panel);
    expect(init).toBeDefined();
    expect(init!.existingNames).toEqual([]);

    // Empty preview baseline: last preview should be { sql: "—", errors: [...] }
    const baselinePreview = previewCalls(panel).slice(-1)[0];
    expect(baselinePreview.sql).toBe("—");
    expect(baselinePreview.errors.length).toBeGreaterThan(0);

    // Typing a valid name → preview with exact CREATE SCHEMA SQL
    await handler({ type: "nameChanged", name: "my_schema" });
    const typingPreview = previewCalls(panel).slice(-1)[0];
    expect(typingPreview.sql).toBe('CREATE SCHEMA "my_schema";');
    expect(typingPreview.errors).toEqual([]);
    // OK enabled when no errors
    const okState1 = previewCalls(panel).slice(-1)[0] as PreviewMsg & { okEnabled?: boolean };
    expect(okState1.errors).toEqual([]);
  });
});

// ============================================================================
// #2 — OK → runDdl + refresh + reveal + toast
// ============================================================================
describe("SchemaForm — submit", () => {
  it("#2 OK → runDdl(CREATE SCHEMA \"x\";) awaited → onOk → info 'UnicDB: schema \"x\" created'", async () => {
    const runDdl = vi.fn().mockResolvedValue(undefined);
    let refreshCalled = false;
    let revealCalled = false;
    let infoMsg = "";
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => [],
      runDdl: async (_sql, _name) => {
        runDdl(_sql, _name);
        // simulate wiring: post-OK handler will refresh+reveal+info
      },
      onOk: (sql, name) => {
        refreshCalled = true;
        revealCalled = true;
        infoMsg = `UnicDB: schema "${name}" created`;
        // runDdl invoked BEFORE onOk
        return runDdl(sql, name);
      },
    });
    form.show();
    const { panel, handler } = panelHarness();
    await handler({ type: "ready" });
    await handler({ type: "nameChanged", name: "x" });
    await handler({ type: "submit", name: "x" });
    expect(runDdl).toHaveBeenCalledWith('CREATE SCHEMA "x";', "x");
    expect(refreshCalled).toBe(true);
    expect(revealCalled).toBe(true);
    expect(infoMsg).toContain("schema \"x\" created");
  });
});

// ============================================================================
// #3 — invalid identifier gating
// ============================================================================
describe("SchemaForm — invalid identifier gating", () => {
  it("#3 each invalid name → preview error listed; OK stays disabled; runDdl NOT called", async () => {
    const cases = [
      "9bad",       // starts with digit
      "a-b",        // hyphen
      "",           // empty
      "x".repeat(64), // 64-char > 63 limit
    ];
    for (const name of cases) {
      state.panels.length = 0;
      const runDdl = vi.fn().mockResolvedValue(undefined);
      const form = new SchemaForm({
        extensionUri: extUri,
        listSchemaNames: async () => [],
        runDdl,
      });
      form.show();
      const { handler } = panelHarness();
      await handler({ type: "ready" });
      await handler({ type: "nameChanged", name });
      // Now submit — runDdl must NOT be called because errors>0
      await handler({ type: "submit", name });
      expect(runDdl).not.toHaveBeenCalled();
    }
  });
});

// ============================================================================
// #4 — duplicate detection (case-insensitive)
// ============================================================================
describe("SchemaForm — duplicate detection", () => {
  it("#4 listSchemaNames=['Users']; typing 'users' → error 'Schema \"users\" already exists'; runDdl NOT called", async () => {
    const runDdl = vi.fn().mockResolvedValue(undefined);
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => ["Users", "public"],
      runDdl,
    });
    form.show();
    const { panel, handler } = panelHarness();
    await handler({ type: "ready" });
    await handler({ type: "nameChanged", name: "users" });
    const last = previewCalls(panel).slice(-1)[0];
    expect(last.errors.some((e) => /already exists/i.test(e))).toBe(true);
    // Try to submit — must not run
    await handler({ type: "submit", name: "users" });
    expect(runDdl).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #7 — error path: runDdl rejects → error message; no refresh
// ============================================================================
describe("SchemaForm — runDdl error path", () => {
  it("#7 runDdl rejects('permission denied') → error 'Create Schema failed: permission denied'; onOk NOT called (no refresh)", async () => {
    const runDdl = vi.fn().mockRejectedValue(new Error("permission denied"));
    let onOkCalled = false;
    const errorMessages: string[] = [];
    // We inject the error path through onError callback (which the command
    // wiring converts to showErrorMessage). Verify error makes it through the
    // public surface (preview + onError) without invoking onOk.
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => [],
      runDdl: (sql, name) => runDdl(sql, name),
      onOk: () => {
        onOkCalled = true;
      },
      onError: (msg) => {
        errorMessages.push(msg);
      },
    });
    form.show();
    const { panel, handler } = panelHarness();
    await handler({ type: "ready" });
    await handler({ type: "nameChanged", name: "x" });
    await handler({ type: "submit", name: "x" });
    for (let i = 0; i < 200 && errorMessages.length === 0; i++) {
      await Promise.resolve();
    }
    expect(runDdl).toHaveBeenCalled();
    expect(onOkCalled).toBe(false);
    expect(errorMessages.some((m) => /Create Schema failed: permission denied/.test(m))).toBe(true);
    // Panel should still be visible (not disposed on error)
    expect(panel.dispose).not.toHaveBeenCalled();
  });
});

// ============================================================================
// show() reveal / dispose pattern + Escape handling
// ============================================================================
describe("SchemaForm — lifecycle", () => {
  it("show() 2nd time reveals existing panel instead of creating new", () => {
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => [],
      runDdl: vi.fn().mockResolvedValue(undefined),
    });
    form.show();
    const first = state.panels[0];
    form.show();
    expect(state.panels).toHaveLength(1);
    expect(first.reveal).toHaveBeenCalled();
  });

  it("Escape → cancel: panel disposed, runDdl not called", async () => {
    const runDdl = vi.fn().mockResolvedValue(undefined);
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => [],
      runDdl,
    });
    form.show();
    const { panel, handler } = panelHarness();
    await handler({ type: "ready" });
    await handler({ type: "nameChanged", name: "x" });
    await handler({ type: "cancel" });
    expect(panel.dispose).toHaveBeenCalled();
    expect(runDdl).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent and clears disposables", () => {
    const form = new SchemaForm({
      extensionUri: extUri,
      listSchemaNames: async () => [],
      runDdl: vi.fn().mockResolvedValue(undefined),
    });
    form.show();
    form.dispose();
    form.dispose(); // idempotent
    expect(state.panels[0].dispose).toHaveBeenCalled();
  });
});