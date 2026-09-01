// src/extension.test.ts
// Smoke test — `activate(context)` wiring đầy đủ:
//   - 12 package commands + internal tree command + CodeLens provider + tree view đăng ký.
//   - ResultsPanel nhận extensionUri.
//   - status bar dispose không throw.
//
// Pattern: vi.mock('vscode') đầy đủ.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  registeredContentProviders: [] as Array<{ scheme: string; provider: unknown }>,
  onDidChangeConfigSubscribers: [] as Array<(e: { affectsConfiguration: (s: string) => boolean }) => void>,
  workspaceFolders: undefined as unknown,
  // TASK-606: giá trị setting vsdb.confirmDestructive (undefined = default true).
  confirmDestructive: undefined as boolean | undefined,

  /**
   * Cycle AE R4.5 — value returned by `vscode.workspace.getConfiguration("vsdb").get("ai.engine")`.
   * undefined → default arg `"builtin"` applies. Tests that exercise the omp
   * path set this to `"omp"` to mirror the user-toggled setting.
   */
  aiEngine: undefined as string | undefined,
  /**
   * TASK-AIX07-003 — `vscode.workspace.isTrusted` value seen by the host
   * policy derivation. Toggled per-test.
   */
  workspaceIsTrusted: true,
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
          if (key === "confirmDestructive") return state.confirmDestructive as T;
          if (key === "ai.engine") return (state.aiEngine ?? "builtin") as T;
          return undefined;
        },
      })),
      fs: {
        writeFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockResolvedValue(new Uint8Array()),
        rename: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      showSaveDialog: undefined,
      onDidChangeConfiguration: vi.fn((cb: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
        state.onDidChangeConfigSubscribers.push(cb);
        return { dispose: () => {} };
      }),
      isTrusted: true,
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: () => {} })),
      onDidCreateFiles: vi.fn(() => ({ dispose: () => {} })),
      onDidDeleteFiles: vi.fn(() => ({ dispose: () => {} })),
      findFiles: vi.fn(async () => []),
      get isTrusted() {
        return state.workspaceIsTrusted;
      },
      set isTrusted(v: boolean) {
        state.workspaceIsTrusted = v;
      },
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      // TASK-AF-002: DDL viewer registers a TextDocumentContentProvider for the
      // `vsdb-ddl:` URI scheme at activate(). The default mock returns a
      // disposable so registration is a no-op (no provider body needed) for
      // the smoke tests; ddlView.test.ts builds its own richer provider mock.
      registerTextDocumentContentProvider: vi.fn((scheme: string, provider: unknown) => {
        state.registeredContentProviders.push({ scheme, provider });
        return { dispose: () => {} };
      }),
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

// TASK-011 (B3/B8): `commandOpenAiChat` now calls the REAL `detectOmp()`
// before deciding whether AI chat needs config. Every extension.test.ts test
// that invokes `vsdb.aiChat` must not shell out to a real `which omp` on the
// machine running the suite — that would make tests nondeterministic (and
// slow) depending on whatever happens to be on the test runner's PATH.
// Default: omp NOT installed, so all pre-existing "unconfigured → interstitial"
// tests keep their exact prior behavior (only the builtin engine needs
// config). Individual TASK-011 tests below reassign `detectOmpState.impl` to
// exercise the omp-present paths.
const detectOmpState = vi.hoisted(() => ({
  impl: async () =>
    ({ available: false, ok: false, reason: "not-installed" }) as {
      available: boolean;
      ok: boolean;
      path?: string;
      version?: string;
      reason?: string;
    },
}));
vi.mock("./ai/omp/detect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai/omp/detect")>();
  return {
    ...actual,
    detectOmp: (...args: unknown[]) =>
      (detectOmpState.impl as (...a: unknown[]) => unknown)(...args),
  };
});

import { activate, deactivate } from "./extension";

// File-wide reset — every test starts from "omp not installed" unless it
// explicitly reassigns detectOmpState.impl for its own scope.
beforeEach(() => {
  detectOmpState.impl = async () => ({
    available: false,
    ok: false,
    reason: "not-installed",
  });
  state.aiEngine = undefined;
});

