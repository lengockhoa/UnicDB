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
// ARP-08 TASK-ARP08-002 — draft codec + constants (pure module, no vscode).
import {
  CONSOLE_DRAFTS_KEY,
  CONSOLE_DRAFTS_MAX_BUFFER_CHARS,
  CONSOLE_DRAFTS_MAX_NAME_CHARS,
  CONSOLE_DRAFTS_MAX_TABS,
  CONSOLE_DRAFT_SNAPSHOT_VERSION,
  encodeConsoleDraftSnapshot,
  parseConsoleDraftSnapshot,
} from "../consolePanelMessages";

const extUri = { toString: () => "/ext", fsPath: "/ext", scheme: "file" } as never;

// ARP-08 TASK-ARP08-002 — local Memento double for draft persistence tests.
// Copied verbatim from src/ui/__tests__/consoleTabs.test.ts:21-29 (test files
// must not import across each other). `update(key, undefined)` drops the key
// so `get` returns undefined — mirrors real vscode.Memento semantics.
class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

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

// ============================================================================
// AIC-004 — Console ghost-text autocomplete host seam
// ============================================================================
describe("ConsolePanel — AIC-004 ghost-text host seam", () => {
  it("routes a requestAutocomplete message to onAutocomplete with the right args", async () => {
    const onAutocomplete = vi.fn().mockResolvedValue("ers");
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: vi.fn(),
      onAutocomplete,
    });
    panel.show();
    const { handler } = panelHarness();
    handler({
      type: "requestAutocomplete",
      tabId: panel.getActiveTabId(),
      requestId: "req-1",
      cursorOffset: 16,
      documentText: "SELECT * FROM us",
    });
    await until(() => onAutocomplete.mock.calls.length > 0);
    expect(onAutocomplete).toHaveBeenCalledTimes(1);
    const [req] = onAutocomplete.mock.calls[0] as [
      { tabId: string; requestId: string; cursorOffset: number; documentText: string; schemaFingerprint: string; signal: AbortSignal },
    ];
    expect(req.tabId).toBe(panel.getActiveTabId());
    expect(req.requestId).toBe("req-1");
    expect(req.cursorOffset).toBe(16);
    expect(req.documentText).toBe("SELECT * FROM us");
    expect(req.schemaFingerprint).toBe("v1");
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it("posts autocompleteResult with the resolved suffix back to the webview", async () => {
    const onAutocomplete = vi.fn().mockResolvedValue("ers");
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: vi.fn(),
      onAutocomplete,
    });
    panel.show();
    const p = consolePanels()[0];
    const { handler } = panelHarness();
    handler({
      type: "requestAutocomplete",
      tabId: panel.getActiveTabId(),
      requestId: "req-1",
      cursorOffset: 16,
      documentText: "SELECT * FROM us",
    });
    await until(() => p.webview.postMessage.mock.calls.some((c: unknown[]) => {
      const m = c[0] as { type?: string };
      return m?.type === "autocompleteResult";
    }));
    const sentMessages = p.webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const result = sentMessages.find((m) => (m as { type?: string }).type === "autocompleteResult") as { tabId: string; requestId: string; suffix: string | null } | undefined;
    expect(result).toBeDefined();
    expect(result!.suffix).toBe("ers");
    expect(result!.requestId).toBe("req-1");
    expect(result!.tabId).toBe(panel.getActiveTabId());
  });

  it("posts autocompleteResult with suffix=null when the callback resolves null", async () => {
    const onAutocomplete = vi.fn().mockResolvedValue(null);
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: vi.fn(),
      onAutocomplete,
    });
    panel.show();
    const p = consolePanels()[0];
    const { handler } = panelHarness();
    handler({
      type: "requestAutocomplete",
      tabId: panel.getActiveTabId(),
      requestId: "req-1",
      cursorOffset: 0,
      documentText: "SELECT 1",
    });
    await until(() => p.webview.postMessage.mock.calls.some((c: unknown[]) => {
      const m = c[0] as { type?: string };
      return m?.type === "autocompleteResult";
    }));
    const result = p.webview.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .find((m) => (m as { type?: string }).type === "autocompleteResult") as { suffix: string | null } | undefined;
    expect(result?.suffix).toBeNull();
  });

  it("a new requestAutocomplete on the same tab supersedes the previous one (requestId guard)", async () => {
    let resolveFirst: (v: string) => void = () => {};
    const firstPromise = new Promise<string>((r) => { resolveFirst = r; });
    let secondSeen = false;
    const onAutocomplete = vi.fn().mockImplementation((req: { requestId: string }) => {
      if (req.requestId === "req-1") return firstPromise;
      secondSeen = true;
      return Promise.resolve("second");
    });
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: vi.fn(),
      onAutocomplete,
    });
    panel.show();
    const p = consolePanels()[0];
    const { handler } = panelHarness();
    const tab1 = panel.getActiveTabId();
    handler({
      type: "requestAutocomplete",
      tabId: tab1,
      requestId: "req-1",
      cursorOffset: 16,
      documentText: "SELECT * FROM us",
    });
    // Fire a NEW request while the first is still pending.
    handler({
      type: "requestAutocomplete",
      tabId: tab1,
      requestId: "req-2",
      cursorOffset: 17,
      documentText: "SELECT * FROM use",
    });
    // Resolve the FIRST (now stale) request — must NOT post a result.
    resolveFirst("STALE");
    await new Promise((r) => setTimeout(r, 5));
    // Now the SECOND request's result lands.
    await until(() => p.webview.postMessage.mock.calls.some((c: unknown[]) => {
      const m = c[0] as { type?: string };
      return m?.type === "autocompleteResult";
    }));
    const resultMsgs = p.webview.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((m) => (m as { type?: string }).type === "autocompleteResult") as Array<{ requestId: string; suffix: string | null }>;
    // Only one result posted, and it's for the second (current) request.
    expect(resultMsgs).toHaveLength(1);
    expect(resultMsgs[0].requestId).toBe("req-2");
    expect(resultMsgs[0].suffix).toBe("second");
    expect(secondSeen).toBe(true);
  });
  it("clearAutocomplete cancels in-flight requests for the given tab", async () => {
    let aborted = false;
    const onAutocomplete = vi.fn().mockImplementation((req: { signal: AbortSignal }) => {
      req.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>(() => { /* never resolves */ });
    });
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: vi.fn(),
      onAutocomplete,
    });
    panel.show();
    const { handler } = panelHarness();
    const tab1 = panel.getActiveTabId();
    handler({
      type: "requestAutocomplete",
      tabId: tab1,
      requestId: "req-1",
      cursorOffset: 16,
      documentText: "SELECT * FROM us",
    });
    await until(() => onAutocomplete.mock.calls.length > 0);
    handler({ type: "clearAutocomplete", tabId: tab1 });
    await until(() => aborted);
    expect(aborted).toBe(true);
  });

  it("acceptAutocomplete writes the suffix atomically into the tab buffer", async () => {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();
    const { handler } = panelHarness();
    const tab1 = panel.getActiveTabId();
    panel.setBuffer(tab1, "SELECT * FROM us");
    handler({
      type: "acceptAutocomplete",
      tabId: tab1,
      requestId: "req-1",
      suffix: "ers",
    });
    await until(() => panel.getBuffer(tab1) === "SELECT * FROM users");
    expect(panel.getBuffer(tab1)).toBe("SELECT * FROM users");
  });

  it("acceptAutocomplete is a no-op on unknown tabId", async () => {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();
    const { handler } = panelHarness();
    expect(() =>
      handler({
        type: "acceptAutocomplete",
        tabId: "tab-does-not-exist",
        requestId: "req-1",
        suffix: "x",
      }),
    ).not.toThrow();
  });

  it("disposal cancels all in-flight autocomplete requests for every tab", async () => {
    let aborted = false;
    const onAutocomplete = vi.fn().mockImplementation((req: { signal: AbortSignal }) => {
      req.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>(() => {});
    });
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: vi.fn(),
      onAutocomplete,
    });
    panel.show();
    const p = consolePanels()[0];
    const { handler } = panelHarness();
    const tab1 = panel.getActiveTabId();
    handler({
      type: "requestAutocomplete",
      tabId: tab1,
      requestId: "req-1",
      cursorOffset: 0,
      documentText: "SELECT 1",
    });
    await until(() => onAutocomplete.mock.calls.length > 0);
    p.dispose();
    await until(() => aborted);
    expect(aborted).toBe(true);
  });
});

