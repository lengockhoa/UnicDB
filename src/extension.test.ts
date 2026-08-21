// src/extension.test.ts
// Smoke test — `activate(context)` wiring đầy đủ:
//   - 10 command + CodeLens provider + tree view đăng ký.
//   - ResultsPanel nhận extensionUri.
//   - status bar dispose không throw.
//
// Pattern: vi.mock('vscode') đầy đủ.
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "node:path";

type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };
  fire(data: T) {
    for (const l of this.listeners.slice()) l(data);
  }
}

const state = {
  registeredCommands: new Map<string, Function>(),
  registeredTreeDataProviders: new Map<string, { provider: unknown }>(),
  createdStatusBarItems: [] as unknown[],
  createdWebviewPanels: [] as unknown[],
  createdTreeViews: [] as unknown[],
  registeredCodeLensProviders: [] as Array<{ language: unknown }>,
  onDidChangeConfigSubscribers: [] as Array<(e: { affectsConfiguration: (s: string) => boolean }) => void>,
  workspaceFolders: undefined as unknown,
  configurationChangeEmitter: new FakeEventEmitter<unknown>(),
  // Active editor stub (cho runQuery/generateSelect tests).
  activeEditor: undefined as unknown as {
    document: { languageId: string; getText(): string; offsetAt(p: unknown): number };
    selection: { isEmpty: boolean; active: unknown; start: unknown; end: unknown };
    insertSnippet: (s: unknown) => Promise<void>;
  },
};

vi.mock("vscode", () => {
  return {
    EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
    window: {
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
      showErrorMessage: vi.fn().mockResolvedValue(undefined),
      showInputBox: vi.fn().mockResolvedValue(undefined),
      showQuickPick: vi.fn().mockResolvedValue(undefined),
      setStatusBarMessage: vi.fn().mockResolvedValue(undefined),
      createStatusBarItem: vi.fn().mockImplementation(() => {
        const item = {
          text: "",
          tooltip: undefined as string | undefined,
          command: undefined as string | undefined,
          show: vi.fn(),
          hide: vi.fn(),
          dispose: vi.fn(),
        };
        state.createdStatusBarItems.push(item);
        return item;
      }),
      createWebviewPanel: vi.fn().mockImplementation(() => {
        const panel = {
          webview: {
            html: "",
            postMessage: vi.fn().mockResolvedValue(undefined),
            onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
            asWebviewUri: vi.fn((u: unknown) => u),
            cspSource: "vscode-webview://test",
          },
          onDidDispose: vi.fn(() => ({ dispose: () => {} })),
          reveal: vi.fn(),
          dispose: vi.fn(),
          visible: true,
        };
        state.createdWebviewPanels.push(panel);
        return panel;
      }),
      createTreeView: vi.fn().mockImplementation((id: string) => {
        const tv = { id, dispose: vi.fn() };
        state.createdTreeViews.push(tv);
        return tv;
      }),
      get activeTextEditor() {
        return state.activeEditor;
      },
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: <T>(key: string): T | undefined => {
          if (key === "showRunLens") return true as T;
          if (key === "batchSize") return 500 as T;
          return undefined;
        },
      })),
      onDidChangeConfiguration: vi.fn((cb: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
        state.onDidChangeConfigSubscribers.push(cb);
        return { dispose: () => {} };
      }),
      get workspaceFolders() {
        return state.workspaceFolders;
      },
    },
    commands: {
      registerCommand: vi.fn((id: string, fn: Function) => {
        state.registeredCommands.set(id, fn);
        return { dispose: () => state.registeredCommands.delete(id) };
      }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
    TreeDataProvider: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: vi.fn(),
    Uri: {
      file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p, path: p, scheme: "file" }),
      parse: (s: string) => ({ toString: () => s }),
      joinPath: vi.fn((u: unknown, ...p: string[]) => ({
        toString: () => `${String(u)}/${p.join("/")}`,
        path: p.join("/"),
      })),
    },
    CodeLens: vi.fn(),
    Range: vi.fn(),
    SnippetString: vi.fn((text: string) => ({ value: text })),
    ViewColumn: { Beside: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    languages: {
      registerCodeLensProvider: vi.fn((language: unknown, provider: unknown) => {
        state.registeredCodeLensProviders.push({ language });
        return { dispose: () => {} };
      }),
    },
    env: {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    },
    Selection: vi.fn().mockImplementation((start: unknown, end: unknown) => ({
      start,
      end,
      active: end,
      isEmpty: false,
    })),
    Position: vi.fn().mockImplementation((line: number, character: number) => ({
      line,
      character,
    })),
  };
});

import { activate, deactivate } from "./extension";