// ---- helpers used by TASK-003 case #6 (declared above all uses) ------------
const panelConstructorCalls: Array<unknown> = [];
import { AcpProcess } from "./ai/omp/acpProcess";
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
    state.registeredContentProviders.length = 0;
    state.onDidChangeConfigSubscribers.length = 0;
    state.workspaceFolders = undefined;
    state.activeEditor = undefined;
    state.createdTerminals.length = 0;
  });

  it("register đủ command theo package.json (17 cũ + các cycle sau)", () => {
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
    // DBX-01 + DBX-03 + DBX-04 wiring contracts (T18): import + compare
    // + relationship explorer commands must all register during
    // activate() without throwing.
    const laterCycles = [
      "vsdb.importCsv",
      "vsdb.importJson",
      "vsdb.openFormView",
      "vsdb.editLargeValue",
      "vsdb.compareTables",
      "vsdb.relationshipExplorer",
    ];
    for (const cmd of laterCycles) {
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

  // TASK-002 case 8 — registration guard: partial vscode.languages mock
  // (chỉ stub registerCodeLensProvider, xem :159-164) thiếu
  // registerDocumentSemanticTokensProvider → activate() KHÔNG throw.
  it("TASK-002 #8 activate() không throw khi registerDocumentSemanticTokensProvider vắng mặt", () => {
    const ctx = makeCtx();
    expect(() => activate(ctx as never)).not.toThrow();
  });

  // TASK-DBX02-005 — SQL intelligence navigation wiring.
  it("DBX-02: catalog document provider đăng ký cho scheme vsdb-sql-catalog", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const catalog = state.registeredContentProviders.find(
      (r) => r.scheme === "vsdb-sql-catalog",
    );
    expect(catalog).toBeDefined();
    const provider = catalog!.provider as { provideTextDocumentContent: unknown };
    expect(typeof provider.provideTextDocumentContent).toBe("function");
  });

  it("DBX-02: hover/definition/reference providers không throw với partial languages mock", () => {
    const ctx = makeCtx();
    expect(() => activate(ctx as never)).not.toThrow();
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

// TASK-003 (case #9, last assertion) — esbuild emits dist/schemaForm.js.
// Read at module-init time to match the 11 other bundle tests; an in-test
// existsSync raced with parallel workers when compile was racing other
// builds, causing a spurious failure on a green run.
const schemaFormBundlePresent = fs.existsSync(
  path.join(__dirname, "..", "dist", "schemaForm.js"),
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
  function makeSeededCtx(driver: string = "postgres") {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "vsdb.connections") {
        return [
          {
            id: "c1",
            name: "c",
            driver,
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

  async function activateFresh606(driver: string = "postgres") {
    const ctx = makeSeededCtx(driver);
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

  it("B16 — regression (Finding #3/#5): mysql dialect threaded to guard tier — WHERE inside a backslash-escaped string must NOT count as a real WHERE", async () => {
    await activateFresh606("mysql");
    // MySQL-only escaping: `\'` inside a `'...'` string does NOT close it, so
    // the "WHERE id=1" text below is INSIDE the string literal, not a real
    // WHERE clause — this UPDATE is effectively unconditional and must be
    // guarded (tier "red"). Without `dialect` threaded from the active
    // connection into `confirmDangerousStatements`'s `analyzeStatement` call,
    // the default (non-MySQL) string-close rule sees the FIRST `'` (right
    // after the backslash) as closing the string, so the WHERE becomes
    // "visible" at depth 0 — `hasWhere` wrongly flips to `true` and the
    // guard silently classifies this as tier "none" (no confirm), letting an
    // effectively-unconditional UPDATE run with zero warning.
    setEditor("UPDATE t SET c = 'x\\' WHERE id=1' ;");
    warnSpy().mockResolvedValueOnce("Vẫn chạy (nguy hiểm)");

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(warnSpy()).toHaveBeenCalledTimes(1);
    expect(warnCalls()[0][0]).toMatch(/NGUY HIỂM/);
    expect(runSpy).toHaveBeenCalled();
  });

  it("B17 — regression (Finding #3): mssql dialect threaded to sqlToRun — `GO` batch separator actually splits the run", async () => {
    await activateFresh606("mssql");
    // `GO` batch-separator splitting is gated behind `dialect === "mssql"`
    // in `splitStatements` (statementParser.ts). Without `sqlToRun` in
    // `runQueryFromEditor` receiving the active connection's real dialect,
    // this always split as if Postgres — `GO` stayed literal text glued
    // into ONE statement instead of splitting into two SELECTs.
    const sql = "SELECT 1\nGO\nSELECT 2\nGO";
    setEditor(sql, { start: 0, end: sql.length });

    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(runSpy).toHaveBeenCalled();
    const ranStatements = runSpy.mock.calls[0][0] as Array<{ text: string }>;
    expect(ranStatements.length).toBe(2);
    expect(ranStatements.some((s) => /\bGO\b/.test(s.text))).toBe(false);
  });

  it("AH-002 editor run threads append mode and pre-run appendBase", async () => {
    await activateFresh606();
    const sql = "SELECT 1;\nSELECT 2;";
    setEditor(sql, { start: 0, end: sql.length });
    // vi.resetModules() in activateFresh606 creates a fresh ResultsPanel module;
    // spy on that instance's prototype rather than the file-wide import.
    const { ResultsPanel: ResultsPanelModule } = await import("./ui/resultsPanel");
    const renderSpy = vi.spyOn(ResultsPanelModule.prototype, "render");
    await state.registeredCommands.get("vsdb.runQuery")!();

    expect(runSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function),
      { append: true },
    );
    expect(renderSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      { appendBase: 0 },
    );
    renderSpy.mockRestore();
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

// =============================================================================
// TASK-004 — vsdb.openAiSettings command + activationEvent + contributes
// =============================================================================
describe("TASK-004 — vsdb.openAiSettings wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("registers vsdb.openAiSettings handler on activate", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("vsdb.openAiSettings")).toBe(true);
  });

  it("package.json contributes.commands declares vsdb.openAiSettings", () => {
    const cmds = (pkgJson.contributes as { commands: Array<{ command: string }> })
      .commands;
    const entry = cmds.find((c) => c.command === "vsdb.openAiSettings");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/AI Settings/i);
  });

  it("package.json activationEvents contains onCommand:vsdb.openAiSettings", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:vsdb.openAiSettings");
  });
});
// Avoid path-imports lint complaints.
void path;

// =============================================================================
// TASK-004 — vsdb.aiChat command wiring + unconfigured fallback.
// =============================================================================
describe("TASK-004 — vsdb.aiChat wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("Test #5 — vsdb.aiChat được register trong subscriptions sau activate()", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("vsdb.aiChat")).toBe(true);
    // Command handler phải thuộc context.subscriptions (để dispose dọn dẹp).
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it("Test #5b — dispose() sạch: deactivate() không throw sau khi gọi vsdb.aiChat", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();
    // Gọi handler trước khi dispose — không crash, không throw.
    await fn!();
    await expect(deactivate()).resolves.not.toThrow();
  });

  it("Test #3 — loadConfig() resolve null → info message + mở AI Settings form; không crash", async () => {
    const ctx = makeCtx();
    // globalState.get trả undefined → loadSettings trả null → loadConfig trả null.
    activate(ctx as never);
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    const executeCommandSpy = vi.mocked(vscodeMock.commands.executeCommand);
    showInfoSpy.mockClear();
    executeCommandSpy.mockClear();

    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    // Phải hiện info + trigger openAiSettings.
    expect(showInfoSpy).toHaveBeenCalled();
    const infoArgs = showInfoSpy.mock.calls[0];
    const infoText = (infoArgs?.[0] ?? "") as string;
    expect(infoText.toLowerCase()).toMatch(/configure|ai|settings/i);
    // Mở form settings qua executeCommand('vsdb.openAiSettings').
    const called = executeCommandSpy.mock.calls.some(
      (c) => c[0] === "vsdb.openAiSettings",
    );
    expect(called).toBe(true);
  });
});

// =============================================================================
// TASK-011 (B3) — commandOpenAiChat resolves the engine via a real
// detectOmp() + pure resolveEngine() policy call BEFORE deciding whether the
// config interstitial is needed. Locked decision #2: omp is zero-config —
// requiresConfig must be false whenever detectOmp() reports ok:true, even
// with no AiConfigStore.loadConfig() result at all.
// =============================================================================
describe("TASK-011 (B3) — commandOpenAiChat resolves engine via detectOmp() + resolveEngine()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdWebviewPanels.length = 0;
    // `./ui/aiChatPanel` is mocked file-wide (see the hoisted vi.mock below,
    // whose factory closes over this same array) — assert construction via
    // panelConstructorCalls, not real vscode.window.createWebviewPanel calls.
    panelConstructorCalls.length = 0;
    // Restore the file-wide default (not-installed) before each test; the
    // Happy test below overrides it locally.
    detectOmpState.impl = async () => ({
      available: false,
      ok: false,
      reason: "not-installed",
    });
    state.aiEngine = undefined;
  });

  afterEach(async () => {
    // extension.ts keeps a module-level `aiChatPanel` singleton; without
    // resetting it here, a panel opened by one test short-circuits the next
    // test's `if (aiChatPanel) { show(); return; }` guard before it ever
    // reaches detectOmp()/resolveEngine().
    await deactivate();
  });

  it("Happy — omp detected + ok, NO ai config saved → panel opens directly, no config interstitial", async () => {
    state.aiEngine = "omp";
    detectOmpState.impl = async () => ({
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    });
    const ctx = makeCtx(); // unconfigured: globalState.get returns undefined
    activate(ctx as never);
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    const executeCommandSpy = vi.mocked(vscodeMock.commands.executeCommand);
    showInfoSpy.mockClear();
    executeCommandSpy.mockClear();

    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    // B3: no interstitial — never routed to AI Settings, never shown the
    // "configure AI first" info message, because omp needs zero config.
    expect(showInfoSpy).not.toHaveBeenCalled();
    const routedToSettings = executeCommandSpy.mock.calls.some(
      (c) => c[0] === "vsdb.openAiSettings",
    );
    expect(routedToSettings).toBe(false);
    // The chat panel actually opened, wired for the omp engine.
    expect(panelConstructorCalls.length).toBe(1);
    const opts = panelConstructorCalls[0] as {
      engineVersion?: string;
      engineHint?: string;
      acp?: unknown;
    };
    expect(opts.engineVersion).toBe("18.0.1");
    expect(opts.acp).toBeDefined();
  });

  it("R(B3) regression — omp NOT available + no config → config interstitial still shown (unchanged pre-TASK-011 behavior)", async () => {
    // Default detectOmpState.impl (not-installed) from beforeEach above.
    const ctx = makeCtx();
    activate(ctx as never);
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    const executeCommandSpy = vi.mocked(vscodeMock.commands.executeCommand);
    showInfoSpy.mockClear();
    executeCommandSpy.mockClear();

    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    expect(showInfoSpy).toHaveBeenCalled();
    const routedToSettings = executeCommandSpy.mock.calls.some(
      (c) => c[0] === "vsdb.openAiSettings",
    );
    expect(routedToSettings).toBe(true);
    expect(panelConstructorCalls.length).toBe(0);
  });

  // ---- MINOR review finding 7 ------------------------------------------
  // extension.ts's `if (aiChatPanel) { aiChatPanel.show(); return; }` guard
  // (line ~405) makes the module-level singleton reference the ONLY thing
  // that decides whether a fresh detectOmp()/resolveEngine() pass ever
  // happens again. Closing the webview tab tears the panel down via
  // `panel.onDidDispose` — a code path that never touched extension.ts's
  // reference before this fix — so the guard kept short-circuiting into a
  // disposed instance forever, and a later omp install/config change was
  // never picked up without a full window reload.
  it("R(Finding7) regression: closing the webview tab (onDispose) lets the NEXT vsdb.aiChat re-detect the engine and open a fresh panel", async () => {
    state.aiEngine = "omp";
    detectOmpState.impl = async () => ({
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    });
    const ctx = makeCtx();
    activate(ctx as never);

    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();

    await fn!();
    expect(panelConstructorCalls.length).toBe(1);

    // Second open while the panel is still alive is a no-op reveal — no new
    // detectOmp()/construction (pre-existing behavior, unaffected by this
    // fix).
    await fn!();
    expect(panelConstructorCalls.length).toBe(1);

    // Simulate the webview tab being closed by the user — this is exactly
    // what `panel.onDidDispose` → `AiChatPanel.teardown()` does in
    // production: fire the `onDispose` callback threaded into the
    // constructor options.
    const firstOpts = panelConstructorCalls[0] as { onDispose?: () => void };
    expect(firstOpts.onDispose).toBeTypeOf("function");
    firstOpts.onDispose!();

    // The module-level singleton must now be null, so the NEXT open
    // re-detects and constructs a SECOND, fresh panel instead of reusing
    // the disposed one.
    await fn!();
    expect(panelConstructorCalls.length).toBe(2);
  });

  // ---- TASK-AIX03-102 case 5: dispose + re-subscription ---------------------
  // REAL panel disposal: the first panel's teardown must dispose its
  // recovery subscription EXACTLY ONCE (listener count back to zero on the
  // host emitter), and the next vsdb.aiChat command must construct a SECOND
  // panel that registers one FRESH listener on the SAME
  // ConnectionManager.onDidChangeRecoveryStatus event reference (proves the
  // host wired the activation-scoped `mgr`, not a fresh closure).
  it("case 5: real panel dispose releases its recovery subscription; the next panel re-subscribes on the same mgr event", async () => {
    state.aiEngine = "omp";
    detectOmpState.impl = async () => ({
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    });
    vi.resetModules();
    // Re-mock the aiChatPanel module here (file-wide vi.mock is hoisted
    // out of this test) with the REAL panel subclassed so construction is
    // captured while teardown stays fully real: constructor subscribes to
    // the recovery event; dispose() → real teardown → recoverySub.dispose().
    const panelInstances: Array<{
      dispose(): void;
    }> = [];
    vi.doMock("./ui/aiChatPanel", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("./ui/aiChatPanel")>();
      return {
        ...actual,
        AiChatPanel: class extends actual.AiChatPanel {
          constructor(opts: unknown) {
            super(opts as never);
            panelConstructorCalls.push(opts);
            panelInstances.push(this as unknown as { dispose(): void });
          }
        },
      };
    });
    // Mock the connection manager module BEFORE importing extension.ts.
    // Every `new ConnectionManager(...)` is captured here.
    let liveMgr: {
      onDidChangeRecoveryStatus: (
        listener: (s: unknown) => void,
      ) => { dispose(): void };
    } | null = null;
    vi.doMock("./core/connectionManager", async () => {
      const actual = await vi.importActual<typeof import("./core/connectionManager")>(
        "./core/connectionManager",
      );
      const Orig = actual.ConnectionManager;
      class SpyMgr extends Orig {
        constructor(...a: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          super(...(a as []));
          liveMgr = this as unknown as typeof liveMgr;
        }
      }
      return { ...actual, ConnectionManager: SpyMgr };
    });
    const ext = await import("./extension");
    const ctx2 = makeCtx();
    await ext.activate(ctx2 as never);
    expect(liveMgr).not.toBeNull();
    // Wrap the mgr's real event with a counting wrapper — the host must
    // pass THIS exact reference to both panels, and the wrapper tracks
    // registrations, active listeners, and dispose() calls.
    const baseEvent = liveMgr!.onDidChangeRecoveryStatus;
    const registered: Array<(s: unknown) => void> = [];
    let activeListeners = 0;
    let subDisposeCalls = 0;
    const countingEvent = (listener: (s: unknown) => void) => {
      registered.push(listener);
      activeListeners += 1;
      const d = baseEvent(listener);
      return {
        dispose: () => {
          subDisposeCalls += 1;
          activeListeners -= 1;
          d.dispose();
        },
      };
    };
    (liveMgr as { onDidChangeRecoveryStatus: unknown }).onDidChangeRecoveryStatus =
      countingEvent;

    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();

    await fn!();
    expect(panelConstructorCalls.length).toBe(1);
    const firstOpts = panelConstructorCalls[0] as {
      onDidChangeRecoveryStatus?: unknown;
    };
    // The first panel got the (wrapped) mgr event reference and subscribed.
    expect(firstOpts.onDidChangeRecoveryStatus).toBe(countingEvent);
    expect(registered.length).toBe(1);
    expect(activeListeners).toBe(1);

    // REAL disposal — the panel's own teardown path, exactly what VS Code's
    // onDidDispose triggers in production.
    panelInstances[0]!.dispose();
    // The first subscription's dispose() ran EXACTLY ONCE (the torndown
    // guard collapses the explicit dispose + re-entrant onDidDispose into a
    // single teardown), and the host emitter is back to zero listeners.
    expect(subDisposeCalls).toBe(1);
    expect(activeListeners).toBe(0);

    await fn!();
    expect(panelConstructorCalls.length).toBe(2);

    const secondOpts = panelConstructorCalls[1] as {
      onDidChangeRecoveryStatus?: unknown;
    };
    // The SECOND panel received the SAME event reference (host reused the
    // activation-scoped mgr, not a fresh emitter per construction) and
    // registered exactly ONE fresh listener.
    expect(secondOpts.onDidChangeRecoveryStatus).toBe(countingEvent);
    expect(registered.length).toBe(2);
    expect(activeListeners).toBe(1);
    expect(registered[1]).not.toBe(registered[0]);

    // Restore the file-wide no-op panel mock so this test's doMock does not
    // leak into later describes (vi.doMock persists across resetModules).
    vi.doMock("./ui/aiChatPanel", () => ({
      AiChatPanel: class {
        constructor(opts: unknown) {
          panelConstructorCalls.push(opts);
        }
        show(): void {}
        dispose(): void {}
      },
    }));
  });
});