// ============================================================================
// ARP-08 TASK-ARP08-002 — host draft restore: hydrate, debounced persist,
// dispose flush, durable clear. Debounce/flush tests use fake timers; the
// `until()` helper is NEVER used under vi.useFakeTimers (real setTimeout
// would deadlock).
// ============================================================================
describe("ConsolePanel — draft recovery (ARP-08)", () => {
  /** Seed a memento directly with an encoded snapshot (reopen scenarios). */
  function seedDrafts(memento: FakeMemento, snapshot: {
    version: number;
    tabs: Array<{ id: string; name: string; buffer: string }>;
    activeTabId: string;
  }): void {
    memento.update(
      CONSOLE_DRAFTS_KEY,
      encodeConsoleDraftSnapshot(snapshot as never),
    );
  }

  /** Construct + show a panel over the given memento. */
  function openPanel(memento?: FakeMemento, extra?: { onRun?: ReturnType<typeof vi.fn> }) {
    const onRun = extra?.onRun ?? vi.fn();
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun: onRun as never,
      ...(memento ? { draftMemento: memento as never } : {}),
    });
    panel.show();
    return { panel, onRun, handler: panelHarness().handler };
  }

  it("#1 happy: updateBuffer persists a debounced draft snapshot to the memento after 500ms", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const { panel, handler } = openPanel(memento);
    const tabId = panel.getActiveTabId();

    handler({ type: "updateBuffer", tabId, buffer: "SELECT 1" });
    expect(memento.get<string>(CONSOLE_DRAFTS_KEY)).toBeUndefined();
    vi.advanceTimersByTime(500);

    const raw = memento.get<string>(CONSOLE_DRAFTS_KEY);
    expect(typeof raw).toBe("string");
    const snap = parseConsoleDraftSnapshot(raw!);
    expect(snap).not.toBeNull();
    expect(snap!.tabs).toHaveLength(1);
    expect(snap!.tabs[0].buffer).toBe("SELECT 1");
  });

  it("#2 happy: a second panel over the SAME memento (reopen) restores tabs + active id", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const first = openPanel(memento);
    first.handler({ type: "updateBuffer", tabId: first.panel.getActiveTabId(), buffer: "SELECT a FROM t" });
    first.handler({ type: "createTab", name: "Migration" });
    const tab2Id = first.panel.getActiveTabId();
    first.handler({ type: "updateBuffer", tabId: tab2Id, buffer: "SELECT b FROM u" });
    first.handler({ type: "switchTab", tabId: first.panel.listTabs()[0].id });
    vi.advanceTimersByTime(500);

    // Reopen: SECOND panel over the SAME memento restores identically.
    const second = openPanel(memento);
    const firstTabs = first.panel.listTabs();
    const restored = second.panel.listTabs();
    expect(restored).toEqual(firstTabs);
    expect(second.panel.getActiveTabId()).toBe(first.panel.getActiveTabId());
  });

  it("#3 edge/corrupt: garbage memento → constructor does not throw, falls back to one empty 'Query 1'", () => {
    const memento = new FakeMemento();
    memento.update(CONSOLE_DRAFTS_KEY, "###not-json###");
    expect(() => openPanel(memento)).not.toThrow();
    const { panel } = openPanel(memento);
    const tabs = panel.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe("Query 1");
    expect(tabs[0].buffer).toBe("");
  });

  it("#4 edge: 1-tab and 2-tab (active=tab2) snapshots both restore verbatim on reopen", () => {
    const memento1 = new FakeMemento();
    seedDrafts(memento1, {
      version: CONSOLE_DRAFT_SNAPSHOT_VERSION,
      tabs: [{ id: "solo", name: "Solo", buffer: "SELECT 42" }],
      activeTabId: "solo",
    });
    const solo = openPanel(memento1).panel;
    expect(solo.listTabs()).toEqual([{ id: "solo", name: "Solo", buffer: "SELECT 42" }]);
    expect(solo.getActiveTabId()).toBe("solo");

    const memento2 = new FakeMemento();
    seedDrafts(memento2, {
      version: CONSOLE_DRAFT_SNAPSHOT_VERSION,
      tabs: [
        { id: "t1", name: "Query 1", buffer: "SELECT 1" },
        { id: "t2", name: "Query 2", buffer: "SELECT 2" },
      ],
      activeTabId: "t2",
    });
    const duo = openPanel(memento2).panel;
    expect(duo.listTabs().map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(duo.listTabs().map((t) => t.buffer)).toEqual(["SELECT 1", "SELECT 2"]);
    expect(duo.getActiveTabId()).toBe("t2");
  });

  it("#5 edge/never-runs: restore path invokes the onRun spy ZERO times", () => {
    const onRun = vi.fn();
    const memento = new FakeMemento();
    seedDrafts(memento, {
      version: CONSOLE_DRAFT_SNAPSHOT_VERSION,
      tabs: [
        { id: "t1", name: "Query 1", buffer: "DELETE FROM users" },
        { id: "t2", name: "Query 2", buffer: "DROP TABLE secrets" },
      ],
      activeTabId: "t1",
    });
    openPanel(memento, { onRun });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("#6 edge/flush-once: dirty panel → dispose() → dispose() again writes the draft exactly once", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const updateSpy = vi.spyOn(memento, "update");
    const first = openPanel(memento);
    // Dirty WITHOUT advancing: only the dispose flush may persist.
    first.handler({ type: "updateBuffer", tabId: first.panel.getActiveTabId(), buffer: "SELECT flush" });

    first.panel.dispose();
    first.panel.dispose();
    vi.advanceTimersByTime(1000);
    const writes = updateSpy.mock.calls.filter(([key]) => key === CONSOLE_DRAFTS_KEY);
    expect(writes).toHaveLength(1);
    const snap = parseConsoleDraftSnapshot(writes[0][1] as string)!;
    expect(snap.tabs[0].buffer).toBe("SELECT flush");
    await Promise.resolve();
  });

  it("#6b edge/flush-once: panel-close path (onDidDispose) also flushes exactly once", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const updateSpy = vi.spyOn(memento, "update");
    const { panel } = openPanel(memento);
    const { handler } = panelHarness();
    handler({ type: "updateBuffer", tabId: panel.getActiveTabId(), buffer: "SELECT close" });
    vi.advanceTimersByTime(500);

    // Simulate the user closing the tab: the mock panel's dispose() fires the
    // registered onDidDispose listener (harness behaviour), no explicit
    // ConsolePanel.dispose() call.
    consolePanels()[consolePanels().length - 1].dispose();
    vi.advanceTimersByTime(1000);
    const writes = updateSpy.mock.calls.filter(([key]) => key === CONSOLE_DRAFTS_KEY);
    expect(writes).toHaveLength(1);
    await Promise.resolve();
  });

  it("#7 edge/privacy: persisted payload carries exactly {version,tabs,activeTabId} and tabs {id,name,buffer}", () => {
    vi.useFakeTimers();
    const m = new FakeMemento();
    const session = openPanel(m);
    const t1 = session.panel.getActiveTabId();
    session.handler({ type: "updateBuffer", tabId: t1, buffer: "SELECT one" });
    session.handler({ type: "createTab", name: "Two" });
    const t2 = session.panel.getActiveTabId();
    session.handler({ type: "updateBuffer", tabId: t2, buffer: "SELECT two" });
    session.handler({ type: "switchTab", tabId: t1 });
    vi.advanceTimersByTime(500);

    const raw = m.get<string>(CONSOLE_DRAFTS_KEY)!;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["activeTabId", "tabs", "version"]);
    const tabs = parsed.tabs as Array<Record<string, unknown>>;
    for (const tab of tabs) {
      expect(Object.keys(tab).sort()).toEqual(["buffer", "id", "name"]);
    }
    const rawLower = raw.toLowerCase();
    expect(rawLower).not.toContain("password");
    expect(rawLower).not.toContain("connection");
    expect(rawLower).not.toContain("result");
    expect(rawLower).not.toContain("history");
  });

  it("#8 edge/durable clear: clearDrafts removes the memento key; reopen shows one empty 'Query 1'", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const session = openPanel(memento);
    session.handler({ type: "updateBuffer", tabId: session.panel.getActiveTabId(), buffer: "SELECT doomed" });
    vi.advanceTimersByTime(500);
    expect(memento.get<string>(CONSOLE_DRAFTS_KEY)).toBeDefined();

    session.handler({ type: "clearDrafts" });
    vi.advanceTimersByTime(500);
    expect(memento.get<string>(CONSOLE_DRAFTS_KEY)).toBeUndefined();

    // Later dispose must NOT resurrect the cleared draft.
    session.panel.dispose();
    vi.advanceTimersByTime(1000);
    expect(memento.get<string>(CONSOLE_DRAFTS_KEY)).toBeUndefined();

    // Reopen: fresh single empty tab, pre-clear buffer gone.
    const reopened = openPanel(memento).panel;
    const tabs = reopened.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe("Query 1");
    expect(tabs[0].buffer).toBe("");
  });

  it("#9 edge/clamp: 21 tabs + oversized buffer persist as 20 tabs with the buffer sliced", () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const session = openPanel(memento);
    const big = "X".repeat(CONSOLE_DRAFTS_MAX_BUFFER_CHARS + 6_000);
    const t1 = session.panel.getActiveTabId();
    session.handler({ type: "updateBuffer", tabId: t1, buffer: big });
    for (let i = 0; i < CONSOLE_DRAFTS_MAX_TABS; i++) {
      session.handler({ type: "createTab" });
      session.handler({ type: "updateBuffer", tabId: session.panel.getActiveTabId(), buffer: `SELECT ${i}` });
    }
    // Active is now the LAST (21st) tab → clamp must remap to a survivor.
    vi.advanceTimersByTime(500);

    const raw = memento.get<string>(CONSOLE_DRAFTS_KEY)!;
    const snap = parseConsoleDraftSnapshot(raw)!;
    expect(snap).not.toBeNull();
    expect(snap.tabs).toHaveLength(CONSOLE_DRAFTS_MAX_TABS);
    expect(snap.tabs[0].buffer).toBe(big.slice(0, CONSOLE_DRAFTS_MAX_BUFFER_CHARS));
    expect(snap.tabs.some((t) => t.id === snap.activeTabId)).toBe(true);
    expect(snap.tabs.some((t) => t.buffer.length > CONSOLE_DRAFTS_MAX_BUFFER_CHARS)).toBe(false);
  });

  it("#10 regression: updateBuffer with an unknown tabId is a silent no-op (no write)", () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const updateSpy = vi.spyOn(memento, "update");
    const { handler } = openPanel(memento);
    expect(() => handler({ type: "updateBuffer", tabId: "tab-ghost", buffer: "SELECT x" })).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(updateSpy.mock.calls.filter(([key]) => key === CONSOLE_DRAFTS_KEY)).toHaveLength(0);
  });

  it("#11 edge/fallback: NO draftMemento → hydrate + persist no-op, no throw", () => {
    vi.useFakeTimers();
    const { panel, handler } = openPanel();
    expect(() => panel.listTabs()).not.toThrow();
    handler({ type: "updateBuffer", tabId: panel.getActiveTabId(), buffer: "SELECT memory" });
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => panel.dispose()).not.toThrow();
  });

  it("#12 edge/latest-wins: three rapid updateBuffers then dispose WITHOUT advancing → one persist carrying C", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const updateSpy = vi.spyOn(memento, "update");
    const session = openPanel(memento);
    const tabId = session.panel.getActiveTabId();
    session.handler({ type: "updateBuffer", tabId, buffer: "SELECT A" });
    session.handler({ type: "updateBuffer", tabId, buffer: "SELECT B" });
    session.handler({ type: "updateBuffer", tabId, buffer: "SELECT C" });
    // dispose() flushes the pending (reset) timer exactly once — latest wins.
    session.panel.dispose();
    vi.advanceTimersByTime(1000);
    const writes = updateSpy.mock.calls.filter(([key]) => key === CONSOLE_DRAFTS_KEY);
    expect(writes).toHaveLength(1);
    const snap = parseConsoleDraftSnapshot(writes[0][1] as string)!;
    expect(snap.tabs[0].buffer).toBe("SELECT C");
    await Promise.resolve();
  });

  it("#13 edge/order: out-of-creation-order snapshot tabs restore verbatim in snapshot order", () => {
    const memento = new FakeMemento();
    seedDrafts(memento, {
      version: CONSOLE_DRAFT_SNAPSHOT_VERSION,
      tabs: [
        { id: "zzz", name: "Zed", buffer: "SELECT z" },
        { id: "aaa", name: "Ay", buffer: "SELECT a" },
      ],
      activeTabId: "zzz",
    });
    const panel = openPanel(memento).panel;
    expect(panel.listTabs().map((t) => t.id)).toEqual(["zzz", "aaa"]);
    expect(panel.listTabs().map((t) => t.name)).toEqual(["Zed", "Ay"]);
  });

  it("#14 edge/writer-clamp: a 500-char tab name persists sliced to CONSOLE_DRAFTS_MAX_NAME_CHARS", async () => {
    vi.useFakeTimers();
    const memento = new FakeMemento();
    const session = openPanel(memento);
    const tabId = session.panel.getActiveTabId();
    const longName = "N".repeat(500);
    // Mutate host state directly via the public renameTab method so the
    // writer sees a 500-char name; then trigger a debounced persist through
    // the message seam.
    session.panel.renameTab(tabId, longName);
    session.handler({ type: "updateBuffer", tabId, buffer: "SELECT clamp" });
    vi.advanceTimersByTime(500);

    const raw = memento.get<string>(CONSOLE_DRAFTS_KEY)!;
    expect(typeof raw).toBe("string");
    const snap = parseConsoleDraftSnapshot(raw);
    expect(snap).not.toBeNull();
    // Writer clamp: emitted name is exactly CONSOLE_DRAFTS_MAX_NAME_CHARS,
    // not the original 500.
    expect(snap!.tabs[0].name).toHaveLength(CONSOLE_DRAFTS_MAX_NAME_CHARS);
    expect(snap!.tabs[0].name).toBe("N".repeat(CONSOLE_DRAFTS_MAX_NAME_CHARS));
    // The host's clamp guarantees our own writer never emits a snapshot
    // our own parser would reject — round-trip is safe.
    expect(parseConsoleDraftSnapshot(encodeConsoleDraftSnapshot(snap!))).toEqual(snap);
  });
});
