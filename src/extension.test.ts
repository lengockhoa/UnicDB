// src/extension.test.ts
// Smoke test — `activate(context)` wiring đầy đủ:
//   - 12 package commands + internal tree command + CodeLens provider + tree view đăng ký.
//   - ResultsPanel nhận extensionUri.
//   - status bar dispose không throw.
//
// Pattern: vi.mock('vscode') đầy đủ.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
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
  // TASK-606: giá trị setting vsdb.confirmDestructive (undefined = default true).
  confirmDestructive: undefined as boolean | undefined,
  configurationChangeEmitter: new FakeEventEmitter<unknown>(),
  // Active editor stub (cho runQuery/generateSelect tests).
  activeEditor: undefined as unknown as {
    document: { languageId: string; getText(): string; offsetAt(p: unknown): number };
    selection: { isEmpty: boolean; active: unknown; start: unknown; end: unknown };
    insertSnippet: (s: unknown) => Promise<void>;
  },
  // Terminal stubs (cho TASK-505 runScript tests).
  createdTerminals: [] as Array<{
    name: string;
    sendText: Mock;
    show: Mock;
    dispose: Mock;
    exitStatus: { code: number } | undefined;
  }>,
};

vi.mock("vscode", () => {
  return {
    EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
    window: {
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
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
      createTerminal: vi.fn((options: { name?: string } = {}) => {
        // Terminal mới sinh ra còn sống (exitStatus = undefined), đúng contract VS Code API.
        // Test muốn simulate "đã chết" thì set `term.exitStatus = { code: 0 }` sau khi tạo.
        const exitStatus: { code: number } | undefined = undefined;
        const term = {
          name: options.name ?? "vscode-terminal",
          sendText: vi.fn(),
          show: vi.fn(),
          dispose: vi.fn(),
          exitStatus,
        };
        state.createdTerminals.push(term);
        return term;
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
          if (key === "confirmDestructive") return state.confirmDestructive as T;
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
    Terminal: class {},
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
    state.createdTerminals.length = 0;
  });

  it("register đủ 17 command theo package.json (11 cũ + 6 TASK-005)", () => {
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
      "vsdb.runScript",
      "vsdb.newTable",
      "vsdb.modifyTable",
      "vsdb.copyCreateDdl",
      "vsdb.generateSampleData",
      "vsdb.analyzeTable",
      "vsdb.vacuumTable",
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
    state.createdTerminals.length = 0;
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

// =============================================================================
// TASK-303: filter command + view/title menu.
// =============================================================================
import * as fs from "node:fs";
import { SchemaTreeProvider } from "./ui/schemaTree";

const pkgJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

describe("TASK-303 — filter command + view/title menu", () => {
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
    state.createdTerminals.length = 0;
  });

  it("package.json contributes khai báo 2 command mới với icon + menu entries đúng when", () => {
    const commands = pkgJson.contributes.commands as Array<{
      command: string;
      title: string;
      icon: string;
    }>;
    const filterCmd = commands.find((c) => c.command === "vsdb.filterSchemaTree");
    const clearCmd = commands.find((c) => c.command === "vsdb.clearSchemaTreeFilter");
    expect(filterCmd).toBeDefined();
    expect(filterCmd!.title).toBe("Filter Schema Tree");
    expect(filterCmd!.icon).toBe("$(filter)");
    expect(clearCmd).toBeDefined();
    expect(clearCmd!.title).toBe("Clear Schema Tree Filter");
    expect(clearCmd!.icon).toBe("$(close)");

    const viewTitle = pkgJson.contributes.menus["view/title"] as Array<{
      command: string;
      when: string;
      group: string;
    }>;
    const filterMenu = viewTitle.find((m) => m.command === "vsdb.filterSchemaTree");
    const clearMenu = viewTitle.find((m) => m.command === "vsdb.clearSchemaTreeFilter");
    expect(filterMenu).toBeDefined();
    expect(filterMenu!.when).toBe("view == vsdb.schemaTree");
    expect(filterMenu!.group).toBe("navigation");
    expect(clearMenu).toBeDefined();
    expect(clearMenu!.when).toBe(
      "view == vsdb.schemaTree && vsdb.schemaTreeFilterActive",
    );
    expect(clearMenu!.group).toBe("navigation");
  });

  it("register 2 command mới: vsdb.filterSchemaTree + vsdb.clearSchemaTreeFilter", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("vsdb.filterSchemaTree")).toBe(true);
    expect(state.registeredCommands.has("vsdb.clearSchemaTreeFilter")).toBe(true);
  });

  it("showInputBox trả undefined (Esc) → setFilter KHÔNG được gọi", async () => {
    const ctx = makeCtx();
    activate(ctx as never);

    const setFilterSpy = vi.spyOn(SchemaTreeProvider.prototype, "setFilter");
    const showInputBoxSpy = vi.mocked(vscodeMock.window.showInputBox);
    showInputBoxSpy.mockResolvedValueOnce(undefined);

    const fn = state.registeredCommands.get("vsdb.filterSchemaTree");
    expect(fn).toBeDefined();
    await fn!();

    expect(showInputBoxSpy).toHaveBeenCalled();
    expect(setFilterSpy).not.toHaveBeenCalled();

    setFilterSpy.mockRestore();
  });
});

// =============================================================================
// TASK-505: vsdb.runScript — send active shell script to a reused terminal.
// =============================================================================
describe("TASK-505 — runScript command + terminal reuse", () => {
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
    state.createdTerminals.length = 0;
    // Reset module để drop module-level `runScriptTerminal` từ test trước.
    vi.resetModules();
  });

  // Re-import + activate sau resetModules (mỗi test lấy module + registeredCommands mới).
  // activateFresh: dynamic import cố ý (resetModules vừa drop cache).
  async function activateFresh(ctx: ReturnType<typeof makeCtx>) {
    const mod = await import("./extension");
    await mod.activate(ctx as never);
  }

  it("Test #1: command 'vsdb.runScript' được register khi activate", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);
    expect(state.registeredCommands.has("vsdb.runScript")).toBe(true);
  });

  it("Test #2: handler tạo terminal 'VSDB Script' + sendText full content của document shellscript", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const scriptText = "echo hello\necho world\nls -la\n";
    state.activeEditor = {
      document: {
        languageId: "shellscript",
        getText: () => scriptText,
        offsetAt: (_p: unknown) => 0,
      },
      selection: {
        isEmpty: true,
        active: { line: 0, character: 0 },
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    const fn = state.registeredCommands.get("vsdb.runScript");
    expect(fn).toBeDefined();
    await fn!();

    // createTerminal được gọi đúng 1 lần với name "VSDB Script"
    expect(state.createdTerminals.length).toBe(1);
    expect(state.createdTerminals[0].name).toBe("VSDB Script");
    // sendText nhận full document text + newline (paste full file)
    const term = state.createdTerminals[0];
    expect(term.sendText).toHaveBeenCalledTimes(1);
    expect(term.sendText.mock.calls[0][0]).toBe(scriptText + "\n");
    // terminal.show được gọi
    expect(term.show).toHaveBeenCalled();
  });

  it("Test #3: document rỗng → vẫn sendText (newline), không throw", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    state.activeEditor = {
      document: {
        languageId: "shellscript",
        getText: () => "",
        offsetAt: (_p: unknown) => 0,
      },
      selection: {
        isEmpty: true,
        active: { line: 0, character: 0 },
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    const fn = state.registeredCommands.get("vsdb.runScript");
    expect(fn).toBeDefined();
    await expect(fn!()).resolves.toBeUndefined();

    expect(state.createdTerminals.length).toBe(1);
    const term = state.createdTerminals[0];
    expect(term.sendText).toHaveBeenCalledTimes(1);
    // Empty document: sendText được gọi với empty string + newline → "\n"
    expect(term.sendText.mock.calls[0][0]).toBe("\n");
    expect(term.show).toHaveBeenCalled();
  });

  it("Test #4: terminal cũ còn sống → reuse, chỉ 1 createTerminal call khi run 2 lần", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const scriptText = "echo hi\n";
    state.activeEditor = {
      document: {
        languageId: "shellscript",
        getText: () => scriptText,
        offsetAt: (_p: unknown) => 0,
      },
      selection: {
        isEmpty: true,
        active: { line: 0, character: 0 },
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    const fn = state.registeredCommands.get("vsdb.runScript");
    expect(fn).toBeDefined();

    // First call: tạo terminal mới (mock alive-by-default).
    await fn!();
    expect(state.createdTerminals.length).toBe(1);
    const firstTerm = state.createdTerminals[0];

    // Second call: terminal cũ còn alive → reuse, không tạo mới.
    await fn!();
    expect(state.createdTerminals.length).toBe(1);

    // sendText được gọi 2 lần (một cho mỗi invocation), cùng instance.
    expect(firstTerm.sendText).toHaveBeenCalledTimes(2);
    expect(firstTerm.show).toHaveBeenCalledTimes(2);
  });

  it("Test #5: terminal cũ đã chết (exitStatus !== undefined) → tạo terminal mới khi run lại", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    state.activeEditor = {
      document: {
        languageId: "shellscript",
        getText: () => "echo first\n",
        offsetAt: (_p: unknown) => 0,
      },
      selection: {
        isEmpty: true,
        active: { line: 0, character: 0 },
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    const fn = state.registeredCommands.get("vsdb.runScript");
    expect(fn).toBeDefined();

    // First call: module runScriptTerminal = null → tạo terminal mới.
    await fn!();
    expect(state.createdTerminals.length).toBe(1);
    const firstTerm = state.createdTerminals[0];

    // Terminal process exits → đánh dấu dead.
    firstTerm.exitStatus = { code: 0 };

    // Second call: terminal cũ đã chết → phải tạo terminal mới, KHÔNG reuse.
    await fn!();
    expect(state.createdTerminals.length).toBe(2);

    const secondTerm = state.createdTerminals[1];
    // Instance khác nhau (không reuse).
    expect(secondTerm).not.toBe(firstTerm);
    // Terminal mới cũng tên "VSDB Script".
    expect(secondTerm.name).toBe("VSDB Script");
    // Terminal cũ không nhận text lần 2.
    expect(firstTerm.sendText).toHaveBeenCalledTimes(1);
    // Terminal mới nhận text lần 2.
    expect(secondTerm.sendText).toHaveBeenCalledTimes(1);
    expect(secondTerm.sendText.mock.calls[0][0]).toBe("echo first\n\n");
    expect(secondTerm.show).toHaveBeenCalled();
  });

  // ===== TASK-605 #6: no-editor guard =====

  it("Test #6 — vsdb.runScript với NO active editor → showWarningMessage, KHÔNG tạo terminal", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    state.activeEditor = undefined;

    const fn = state.registeredCommands.get("vsdb.runScript");
    expect(fn).toBeDefined();
    await expect(fn!()).resolves.toBeUndefined();

    const showWarningSpy = vi.mocked(
      (vscodeMock.window as unknown as {
        showWarningMessage: ReturnType<typeof vi.fn>;
      }).showWarningMessage,
    );
    expect(showWarningSpy).toHaveBeenCalled();

    // createTerminal KHÔNG được gọi.
    expect(state.createdTerminals.length).toBe(0);
  });

  it("Test #6b — vsdb.runScript với editor không phải shellscript (sql) vẫn gửi text như cũ (không guard theo language)", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    state.activeEditor = {
      document: {
        languageId: "sql",
        getText: () => "SELECT 1;\n",
        offsetAt: (_p: unknown) => 0,
      },
      selection: {
        isEmpty: true,
        active: { line: 0, character: 0 },
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    const fn = state.registeredCommands.get("vsdb.runScript");
    expect(fn).toBeDefined();
    await fn!();

    expect(state.createdTerminals.length).toBe(1);
    const term = state.createdTerminals[0];
    expect(term.sendText).toHaveBeenCalledWith("SELECT 1;\n\n");
  });
});

// =============================================================================
// TASK-606: destructive confirm guard (DELETE/TRUNCATE/DROP/UPDATE).
// =============================================================================
import type { MockInstance } from "vitest";

/** Arg shape thực tế của showWarningMessage modal (overload vscode không mô tả được). */
type WarnCall = [string, { modal: boolean; detail: string }, ...string[]];

describe("TASK-606 — destructive confirm guard", () => {
  let runSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.registeredTreeDataProviders.clear();
    state.createdStatusBarItems.length = 0;
    state.createdWebviewPanels.length = 0;
    state.createdTreeViews.length = 0;
    state.registeredCodeLensProviders.length = 0;
    state.onDidChangeConfigSubscribers.length = 0;
    state.workspaceFolders = undefined; // ⇒ ConnectionManager dùng globalState
    state.activeEditor = undefined;
    state.createdTerminals.length = 0;
    state.confirmDestructive = undefined; // default → true
    vi.resetModules();
  });

  /** ctx với active connection seeded qua globalState (không đi qua SecretStorage). */
  function makeSeededCtx() {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "vsdb.connections") {
        return [
          {
            id: "c1",
            name: "c",
            driver: "postgres",
            host: "h",
            port: 5432,
            user: "u",
            database: "d",
          },
        ];
      }
      if (key === "vsdb.activeConnection") return "c1";
      return undefined;
    }) as never;
    return ctx;
  }

  function setEditor(sql: string, selection?: { start: number; end: number }) {
    state.activeEditor = {
      document: {
        languageId: "sql",
        getText: () => sql,
        offsetAt: (p: unknown) => (p as { character: number }).character,
      },
      selection: selection
        ? {
            isEmpty: false,
            active: { line: 0, character: selection.end },
            start: { line: 0, character: selection.start },
            end: { line: 0, character: selection.end },
          }
        : {
            isEmpty: true,
            active: { line: 0, character: 0 },
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function activateFresh606() {
    const ctx = makeSeededCtx();
    // Dynamic import cố ý: vi.resetModules() vừa drop cache, cần instance mới
    // của cả extension lẫn queryRunner để spy prototype đúng class đang dùng.
    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockResolvedValue([]);
    const mod = await import("./extension");
    await mod.activate(ctx as never);
    return ctx;
  }

  const warnSpy = () => vi.mocked(vscodeMock.window.showWarningMessage);
  const warnCalls = () => warnSpy().mock.calls as unknown as WarnCall[];

  it("B9 — DELETE có WHERE + bấm 'Run' → modal amber rồi chạy", async () => {
    await activateFresh606();
    setEditor("DELETE FROM t WHERE id = 1;");
    warnSpy().mockResolvedValueOnce("Run");

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnSpy()).toHaveBeenCalledTimes(1);
    const [msg, opts, ...items] = warnCalls()[0];
    expect(msg).toMatch(/DELETE/i);
    expect(opts.modal).toBe(true);
    expect(opts.detail).toContain("DELETE FROM t WHERE id = 1");
    expect(items).toContain("Run");
    expect(runSpy).toHaveBeenCalled();
  });

  it("B10 — TRUNCATE red + cancel → KHÔNG chạy, không setBusy", async () => {
    await activateFresh606();
    setEditor("TRUNCATE TABLE t;");
    warnSpy().mockResolvedValueOnce(undefined);

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnSpy()).toHaveBeenCalledTimes(1);
    const [msg, opts, ...items] = warnCalls()[0];
    expect(msg).toMatch(/NGUY HIỂM/);
    expect(opts.modal).toBe(true);
    expect(opts.detail).toContain("TRUNCATE TABLE t");
    expect(items).toContain("Vẫn chạy (nguy hiểm)");
    expect(runSpy).not.toHaveBeenCalled();
    // Không vào busy state → webview panel chưa được tạo.
    expect(state.createdWebviewPanels.length).toBe(0);
  });

  it("B11 — DELETE không WHERE + confirm đỏ → chạy", async () => {
    await activateFresh606();
    setEditor("DELETE FROM t;");
    warnSpy().mockResolvedValueOnce("Vẫn chạy (nguy hiểm)");

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnCalls()[0][0]).toMatch(/NGUY HIỂM/);
    expect(runSpy).toHaveBeenCalled();
  });

  it("B12 — confirmDestructive=false → bỏ qua guard, chạy ngay", async () => {
    state.confirmDestructive = false;
    await activateFresh606();
    setEditor("DELETE FROM t;");

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnSpy()).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalled();
  });

  it("B13 — mixed batch SELECT + TRUNCATE, cancel → huỷ cả lô", async () => {
    await activateFresh606();
    const sql = "SELECT 1; TRUNCATE t;";
    setEditor(sql, { start: 0, end: sql.length });
    warnSpy().mockResolvedValueOnce(undefined);

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnSpy()).toHaveBeenCalledTimes(1);
    expect(warnCalls()[0][0]).toMatch(/NGUY HIỂM/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("B14 — SELECT thường không bị hỏi", async () => {
    await activateFresh606();
    setEditor("SELECT 1;");

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnSpy()).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalled();
  });

  it("B15 — package.json khai báo vsdb.confirmDestructive default true", () => {
    const props = pkgJson.contributes.configuration.properties as Record<
      string,
      { type: string; default: unknown }
    >;
    expect(props["vsdb.confirmDestructive"]).toBeDefined();
    expect(props["vsdb.confirmDestructive"].type).toBe("boolean");
    expect(props["vsdb.confirmDestructive"].default).toBe(true);
  });
});


// =============================================================================
// TASK-005 — extension wiring: 6 new commands + activationEvents + menus.
// =============================================================================
describe("TASK-005 — extension wiring smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("register đủ 6 command mới: vsdb.newTable/modifyTable/copyCreateDdl/generateSampleData/analyzeTable/vacuumTable", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const six = [
      "vsdb.newTable",
      "vsdb.modifyTable",
      "vsdb.copyCreateDdl",
      "vsdb.generateSampleData",
      "vsdb.analyzeTable",
      "vsdb.vacuumTable",
    ];
    for (const cmd of six) {
      expect(state.registeredCommands.has(cmd)).toBe(true);
    }
  });

  it("package.json activationEvents có đủ 6 entry mới (onCommand)", () => {
    const evts = pkgJson.activationEvents as string[];
    const six = [
      "onCommand:vsdb.newTable",
      "onCommand:vsdb.modifyTable",
      "onCommand:vsdb.copyCreateDdl",
      "onCommand:vsdb.generateSampleData",
      "onCommand:vsdb.analyzeTable",
      "onCommand:vsdb.vacuumTable",
    ];
    for (const e of six) {
      expect(evts).toContain(e);
    }
  });
});
// Avoid path-imports lint complaints.
void path;