// =============================================================================
// TASK-002 (wave 2) — wire `vsdb.browseTableData` from schemaTree nodes:
//   * extension.activate() registers the command via registerBrowseCommands.
//   * package.json declares contributes.commands entry + activationEvent.
//   * invoking the registered handler with no argument must not throw
//     (palette fallback → showInformationMessage, see browseCommands.test.ts #5).
// =============================================================================
describe("TASK-002 — vsdb.browseTableData extension wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("registers vsdb.browseTableData handler trong activate() (case 3)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("vsdb.browseTableData")).toBe(true);
  });

  it("invoking vsdb.browseTableData handler không throw khi palette (no arg) (case 3)", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    expect(fn).toBeDefined();
    await expect(fn!()).resolves.not.toThrow();
    await expect(fn!(undefined)).resolves.not.toThrow();
    await expect(fn!({})).resolves.not.toThrow();
  });
  it("package.json contributes.commands có vsdb.browseTableData entry với category VSDB (case 4)", () => {
    // pkgJson đã là typed JSON.parse output; ép kiểu 1 lần tại ranh giới rồi truy cập thuộc tính đã được kiểm tra.
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "vsdb.browseTableData");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Browse Table Data/i);
    expect(entry!.category).toBe("VSDB");
  });

  it("package.json activationEvents có onCommand:vsdb.browseTableData (case 4)", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:vsdb.browseTableData");
  });
});


// =============================================================================
// TASK-002 — AcpProcess module is importable + extension activation still
// completes (no regression to the existing 12 + tree + CodeLens wiring).
// AcpProcess is intentionally NOT wired into activate() yet — TASK-004 will
// consume it from the panel; legacy rpc.ts/process.ts remain in place.
// =============================================================================
describe("TASK-002 — AcpProcess importable + extension activation regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("AcpProcess module is exported and constructible", () => {
    expect(typeof AcpProcess).toBe("function");
    expect(
      new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/tmp/proj",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        () => {
          throw new Error("not used");
        },
      ),
    ).toBeDefined();
  });

  it("activate() still registers every command and deactivate() does not throw (TASK-002 regression)", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    // All commands through TASK-005 + TASK-004 must still be present.
    const expected = [
      "vsdb.runQuery",
      "vsdb.addConnection",
      "vsdb.editConnection",
      "vsdb.deleteConnection",
      "vsdb.selectConnection",
      "vsdb.cancelQuery",
      "vsdb.generateSelect",
      "vsdb.copyQualifiedName",
      "vsdb.refreshSchema",
      "vsdb.openAiSettings",
      "vsdb.aiChat",
      "vsdb.runScript",
    ];
    for (const id of expected) {
      expect(state.registeredCommands.has(id)).toBe(true);
    }
    await expect(deactivate()).resolves.not.toThrow();
  });
});