function makeCtx() {
  const subscriptions: Array<{ dispose: () => void }> = [];
  return {
    subscriptions,
    extensionUri: {
      toString: () => "file:///ext",
      fsPath: "/ext",
      path: "/ext",
      scheme: "file",
    },
    secrets: {
      store: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    workspaceState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    globalState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("extension.activate — wiring smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.registeredTreeDataProviders.clear();
    state.createdStatusBarItems.length = 0;
    state.createdWebviewPanels.length = 0;
    state.createdTreeViews.length = 0;
    state.registeredCodeLensProviders.length = 0;
    state.onDidChangeConfigSubscribers.length = 0;
    state.workspaceFolders = undefined;
    state.activeEditor = undefined;
  });

  it("register đủ 10 command theo package.json", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const expected = [
      "vsdb.addConnection",
      "vsdb.editConnection",
      "vsdb.deleteConnection",
      "vsdb.selectConnection",
      "vsdb.runQuery",
      "vsdb.cancelQuery",
      "vsdb.generateSelect",
      "vsdb.copyQualifiedName",
      "vsdb.refreshSchema",
      "vsdb.runStatement",
    ];
    for (const cmd of expected) {
      expect(state.registeredCommands.has(cmd)).toBe(true);
    }
  });

  it("SchemaTreeProvider được register cho view vsdb.schemaTree", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.createdTreeViews.length).toBeGreaterThanOrEqual(1);
    const view = state.createdTreeViews[0] as { id: string };
    expect(view.id).toBe("vsdb.schemaTree");
  });

  it("StatusBar created (>= 1)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.createdStatusBarItems.length).toBeGreaterThanOrEqual(1);
  });

  it("CodeLens provider registered cho 'sql'", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCodeLensProviders.length).toBeGreaterThanOrEqual(1);
    const first = state.registeredCodeLensProviders[0] as { language: unknown };
    // Selector is either a string ("sql") or DocumentSelector object ({scheme, language}).
    if (typeof first.language === "string") {
      expect(first.language).toBe("sql");
    } else {
      expect(first.language).toEqual({ scheme: "file", language: "sql" });
    }
  });

  it("subscriptions có >= 10 entries (đăng ký disposable cho mỗi command + tree + codelens + statusbar)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(10);
  });

  it("deactivate chạy không throw", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(() => deactivate()).not.toThrow();
  });
});

// =============================================================================
// Spec test #5: runQuery without connection → showQuickPick called with
// "Add Connection" option (spy). Manager has no active connection; editor is
// a .sql file; expect vscode.window.showQuickPick to be invoked and the option
// list to include the "Add Connection" label.
// =============================================================================
import * as vscodeMock from "vscode";

describe("Spec test #5 — runQuery without connection prompts QuickPick with 'Add Connection'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.registeredTreeDataProviders.clear();
    state.createdStatusBarItems.length = 0;
    state.createdWebviewPanels.length = 0;
    state.createdTreeViews.length = 0;
    state.registeredCodeLensProviders.length = 0;
    state.onDidChangeConfigSubscribers.length = 0;
    state.workspaceFolders = undefined;
    state.activeEditor = undefined;
  });

  it("vsdb.runQuery với editor .sql và manager active=null → showQuickPick được gọi với option 'Add Connection'", async () => {
    const ctx = makeCtx();
    activate(ctx as never);

    // Stub activeTextEditor (SQL).
    const doc = {
      languageId: "sql",
      getText: () => "SELECT 1;",
      offsetAt: (_p: unknown) => 0,
    };
    const selection = {
      isEmpty: true,
      active: { line: 0, character: 0 },
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    };
    state.activeEditor = {
      document: doc,
      selection,
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    // Spy showQuickPick. Trả undefined (user dismissed) để runQuery thoát sớm.
    const showQuickPickSpy = vi.mocked(vscodeMock.window.showQuickPick);
    showQuickPickSpy.mockResolvedValueOnce(undefined);

    const runQueryFn = state.registeredCommands.get("vsdb.runQuery");
    expect(runQueryFn).toBeDefined();
    await runQueryFn!();

    // showQuickPick được gọi với options chứa "Add Connection".
    expect(showQuickPickSpy).toHaveBeenCalled();
    const args = showQuickPickSpy.mock.calls[0][0] as Array<{ label: string }>;
    const labels = args.map((o) => o.label);
    expect(labels.some((l) => /Add Connection/i.test(l))).toBe(true);
  });

  it("vsdb.runQuery với editor .sql và manager active=null → option 'Select existing' cũng có", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const doc = {
      languageId: "sql",
      getText: () => "SELECT 1;",
      offsetAt: (_p: unknown) => 0,
    };
    state.activeEditor = {
      document: doc,
      selection: { isEmpty: true, active: { line: 0, character: 0 }, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };
    const showQuickPickSpy = vi.mocked(vscodeMock.window.showQuickPick);
    showQuickPickSpy.mockResolvedValueOnce(undefined);
    const runQueryFn = state.registeredCommands.get("vsdb.runQuery");
    await runQueryFn!();
    const args = showQuickPickSpy.mock.calls[0][0] as Array<{ label: string }>;
    const labels = args.map((o) => o.label);
    expect(labels.some((l) => /Select existing/i.test(l))).toBe(true);
  });
});

// Avoid path-imports lint complaints.
void path;
