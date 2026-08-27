// src/ui/__tests__/consolePanel.test.ts — TASK-003 (cycle Z) host-panel tests.
//
// Covers the ConsolePanel host surface wired in this task:
//   - palette-command path: show() opens exactly one `vsdb.console` webview
//     whose HTML loads dist/consolePanel.js and links the SHARED emitted
//     dist/webview.css via asWebviewUri under the established strict CSP
//     (`style-src ${cspSource} 'unsafe-inline'`) — reviewer finding §3.3.
//   - message routing: every inbound value passes isConsoleToHostMessage
//     BEFORE routing (webview = untrusted runtime input).
//   - save cancellation is a silent no-op; accepted saves write the exact
//     UTF-8 bytes to the chosen URI with a deterministic suggested name.
//   - disposal drops all host state: reopening yields a byte-identical EMPTY
//     html (no prior textarea content survives anywhere host-side).
//
// Pattern mirror: src/ui/__tests__/aiChatPanel.test.ts (vi.mock("vscode"),
// panelHarness capturing the onDidReceiveMessage handler).
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as vscode from "vscode";

interface MockPanel {
  viewType: string;
  webview: {
    html: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const state = vi.hoisted(() => ({
  panels: [] as Array<Record<string, unknown>>,
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn((_viewType: string, _title: string) => {
      const panel: Record<string, unknown> = {
        viewType: _viewType,
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => String(u)),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        // Dispose fires the registered onDidDispose listeners — mirrors how a
        // user closing the tab tears the panel down in production.
        dispose: vi.fn(() => {
          panel["disposed"] = true;
          const listeners = (panel["onDidDispose"] as unknown as {
            mock: { calls: Array<[() => void]> };
          }).mock.calls;
          for (const [cb] of listeners) cb();
        }),
        visible: true,
        disposed: false,
      };
      state.panels.push(panel);
      return panel;
    }),
    showSaveDialog: vi.fn(),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    fs: {
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}`, scheme: "file" }),
    joinPath: vi.fn((u: unknown, ...parts: string[]) => ({
      toString: () => `${String(u)}/${parts.join("/")}`,
      fsPath: [...parts].join("/"),
    })),
  },
  ViewColumn: { Active: 1, Beside: 2 },
  EventEmitter: vi.fn(),
}));

// Import AFTER mocks are registered.
import { ConsolePanel } from "../consolePanel";

const extUri = { toString: () => "/ext", fsPath: "/ext", scheme: "file" } as never;

// ---- helpers ---------------------------------------------------------------

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

function consolePanels(): MockPanel[] {
  return state.panels.filter(
    (p) => (p as { viewType?: string }).viewType === "vsdb.console",
  ) as unknown as MockPanel[];
}

function panelHarness(): { panel: MockPanel; handler: (msg: unknown) => void } {
  const panel = consolePanels()[consolePanels().length - 1];
  return {
    panel,
    handler: (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[(msg: unknown) => void]> };
    }).mock.calls[0][0],
  };
}

beforeEach(() => {
  state.panels.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// #1 — happy: palette command → console panel with consolePanel.js +
//      shared webview.css linked under the established strict CSP.
// ============================================================================
describe("ConsolePanel — open (case 1)", () => {
  it("#1a show() creates a vsdb.console panel whose HTML references consolePanel.js + webview.css stylesheet link under strict CSP", () => {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    const [, title, , options] = (vscode.window.createWebviewPanel as unknown as Mock)
      .mock.calls[0] as unknown as [string, string, unknown, Record<string, unknown>];
    expect(title).toMatch(/Console/i);
    // Established panel options: scripts on, dist local resource root, and
    // hidden-state retention matching every other VSDB form panel.
    expect(options.enableScripts).toBe(true);
    expect(options.retainContextWhenHidden).toBe(true);

    const p = consolePanels()[0];
    const html = p.webview.html;
    // Script asset — dist/consolePanel.js through asWebviewUri.
    expect(html).toContain("/ext/dist/consolePanel.js");
    expect(html).toMatch(/<script src="[^"]*consolePanel\.js"><\/script>/);
    // Stylesheet asset — the SHARED emitted dist/webview.css (planner §Discussion).
    expect(html).toContain("/ext/dist/webview.css");
    expect(html).toMatch(/<link rel="stylesheet" href="[^"]*webview\.css"\s*\/?>/);
    // Established strict CSP — style-src allows the webview source + inline.
    expect(html).toContain(
      `style-src vscode-webview://test 'unsafe-inline'`,
    );
    expect(html).toContain(`script-src vscode-webview://test`);
    expect(html).toContain(`default-src 'none'`);
  });