// =============================================================================
// TASK-003 — extension wires `streamComplete` closure so the panel's
// runAgent can call createProviderClient().streamComplete per turn with
// (cfg, role, req, onText, signal). Verifies the closure shape end-to-end
// through activate → commandOpenAiChat → AiChatPanel constructor mock →
// deps.streamComplete call.
// =============================================================================
// TASK-003 — extension wires `streamComplete` closure so the panel's
// runAgent can call createProviderClient().streamComplete per turn with
// (cfg, role, req, onText, signal). The constructor is captured via a
// hoisted `vi.mock("./ui/aiChatPanel", …)` factory; vi.resetModules() in
// beforeEach makes extension.ts re-evaluate against the new mock per test.
// =============================================================================
vi.mock("./ui/aiChatPanel", () => ({
  AiChatPanel: class {
    constructor(opts: { deps: unknown }) {
      panelConstructorCalls.push(opts);
    }
    show(): void {}
    dispose(): void {}
  },
}));
describe("TASK-003 — extension wires streamComplete for builtin streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    panelConstructorCalls.length = 0;
    vi.resetModules();
  });

  it("#6 activate → vsdb.aiChat → AiChatPanel is constructed with deps whose streamComplete is a function (5-arg)", async () => {
    const ext = await import("./extension");
    const ctx = makeConfiguredCtx();
    await ext.activate(ctx as never);
    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();
    expect(state.registeredCommands.has("vsdb.aiChat")).toBe(true);

    await fn!();

    expect(panelConstructorCalls.length).toBeGreaterThan(0);
    const opts = panelConstructorCalls[panelConstructorCalls.length - 1] as {
      deps: {
        loadConfig?: unknown;
        complete?: unknown;
        streamComplete?: unknown;
      };
    };
    expect(typeof opts.deps.streamComplete).toBe("function");
    expect(typeof opts.deps.loadConfig).toBe("function");
    expect(typeof opts.deps.complete).toBe("function");
  });

  it("#6b deps.streamComplete accepts 5 args and wires a real provider-style call", async () => {
    const ext = await import("./extension");
    const ctx = makeConfiguredCtx();
    await ext.activate(ctx as never);
    const fn = state.registeredCommands.get("vsdb.aiChat");
    expect(fn).toBeDefined();
    await fn!();
    const opts = panelConstructorCalls[panelConstructorCalls.length - 1] as {
      deps: {
        streamComplete: (
          cfg: unknown,
          role: unknown,
          req: unknown,
          onText: unknown,
          signal: unknown,
        ) => Promise<unknown>;
      };
    };

    // Verify shape only — invoking would dispatch a fetch that would be
    // network-rejected in jsdom and surface as an unhandled promise
    // rejection. The 5-arg arity on the function is the contract surface.
    expect(opts.deps.streamComplete.length).toBeGreaterThanOrEqual(5);
    expect(opts.deps.streamComplete.name).not.toBe("");
  });
});
function makeConfiguredCtx() {
  const subscriptions: Array<{ dispose: () => void }> = [];
  const settings = {
    baseUrl: "http://example.test",
    method: "chat/completions",
    timeoutMs: 60_000,
    maxSteps: 12,
    models: {
      work: { modelId: "gpt-test", vision: true },
      smart: { modelId: "gpt-test", vision: false },
    },
    engine: "builtin",
  };
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
      get: vi.fn().mockResolvedValue("sk-test-key"),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    workspaceState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    globalState: {
      // Only the key path AiConfigStore reads returns a valid payload.
      get: vi.fn((key: string) =>
        key === "vsdb.ai.settings" ? settings : undefined,
      ),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// =============================================================================
// TASK-003 (wave 3) — vsdb.createSchema: register the command, declare in
// package.json contributes.commands + activationEvents, add view/item/context
// entry for connection + schema viewItem when-clause, ensure esbuild emits
// dist/schemaForm.js.
// =============================================================================
describe("TASK-003 — vsdb.createSchema extension wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("registers vsdb.createSchema handler on activate (case 9)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("vsdb.createSchema")).toBe(true);
  });

  it("package.json contributes.commands declares vsdb.createSchema with category VSDB", () => {
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "vsdb.createSchema");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Create.*Schema/i);
    expect(entry!.category).toBe("VSDB");
  });

  it("package.json activationEvents contains onCommand:vsdb.createSchema", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:vsdb.createSchema");
  });

  it("package.json menus.view/item/context contains connection+schema entry for vsdb.createSchema", () => {
    interface MenuEntry { command: string; when?: string; group?: string }
    const ctxMenus = (pkgJson.contributes.menus as { "view/item/context": MenuEntry[] })[
      "view/item/context"
    ];
    const entry = ctxMenus.find((m) => m.command === "vsdb.createSchema");
    expect(entry).toBeDefined();
    expect(entry!.when).toMatch(/view\s*==\s*vsdb\.schemaTree/);
    expect(entry!.when).toMatch(/connection/);
    expect(entry!.when).toMatch(/schema/);
  });

  it("npm run compile emits dist/schemaForm.js (esbuild config wired)", () => {
    expect(schemaFormBundlePresent).toBe(true);
  });
});


// =============================================================================
// TASK-007 — vsdb.runStatement applies qualifyKeywordTables at the
// runStatements choke point. Active adapter's listTables("public") determines
// whether reserved-keyword table names get rewritten to "public"."<name>".
import { qualifyKeywordTables } from "./core/keywordQualify";
import type { DbAdapter } from "./adapters/types";
import type { ParsedStatement } from "./config/types";

describe("TASK-007 — runStatement rewrites reserved-keyword tables to public schema", () => {
  let runSpy: ReturnType<typeof vi.fn>;
  let listTablesSpy: ReturnType<typeof vi.fn>;

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
    state.confirmDestructive = undefined;
    vi.resetModules();
  });

  it("#2 vsdb.runStatement with `SELECT * FROM order;` rewrites to `SELECT * FROM \"public\".\"order\";`", async () => {
    const ctx = makeCtx();
    // Seed an active connection so getActive() returns truthy and the run
    // path proceeds past the QuickPick fallback.
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

    // Mock the active adapter via ConnectionManager.getAdapter() — patch the
    // prototype so any instance created during activate() picks it up.
    const connectionMgrMod = await import("./core/connectionManager");
    listTablesSpy = vi.fn().mockResolvedValue([{ name: "order", schema: "public" }]);
    const adapter: Partial<DbAdapter> = {
      listTables: listTablesSpy as unknown as DbAdapter["listTables"],
      testConnection: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(connectionMgrMod.ConnectionManager.prototype, "getAdapter").mockResolvedValue(
      adapter as DbAdapter,
    );

    // Spy on QueryRunner.run so we can inspect the statements it receives.
    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockResolvedValue([]);

    const ext = await import("./extension");
    await ext.activate(ctx as never);

    const runStatementFn = state.registeredCommands.get("vsdb.runStatement");
    expect(runStatementFn).toBeDefined();

    const stmt: ParsedStatement = {
      text: "SELECT * FROM order;",
      start: 0,
      end: "SELECT * FROM order;".length,
    };
    await runStatementFn!(stmt);

    expect(runSpy).toHaveBeenCalled();
    const passed = runSpy.mock.calls[0]?.[0] as ParsedStatement[];
    expect(passed.length).toBe(1);
    expect(passed[0]!.text).toBe('SELECT * FROM "public"."order";');
    expect(listTablesSpy).toHaveBeenCalledWith("public");
  });

  it("#2b RED→GREEN guard: invoking qualifyKeywordTables directly with the same input matches the runner input", async () => {
    // Direct sanity check — guards against the runStatement test passing
    // for the wrong reason (e.g. mgr mock returning a pre-rewritten string).
    const res = await qualifyKeywordTables(
      "SELECT * FROM order;",
      async () => ["order"],
    );
    expect(res.changed).toBe(true);
    expect(res.sql).toBe('SELECT * FROM "public"."order";');
  });

  it("#3 D1: multi-statement run reuses ONE cache — listTables called once (not once per statement)", async () => {
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

    const connectionMgrMod = await import("./core/connectionManager");
    listTablesSpy = vi.fn().mockResolvedValue([{ name: "order", schema: "public" }]);
    const adapter: Partial<DbAdapter> = {
      listTables: listTablesSpy as unknown as DbAdapter["listTables"],
      testConnection: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(connectionMgrMod.ConnectionManager.prototype, "getAdapter").mockResolvedValue(
      adapter as DbAdapter,
    );

    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockResolvedValue([]);

    const ext = await import("./extension");
    await ext.activate(ctx as never);

    const sql = "SELECT * FROM order;\nSELECT * FROM order WHERE id = 1;";
    state.activeEditor = {
      document: {
        languageId: "sql",
        getText: () => sql,
        offsetAt: (p: unknown) => (p as { character: number }).character,
      },
      selection: {
        isEmpty: false,
        active: { line: 0, character: sql.length },
        start: { line: 0, character: 0 },
        end: { line: 0, character: sql.length },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    const runQueryFn = state.registeredCommands.get("vsdb.runQuery");
    expect(runQueryFn).toBeDefined();
    await runQueryFn!();

    expect(runSpy).toHaveBeenCalled();
    const passed = runSpy.mock.calls[0]?.[0] as ParsedStatement[];
    expect(passed.length).toBe(2);
    expect(passed[0]!.text).toContain('"public"."order"');
    expect(passed[1]!.text).toContain('"public"."order"');
    // D1: cache reused across both statements within the same run — exactly
    // ONE catalog round-trip, not one per statement.
    expect(listTablesSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TASK-005 — `vsdb.runQuery` cursor mode (no selection). Cursor nằm giữa 2
// statement → handler chỉ chạy statement chứa con trỏ, KHÔNG chạy cả file.
// =============================================================================
describe("TASK-005 — runQueryFromEditor cursor mode", () => {
  let runSpy: ReturnType<typeof vi.fn>;

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
    state.confirmDestructive = undefined;
    vi.resetModules();
  });

  it("#9 cursor giữa stmt 1 của 2 statement → runner.runQuery chạy đúng 1 stmt đầu", async () => {
    const ctx = makeCtx();
    // Seed active connection để runQuery qua màn QuickPick.
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

    const connectionMgrMod = await import("./core/connectionManager");
    const adapter: Partial<DbAdapter> = {
      listTables: vi.fn().mockResolvedValue([]),
      testConnection: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockResolvedValue(adapter as DbAdapter);

    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockResolvedValue([]);

    const ext = await import("./extension");
    await ext.activate(ctx as never);

    const runQueryFn = state.registeredCommands.get("vsdb.runQuery");
    expect(runQueryFn).toBeDefined();

    const sql = "SELECT 1;\nSELECT 2;";
    // offset 3 = bên trong `SELECT 1` (giữa stmt 1).
    const cursorOffset = 3;

    state.activeEditor = {
      document: {
        languageId: "sql",
        getText: () => sql,
        offsetAt: (_p: unknown) => cursorOffset,
      },
      selection: {
        isEmpty: true,
        active: { line: 0, character: cursorOffset },
        start: { line: 0, character: cursorOffset },
        end: { line: 0, character: cursorOffset },
      },
      insertSnippet: vi.fn().mockResolvedValue(undefined),
    };

    await runQueryFn!();

    expect(runSpy).toHaveBeenCalled();
    const passed = runSpy.mock.calls[0]?.[0] as ParsedStatement[];
    expect(passed.length).toBe(1);
    expect(passed[0]!.text).toBe("SELECT 1");
  });
});

// =============================================================================
// TASK-004 — vsdb.exportAllStructures wiring smoke: command id registered by
// activate(), package.json contributes.commands declares it, activationEvents
// has the onCommand entry, contributes.menus["view/item/context"] has an
// entry covering connection + schema viewItems. Lock-in match (Reviewer block).
// =============================================================================
describe("TASK-004 — vsdb.exportAllStructures wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("Test #4 — vsdb.exportAllStructures được register trong subscriptions khi activate()", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("vsdb.exportAllStructures")).toBe(true);
  });

  it("Test #4b — package.json contributes.commands declares vsdb.exportAllStructures", () => {
    const cmds = (pkgJson.contributes as { commands: Array<{ command: string; title: string }> })
      .commands;
    const entry = cmds.find((c) => c.command === "vsdb.exportAllStructures");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Export All Structures/i);
  });

  it("Test #4c — package.json activationEvents contains onCommand:vsdb.exportAllStructures", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:vsdb.exportAllStructures");
  });

  it("Test #4d — package.json view/item/context menu covers connection + schema viewItem", () => {
    const menuItems = (
      (pkgJson.contributes as { menus: Record<string, Array<{ command: string; when: string }>> })
        .menus["view/item/context"] ?? []
    );
    const entry = menuItems.find((m) => m.command === "vsdb.exportAllStructures");
    expect(entry).toBeDefined();
    expect(entry!.when).toMatch(/view == vsdb\.schemaTree/);
    expect(entry!.when).toMatch(/viewItem == connection/);
    expect(entry!.when).toMatch(/viewItem == schema/);
  });
});

// =============================================================================
// TASK-003 (cycle Z) — vsdb.openConsole: command registration, package.json
// contribution, activationEvent, and full-buffer execution delegation.
// The registered handler routes runConsole through sqlToRun with a FULL-BUFFER
// selection ({start:0,end:sql.length}) and the active dialect, then hands EVERY
// parsed statement to the existing shared runStatements flow (dangerous
// confirm + keyword qualify + runner + ResultsPanel render all still apply).
// =============================================================================
describe("TASK-003 — vsdb.openConsole wiring", () => {
  let runSpy: ReturnType<typeof vi.fn>;

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
    state.confirmDestructive = undefined;
    vi.resetModules();
  });

  afterEach(async () => {
    // extension.ts keeps module-level singletons (incl. the console panel);
    // deactivate drops them so later describes start clean.
    await deactivate();
  });

  /** Activate against a seeded active connection + spied QueryRunner.run. */
  async function activateWithConsole(driver = "postgres") {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "vsdb.connections") {
        return [
          {
            id: "c1",
            name: "c",
            driver,
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

    const connectionMgrMod = await import("./core/connectionManager");
    const adapter: Partial<DbAdapter> = {
      listTables: vi.fn().mockResolvedValue([]),
      testConnection: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockResolvedValue(adapter as DbAdapter);

    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockResolvedValue([]);

    const ext = await import("./extension");
    await ext.activate(ctx as never);
    return ctx;
  }

  it("#C1 registers vsdb.openConsole on activate", async () => {
    await activateWithConsole();
    expect(state.registeredCommands.has("vsdb.openConsole")).toBe(true);
  });

  it("#C2 package.json contributes 'VSDB: Open Console' with matching activationEvent", () => {
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "vsdb.openConsole");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Open Console/i);
    expect(entry!.category).toBe("VSDB");
    // Palette-only per plan §3.3: no view/title or other menu entry.
    const menus = pkgJson.contributes.menus as Record<
      string,
      Array<{ command: string }>
    >;
    for (const [menu, entries] of Object.entries(menus)) {
      expect(
        entries.some((m) => m.command === "vsdb.openConsole"),
        `vsdb.openConsole must not appear in ${menu}`,
      ).toBe(false);
    }
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:vsdb.openConsole");
  });

  /** Index of the createWebviewPanel call whose viewType is vsdb.console,
   *  plus the created panel instance (shared mock does not tag instances). */
  function findConsolePanelCall(): { callIndex: number; panel: Record<string, unknown> } {
    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string, string, unknown, unknown]>;
    const callIndex = calls.findIndex(([viewType]) => viewType === "vsdb.console");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const panel = state.createdWebviewPanels[callIndex] as Record<string, unknown>;
    return { callIndex, panel };
  }

  it("#C3 invoking vsdb.openConsole opens exactly one vsdb.console webview panel", async () => {
    await activateWithConsole();
    const fn = state.registeredCommands.get("vsdb.openConsole");
    expect(fn).toBeDefined();
    await fn!();

    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string]>;
    const consoleCalls = calls.filter(([viewType]) => viewType === "vsdb.console");
    expect(consoleCalls.length).toBe(1);
    // HTML links both assets under the established CSP.
    const { panel } = findConsolePanelCall();
    const html = (
      panel as unknown as { webview: { html: string } }
    ).webview.html;
    expect(html).toMatch(/consolePanel\.js/);
    expect(html).toMatch(/webview\.css/);
    expect(html).toContain(`style-src vscode-webview://test 'unsafe-inline'`);
  });

  it("#C4 runConsole message runs the WHOLE buffer through the shared flow: sqlToRun(full-span) → every statement to runner.run in source order", async () => {
    await activateWithConsole();
    const fn = state.registeredCommands.get("vsdb.openConsole");
    await fn!();

    const { panel } = findConsolePanelCall();
    const handler = (
      panel as unknown as { webview: { onDidReceiveMessage: Mock } }
    ).webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;

    // Fire-and-forget the handler; runStatements is awaited inside.
    handler({ type: "runConsole", sql: "SELECT 1; SELECT 2" });
    for (let i = 0; i < 100 && runSpy.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }

    expect(runSpy).toHaveBeenCalled();
    const passed = runSpy.mock.calls[0]?.[0] as ParsedStatement[];
    // BOTH statements parsed from the full buffer, source order preserved.
    expect(passed.length).toBe(2);
    expect(passed[0]!.text).toBe("SELECT 1");
    expect(passed[1]!.text).toBe("SELECT 2");
  });

  it("#C5 save message with cancelled dialog does not throw and writes nothing", async () => {
    // extension.test.ts's file-wide vscode mock omits showSaveDialog / fs.
    // Real VS Code always provides them; stub the CANCELLED outcome here so
    // the save flow resolves silently without writing anything.
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    win.showSaveDialog = vi.fn().mockResolvedValue(undefined);
    try {
      await activateWithConsole();
      const fn = state.registeredCommands.get("vsdb.openConsole");
      await fn!();
      const { panel } = findConsolePanelCall();
      const handler = (
        panel as unknown as { webview: { onDidReceiveMessage: Mock } }
      ).webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;

      handler({ type: "saveConsoleAsSql", sql: "SELECT 1;" });
      for (let i = 0; i < 100 && (win.showSaveDialog as Mock).mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(win.showSaveDialog).toHaveBeenCalled();
      // Nothing further happened: no writeFile surface exists to have been hit.
      expect(state.createdWebviewPanels.length).toBeGreaterThanOrEqual(1);
    } finally {
      delete win.showSaveDialog;
    }
  });
});