  it("#1b idempotent reveal while live: second show() reuses the same panel", () => {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();
    panel.show();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    const p = consolePanels()[0];
    expect(p.reveal).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// #2 — happy: runConsole routes the raw buffer to the injected run callback.
// ============================================================================
describe("ConsolePanel — run routing (case 2 host half)", () => {
  it("#2 valid runConsole message reaches the injected onRun callback verbatim", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({ extensionUri: extUri, onRun });
    panel.show();
    const { handler } = panelHarness();
    handler({ type: "runConsole", sql: "SELECT 1; SELECT 2" });
    await until(() => onRun.mock.calls.length > 0);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith("SELECT 1; SELECT 2");
  });
});

// ============================================================================
// #3/#4 — save flow: cancelled is a no-op; accepted writes exact UTF-8 bytes
//         with the TASK-001 suggested filename and SQL-filtered dialog.
// ============================================================================
describe("ConsolePanel — saveAsSql (cases 3-4)", () => {
  const SAVE_SQL = "SELECT 1;\nSELECT 2;\n";
  const FIXED_NOW = new Date(2026, 0, 2, 3, 4, 5);

  function sendSave(): (msg: unknown) => void {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();
    return panelHarness().handler;
  }

  it("#3 cancelled save is a no-op: neither writeFile nor an error notification fires", async () => {
    (vscode.window.showSaveDialog as unknown as Mock).mockResolvedValueOnce(undefined);
    const handler = sendSave();
    handler({ type: "saveConsoleAsSql", sql: SAVE_SQL });
    await until(() =>
      (vscode.window.showSaveDialog as unknown as Mock).mock.calls.length > 0,
    );
    // Let the rejected-write path settle (there is none — must stay idle).
    await until(() => false).catch(() => {});
    await Promise.resolve();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("#4 accepted save: suggested defaultUri console_20260102_030405.sql + SQL filters; exact UTF-8 bytes written to the chosen URI", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const acceptedUri = { fsPath: "/tmp/query.sql", toString: () => "file:///tmp/query.sql" };
    (vscode.window.showSaveDialog as unknown as Mock).mockResolvedValueOnce(acceptedUri);
    const handler = sendSave();
    handler({ type: "saveConsoleAsSql", sql: SAVE_SQL });

    await until(() =>
      (vscode.workspace.fs.writeFile as unknown as Mock).mock.calls.length > 0,
    );
    await until(() => false).catch(() => {});
    await Promise.resolve();

    // Dialog contract: deterministic suggested name + SQL filter set.
    expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(1);
    const [opts] = (vscode.window.showSaveDialog as unknown as Mock).mock
      .calls[0] as unknown as [
      { defaultUri: { fsPath: string }; filters: Record<string, string[]> },
    ];
    expect(opts.defaultUri.fsPath).toBe("console_20260102_030405.sql");
    expect(opts.filters).toEqual({ SQL: ["sql"], "All Files": ["*"] });

    // Write contract: the SOURCE SQL's UTF-8 bytes, nothing else.
    const expectedBytes = new TextEncoder().encode(SAVE_SQL);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      acceptedUri,
      expectedBytes,
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #5 — edge-lifecycle: disposal drops ALL console state.
// ============================================================================
describe("ConsolePanel — disposal (case 5)", () => {
  it("#5 after disposal, show() opens a FRESH panel; the new HTML carries no prior buffer and host fields hold nothing", async () => {
    const onDispose = vi.fn();
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      onDispose,
    });
    panel.show();
    const first = consolePanels()[0];
    const { handler } = panelHarness();
    const priorSql = "SELECT secret_one;\nSELECT secret_two;";
    handler({ type: "runConsole", sql: priorSql });
    await until(() => onRun.mock.calls.length > 0);

    // User closes the tab → onDidDispose fires → teardown.
    first.dispose();
    expect(first.disposed).toBe(true);
    // Extension-facing teardown hook fired so the host drops its singleton.
    expect(onDispose).toHaveBeenCalledTimes(1);

    // Reopen: a SECOND panel is created.
    panel.show();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
    const reopened = consolePanels()[1];
    expect(reopened).not.toBe(first);
    // The fresh HTML is byte-identical to the initial empty one — no prior
    // textarea content was baked in or replayed.
    expect(reopened.webview.html).toBe(first.webview.html);
    expect(reopened.webview.html).not.toContain("secret_one");
    expect(reopened.webview.html).not.toContain("secret_two");
    // The old panel stays dead.
    expect(first.reveal).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #6 — regression-security: malformed webview messages do nothing.
// ============================================================================
describe("ConsolePanel — malformed message guard (case 6)", () => {
  it("#6 null, primitives, and unknown types invoke neither onRun nor the save dialog", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({ extensionUri: extUri, onRun });
    panel.show();
    const { handler } = panelHarness();

    expect(() => handler(null)).not.toThrow();
    expect(() => handler(undefined)).not.toThrow();
    expect(() => handler("runConsole")).not.toThrow();
    expect(() => handler(42)).not.toThrow();
    expect(() => handler({ type: "unknownType", sql: "DROP TABLE x" })).not.toThrow();
    expect(() => handler({ type: "runConsole", sql: 123 })).not.toThrow();
    expect(() => handler({ type: "saveConsoleAsSql" })).not.toThrow();

    await until(() => false).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(onRun).not.toHaveBeenCalled();
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});