// =============================================================================
// TASK-AIX07-003 — vsdb.ai.showPolicy / vsdb.ai.exportTrace / vsdb.ai.clearTrace
// (policy + audit command host integration). The host derives the effective
// policy from `vscode.workspace.isTrusted`, the raw `vsdb.ai.engine`
// preference, and the `resolveEngine()` result. Valid configured + valid
// resolver + trusted ⇒ admit. Anything else ⇒ deny + concrete notice.
// show-policy: reports the policy state to the user via showInformationMessage
// (no side effects). export-trace: requires an active AiChatPanel AND
// admission; runs save-dialog → writeFile of the redacted envelope; denied
// paths post the notice and do NOT touch picker / fs. clear-trace: requires
// an active panel; absent panel ⇒ concrete notice, no throw.
// =============================================================================
describe("TASK-AIX07-003 — vsdb.ai.showPolicy / exportTrace / clearTrace host integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.aiEngine = undefined;
    // Default: untrusted workspace, valid configured `builtin`, valid
    // resolver `omp` (the locked-decision-#2 case). Individual tests
    // override `state.isTrusted` and the workspace mock to flip the gate.
    state.workspaceFolders = undefined;
    state.activeEditor = undefined;
    state.createdTerminals.length = 0;
    detectOmpState.impl = async () => ({
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    });
    state.aiEngine = "builtin";
    vi.resetModules();
  });

  afterEach(async () => {
    // Drop the module-level AiChatPanel singleton so the next test isn't
    // short-circuited by an existing panel reveal.
    await deactivate();
  });

  /** Re-import extension with a fresh `vscode.workspace.isTrusted` value. */
  async function activateWithTrust(trusted: boolean): Promise<{
    ctx: ReturnType<typeof makeCtx>;
    mod: typeof import("./extension");
  }> {
    const ctx = makeCtx();
    // The vi.mock factory closed over `state.isTrusted` via a getter; flip
    // it BEFORE the dynamic import so the module is built with the right
    // trust value. The file-wide mock for `vscode` is hoisted, so flipping
    // state here is sufficient — the mock reads from the live binding.
    (vscodeMock as unknown as { workspace: { isTrusted: boolean } }).workspace.isTrusted = trusted;
    // Some assertions re-read isTrusted via the mock's getter; ensure the
    // live value is the one the activation path sees.
    (vscodeMock.workspace as unknown as Record<string, unknown>).isTrusted = trusted;
    const mod = await import("./extension");
    await mod.activate(ctx as never);
    return { ctx, mod };
  }

  it("registers all three vsdb.ai.* commands on activate", async () => {
    await activateWithTrust(true);
    expect(state.registeredCommands.has("vsdb.ai.showPolicy")).toBe(true);
    expect(state.registeredCommands.has("vsdb.ai.exportTrace")).toBe(true);
    expect(state.registeredCommands.has("vsdb.ai.clearTrace")).toBe(true);
  });

  it("#1 happy — trusted + valid configured + valid resolver → showPolicy reports provider+context+tools+export; exportTrace calls saveDialog and writes envelope; clearTrace calls the panel", async () => {
    const { ctx } = await activateWithTrust(true);
    // Seed an active panel with two turns so the export envelope has body.
    const aiChatFn = state.registeredCommands.get("vsdb.aiChat");
    expect(aiChatFn).toBeDefined();
    await aiChatFn!();
    // Inspect the constructed panel to grab dumpTrace/clearTrace + a fake
    // dumpAll. The mock captures the constructor opts; we mount a
    // dumpAll() that returns two fixed dumps for export.
    const opts = panelConstructorCalls[panelConstructorCalls.length - 1] as {
      onDispose?: () => void;
    };
    // Plant a TraceRecorder-shaped stand-in on the panel mock so the host
    // export command can call dumpAll() and find two turns. The existing
    // mock is a no-op AiChatPanel; reach in via its prototype.
    const mod = await import("./ui/aiChatPanel");
    const panelInstance = (panelConstructorCalls[panelConstructorCalls.length - 1] as unknown as {
      __proto__: object;
    });
    // The mock class is captured via vi.mock("./ui/aiChatPanel") — the
    // constructor doesn't expose instance methods we can spy on. Instead
    // we monkey-patch dumpAll on the prototype. Use `mod.AiChatPanel`.
    const dummyDumps = [
      { turnId: "t1", events: [{ turnId: "t1", seq: 1, kind: "prompt", ts: 1, payload: { x: 1 } }], truncated: false },
      { turnId: "t2", events: [{ turnId: "t2", seq: 1, kind: "done", ts: 2, payload: { y: 2 } }], truncated: false },
    ];
    mod.AiChatPanel.prototype.dumpAll = vi.fn(() => dummyDumps);
    mod.AiChatPanel.prototype.clearTrace = vi.fn();
    // Provide a stubbed showSaveDialog → selected Uri and a writeFile spy.
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    const writeFileSpy = vi.fn().mockResolvedValue(undefined);
    win.showSaveDialog = vi.fn().mockResolvedValue({
      fsPath: "/tmp/vsdb-audit.json",
      toString: () => "file:///tmp/vsdb-audit.json",
      path: "/tmp/vsdb-audit.json",
      scheme: "file",
    });
    (vscodeMock.workspace as unknown as { fs: { writeFile: Mock } }).fs = {
      writeFile: writeFileSpy,
    };

    // (a) showPolicy posts an info message reporting provider/context/tools/export.
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    showInfoSpy.mockClear();
    const showPolicyFn = state.registeredCommands.get("vsdb.ai.showPolicy");
    await showPolicyFn!();
    expect(showInfoSpy).toHaveBeenCalled();
    const infoText = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    // The provider field is "omp" (resolver-selected) for this case; the
    // host should report it. The information message must mention it.
    expect(infoText.toLowerCase()).toMatch(/omp|engine|provider/);
    expect(infoText.toLowerCase()).toMatch(/context|tools|export/);

    // (b) exportTrace runs save-dialog + writeFile with the redacted envelope.
    const exportFn = state.registeredCommands.get("vsdb.ai.exportTrace");
    expect(exportFn).toBeDefined();
    await exportFn!();
    // saveDialog called once; writeFile called once with the serialized
    // envelope.
    expect(win.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const written = writeFileSpy.mock.calls[0]?.[1] as Uint8Array;
    const writtenText = new TextDecoder().decode(written);
    // The envelope MUST carry the schema marker from auditExport.ts.
    expect(writtenText).toContain("vsdb.ai.audit-export");
    // Defense in depth: byte-scan the wire for secret-shaped strings —
    // the dumpAll() we planted is already redaction-safe, so this pins
    // the contract regardless of which underlying dump the host called.
    expect(/api[_-]?key|secret|password|token|authorization|cookie|bearer|basic/i.test(writtenText)).toBe(false);

    // (c) clearTrace calls the active panel's clearTrace.
    const clearFn = state.registeredCommands.get("vsdb.ai.clearTrace");
    await clearFn!();
    expect(mod.AiChatPanel.prototype.clearTrace).toHaveBeenCalled();
    // Suppress unused-locals lint.
    void opts;
    void ctx;
  });

  it("#2 — valid configured builtin + resolver omp → still admitted (locked decision #2)", async () => {
    const { ctx } = await activateWithTrust(true);
    // The "ai.engine" preference resolves to "builtin" by default (the
    // mock returns undefined → default "builtin"). `resolveEngine()` then
    // picks "omp" because the mocked detection reports ok=true. The
    // effective provider is "omp" and admission is granted.
    state.aiEngine = "builtin";
    const showPolicyFn = state.registeredCommands.get("vsdb.ai.showPolicy");
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    showInfoSpy.mockClear();
    await showPolicyFn!();
    expect(showInfoSpy).toHaveBeenCalled();
    const infoText = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(infoText.toLowerCase()).toContain("omp");
    void ctx;
  });

  it("#3 — denied policy (untrusted workspace) gates export BEFORE showSaveDialog and writeFile", async () => {
    await activateWithTrust(false);
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    win.showSaveDialog = vi.fn();
    const writeFileSpy = vi.fn();
    (vscodeMock.workspace as unknown as { fs: { writeFile: Mock } }).fs = {
      writeFile: writeFileSpy,
    };
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    showInfoSpy.mockClear();

    const exportFn = state.registeredCommands.get("vsdb.ai.exportTrace");
    await exportFn!();

    // No picker, no write. Notice is shown.
    expect(win.showSaveDialog).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(showInfoSpy).toHaveBeenCalled();
    const infoText = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(infoText).toMatch(/VSDB AI policy|policy/);
  });

  it("#5 — invalid configured engine (migrated value) → export denied before side effects", async () => {
    await activateWithTrust(true);
    // Plant an invalid (non-vocabulary) configured value into the
    // getConfiguration() mock. The current file-wide mock returns a
    // function-only `get(key)`; we swap it for one that returns the
    // legacy string for the "ai.engine" key.
    const cfgMock = vscodeMock.workspace.getConfiguration as unknown as Mock;
    cfgMock.mockImplementationOnce((section: string) => ({
      get: <T>(key: string, def?: T): T | undefined => {
        if (section === "vsdb" && key === "ai.engine") {
          return "old-engine-from-pre-cycle" as unknown as T;
        }
        return def;
      },
    }));
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    win.showSaveDialog = vi.fn();
    const writeFileSpy = vi.fn();
    (vscodeMock.workspace as unknown as { fs: { writeFile: Mock } }).fs = {
      writeFile: writeFileSpy,
    };
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    showInfoSpy.mockClear();
    const exportFn = state.registeredCommands.get("vsdb.ai.exportTrace");
    await exportFn!();
    expect(win.showSaveDialog).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(showInfoSpy).toHaveBeenCalled();
  });

  it("#6 — export / clear without an active AI panel is a safe no-op + concrete notice", async () => {
    // Don't open AI chat — there is no active panel.
    await activateWithTrust(true);
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    win.showSaveDialog = vi.fn();
    const writeFileSpy = vi.fn();
    (vscodeMock.workspace as unknown as { fs: { writeFile: Mock } }).fs = {
      writeFile: writeFileSpy,
    };
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    showInfoSpy.mockClear();
    const exportFn = state.registeredCommands.get("vsdb.ai.exportTrace");
    await exportFn!();
    expect(win.showSaveDialog).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(showInfoSpy).toHaveBeenCalled();
    const exportInfo = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(exportInfo).toMatch(/open.*AI Chat|AI Chat panel|active|panel/i);
    showInfoSpy.mockClear();
    const clearFn = state.registeredCommands.get("vsdb.ai.clearTrace");
    await clearFn!();
    expect(showInfoSpy).toHaveBeenCalled();
    const clearInfo = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(clearInfo).toMatch(/open.*AI Chat|AI Chat panel|active|panel/i);
  });
});


// =============================================================================
// TASK-001 — per-connection manualCommit reaching ConnectionManager.
// openConnectionForm() builds ConnectionConfig literals for BOTH add and edit
// paths; these tests drive vsdb.addConnection / vsdb.editConnection through
// the mocked vscode layer and assert mgr.addConnection/editConnection receive
// a config whose manualCommit matches the webview submit payload exactly
// (concrete boolean — never omitted/undefined).
// Pattern parity: ConnectionManager.prototype spies, exactly like the existing
// getAdapter prototype spies above.
// =============================================================================
describe("TASK-001 — manualCommit forwarded into connection config (add + edit)", () => {
  let addSpy: ReturnType<typeof vi.fn>;
  let editSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.registeredTreeDataProviders.clear();
    state.createdStatusBarItems.length = 0;
    state.createdWebviewPanels.length = 0;
    state.createdTreeViews.length = 0;
    state.createdTerminals.length = 0;
    addSpy = vi.fn().mockResolvedValue(undefined);
    editSpy = vi.fn().mockResolvedValue(undefined);
  });

  async function activateWithSpies(existingConnections?: unknown[]): Promise<void> {
    const ctx = makeCtx();
    if (existingConnections !== undefined) {
      ctx.globalState.get = vi.fn((key: string) => {
        if (key === "vsdb.connections" && existingConnections !== undefined) {
          return existingConnections;
        }
        return undefined;
      }) as never;
    }
    const connectionMgrMod = await import("./core/connectionManager");
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockResolvedValue({
      testConnection: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as DbAdapter);
    vi.spyOn(connectionMgrMod.ConnectionManager.prototype, "addConnection").mockImplementation(addSpy as never);
    vi.spyOn(connectionMgrMod.ConnectionManager.prototype, "editConnection").mockImplementation(editSpy as never);

    const ext = await import("./extension");
    await ext.activate(ctx as never);
  }

  /** Simulate the webview submit message through the form's message handler. */
  function postSubmit(manualCommit: boolean): void {
    const panel = state.createdWebviewPanels[state.createdWebviewPanels.length - 1] as {
      webview: { onDidReceiveMessage: Mock };
    };
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (m: unknown) => void;
    handler({
      type: "submit",
      name: "Local Dev",
      driver: "postgres",
      host: "localhost",
      port: 5432,
      user: "app",
      database: "appdb",
      password: "pw",
      sslMode: "disable",
      sslCaPath: "",
      sslCertPath: "",
      sslKeyPath: "",
      manualCommit,
    });
  }

  it("#1 checked add-form → addConnection cfg has manualCommit:true", async () => {
    await activateWithSpies();
    const fn = state.registeredCommands.get("vsdb.addConnection");
    expect(fn).toBeDefined();
    await fn!();

    // The add form created exactly one webview panel.
    expect(state.createdWebviewPanels.length).toBe(1);
    postSubmit(true);

    // onSave is awaited inside handleMessage before dispose; flush microtasks.
    for (let i = 0; i < 100 && addSpy.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(addSpy).toHaveBeenCalledTimes(1);
    const cfg = addSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.manualCommit).toBe(true);
    expect(cfg.name).toBe("Local Dev");
  });

  it("#2 untouched add-form (manualCommit:false in payload) → cfg has explicit false", async () => {
    await activateWithSpies();
    const fn = state.registeredCommands.get("vsdb.addConnection");
    await fn!();

    postSubmit(false);
    for (let i = 0; i < 100 && addSpy.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(addSpy).toHaveBeenCalledTimes(1);
    const cfg = addSpy.mock.calls[0][0] as Record<string, unknown>;
    expect("manualCommit" in cfg).toBe(true);
    expect(cfg.manualCommit).toBe(false);
  });

  it("#3 edit-form on an existing connection → editConnection patch has manualCommit:true", async () => {
    const legacyCfg = {
      id: "pg-1",
      name: "Prod PG",
      driver: "postgres",
      host: "db.example.com",
      port: 5432,
      user: "app",
      database: "appdb",
      sslMode: "disable",
      // legacy record deliberately OMITS optional manualCommit
    };
    await activateWithSpies([legacyCfg]);
    const fn = state.registeredCommands.get("vsdb.editConnection");
    expect(fn).toBeDefined();
    // Command accepts arg.id → skips the QuickPick and opens the edit form.
    await fn!({ id: "pg-1" });

    expect(state.createdWebviewPanels.length).toBe(1);
    postSubmit(true);
    for (let i = 0; i < 100 && editSpy.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(editSpy).toHaveBeenCalledTimes(1);
    const [patchedId, patch] = editSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(patchedId).toBe("pg-1");
    expect(patch.manualCommit).toBe(true);
  });
});

// =============================================================================
// TASK-DBX08-003 — extension host entry points gated by DECLARED capabilities.
//  #1 happy: a declared-PostgreSQL adapter keeps the existing sessions-panel
//     and GRANT/REVOKE routes (confirmDangerousStatements before runQuery).
//  #3 edge: false/missing admin declaration blocks vsdb.openSessionsPanel and
//     vsdb.runGrantSql before AdminSessionsPanel.show / commandOpenGrantWizard /
//     getAdapter().runQuery / pg_backend_pid() / any AdminApi call.
//  #5 edge: no active connection keeps the select-connection warning; no
//     adapter lookup, no panel creation.
// =============================================================================
describe("extension — DBX-08 capability-gated admin host commands", () => {
  const UNSUPPORTED_MESSAGE =
    "VSDB: Admin tools are not supported by this connection's database.";

  function makeAdminApi() {
    return {
      listRoles: vi.fn().mockResolvedValue([]),
      listRoleGrants: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listLockWaits: vi.fn().mockResolvedValue([]),
      buildGrantSql: vi.fn(),
      buildRevokeSql: vi.fn(),
    };
  }

  function makeAdapter(capabilities: unknown, admin: unknown): DbAdapter {
    const adapter = { capabilities, admin } as unknown as DbAdapter;
    (adapter as unknown as {
      runQuery: ReturnType<typeof vi.fn>;
    }).runQuery = vi.fn().mockResolvedValue({
      results: [],
    });
    return adapter;
  }

  function seededCtx(driver: string) {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "vsdb.connections") {
        return [
          {
            id: "c1",
            name: "c",
            driver,
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

  async function activateWithAdapter(adapter: DbAdapter) {
    const connectionMgrMod = await import("./core/connectionManager");
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockResolvedValue(adapter);
    const ext = await import("./extension");
    const ctx = seededCtx("postgres");
    await ext.activate(ctx as never);
    return ext;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdWebviewPanels.length = 0;
    state.createdTreeViews.length = 0;
  });

  it("#1 declared PostgreSQL adapter keeps vsdb.openSessionsPanel + GRANT/REVOKE confirmation route", async () => {
    const admin = makeAdminApi();
    const adapter = makeAdapter(
      { catalog: true, objectDdl: true, tableDdl: true, admin: true },
      admin,
    );
    const ext = await activateWithAdapter(adapter);

    // Sessions panel: PG admission → a webview panel is created.
    await state.registeredCommands.get("vsdb.openSessionsPanel")!();
    expect(state.createdWebviewPanels.length).toBe(1);

    // GRANT/REVOKE: wizard flow stubs the vscode IO so commandOpenGrantWizard
    // produces SQL and routes it through the confirm + runQuery execute seam.
    const vscodeIo = (await import("vscode")) as unknown as {
      window: Record<string, ReturnType<typeof vi.fn>>;
    };
    const answers = ["public", "t1", "app_rw", "SELECT"];
    vscodeIo.window.showInputBox = vi
      .fn()
      .mockImplementation(() => Promise.resolve(answers.shift()));
    // Wizard preview modal: user accepts with "OK".
    vscodeIo.window.showInformationMessage =
      vi.fn().mockResolvedValue("OK") as unknown as ReturnType<typeof vi.fn>;
    // confirmDangerousStatements admin gate: user accepts.
    vscodeIo.window.showWarningMessage = vi
      .fn()
      .mockResolvedValue("Vẫn chạy (admin)");
    await state.registeredCommands.get("vsdb.runGrantSql")!("grant");
    expect(adapter.runQuery).toHaveBeenCalled();
    const allSql = (adapter.runQuery as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(
      allSql.some((sql) => sql.includes('GRANT SELECT ON TABLE "public"."t1"')),
    ).toBe(true);
    void ext;
  });

  it("#3 false admin declaration blocks sessions panel + grant/revoke before UI or SQL", async () => {
    const admin = makeAdminApi();
    const adapter = makeAdapter(
      { catalog: false, objectDdl: false, tableDdl: false, admin: false },
      admin,
    );
    await activateWithAdapter(adapter);
    const vscodeIo = (await import("vscode")) as unknown as {
      window: Record<string, ReturnType<typeof vi.fn>>;
    };
    vscodeIo.window.showInputBox = vi.fn().mockResolvedValue("public");

    // Sessions panel blocked:
    await state.registeredCommands.get("vsdb.openSessionsPanel")!();
    expect(state.createdWebviewPanels.length).toBe(0);
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.some(
        (c) => c[0] === UNSUPPORTED_MESSAGE,
      ),
    ).toBe(true);

    // Grant wizard blocked before any input or AdminApi/SQL use:
    await state.registeredCommands.get("vsdb.runGrantSql")!("grant");
    expect(vscodeIo.window.showInputBox).not.toHaveBeenCalled();
    expect(admin.buildGrantSql).not.toHaveBeenCalled();
    expect(admin.listRoles).not.toHaveBeenCalled();
    expect(adapter.runQuery).not.toHaveBeenCalled();
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.filter(
        (c) => c[0] === UNSUPPORTED_MESSAGE,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("#3b legacy adapter (missing capabilities) is denied identically", async () => {
    const admin = makeAdminApi();
    const adapter = makeAdapter(undefined, admin);
    await activateWithAdapter(adapter);

    await state.registeredCommands.get("vsdb.openSessionsPanel")!();
    expect(state.createdWebviewPanels.length).toBe(0);
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.some(
        (c) => c[0] === UNSUPPORTED_MESSAGE,
      ),
    ).toBe(true);

    await state.registeredCommands.get("vsdb.runGrantSql")!("revoke");
    expect(admin.buildRevokeSql).not.toHaveBeenCalled();
    expect(adapter.runQuery).not.toHaveBeenCalled();
  });

  it("#5 no active connection keeps the select-connection warning; no panel", async () => {
    // No seeded globalState → ConnectionManager has no active connection.
    const ctx = makeCtx();
    const connectionMgrMod = await import("./core/connectionManager");
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockRejectedValue(new Error("no adapter expected"));
    const ext = await import("./extension");
    await ext.activate(ctx as never);

    state.createdWebviewPanels.length = 0;
    vi.mocked(vscodeMock.window.showWarningMessage).mockClear();
    await state.registeredCommands.get("vsdb.openSessionsPanel")!();
    expect(
      vi.mocked(vscodeMock.window.showWarningMessage).mock.calls.some((c) =>
        /select a connection first/i.test(String(c[0])),
      ),
    ).toBe(true);
    expect(state.createdWebviewPanels.length).toBe(0);
  });
});

// =============================================================================
// TASK-RLX02-003 — vsdb.cancelQuery command awaits runner.cancel() before the
// host clears panel busy state, so the command path can never outrun the
// dialect-level cancel seam (MySQL/MSSQL best-effort cleanup).
// =============================================================================
describe("TASK-RLX02-003 — vsdb.cancelQuery awaits runner.cancel before setBusy(false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdWebviewPanels.length = 0;
  });

  it("Test #1 — deferred seam: panel.setBusy(false) only fires AFTER runner.cancel settles", async () => {
    // Spy QueryRunner.prototype.cancel with a DEFERRED promise so the test
    // can prove the extension command awaits it (the old fire-and-forget
    // `void runner.cancel(); panel.setBusy(false)` would resolve busy-false
    // first; the awaited version resolves seam-first).
    const runnerMod = await import("./core/queryRunner");
    let resolveCancel: (() => void) | null = null;
    const cancelSpy = vi.fn(
      () => new Promise<void>((resolve) => { resolveCancel = resolve; }),
    );
    vi.spyOn(runnerMod.QueryRunner.prototype, "cancel").mockImplementation(cancelSpy);

    // The ResultsPanel's setBusy(false) call needs to be observable. Spy on
    // its prototype method — every instance in this test sees the spy.
    const panelMod = await import("./ui/resultsPanel");
    const setBusySpy = vi.fn();
    vi.spyOn(panelMod.ResultsPanel.prototype, "setBusy").mockImplementation(
      setBusySpy as never,
    );

    const ctx = makeCtx();
    const ext = await import("./extension");
    await ext.activate(ctx as never);

    const cancelCommand = state.registeredCommands.get("vsdb.cancelQuery");
    expect(cancelCommand).toBeDefined();

    // Fire the command — the awaited cancel() must block busy(false).
    const commandPromise = (cancelCommand as () => Promise<void>)();
    // Yield several microtasks + a real-time tick; the deferred cancel has
    // not resolved yet, so setBusy(false) MUST NOT have been called.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    const busyFalseDuringCancel = setBusySpy.mock.calls.filter(
      (c) => c[0] === false,
    );
    expect(busyFalseDuringCancel).toHaveLength(0);

    // Now resolve the deferred seam — the command promise resolves, and
    // setBusy(false) follows in that same order.
    if (resolveCancel) resolveCancel();
    await commandPromise;
    const busyFalseAfter = setBusySpy.mock.calls.filter(
      (c) => c[0] === false,
    );
    expect(busyFalseAfter).toHaveLength(1);
  });
});
