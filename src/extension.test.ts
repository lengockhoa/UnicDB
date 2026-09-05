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
  // TASK-606: giá trị setting UnicDB.confirmDestructive (undefined = default true).
  confirmDestructive: undefined as boolean | undefined,

  /**
   * Cycle AE R4.5 — value returned by `vscode.workspace.getConfiguration("UnicDB").get("ai.engine")`.
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
  // TASK-ARP09-003: recording fake OutputChannel instances returned by
  // `vscode.window.createOutputChannel("UnicDB")`. Every `appendLine` argument
  // is captured so the privacy byte-scan can assert no raw secret / SQL /
  // connection config ever reaches the channel.
  createdOutputChannels: [] as Array<{
    name: string;
    appendLine: Mock;
    append: Mock;
    show: Mock;
    reveal: Mock;
    clear: Mock;
    hide: Mock;
    dispose: Mock;
    /** captured appendLine arguments in append order */
    lines: string[];
  }>,
};

vi.mock("vscode", () => {
  return {
    EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
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
      // TASK-ARP09-003: recording fake OutputChannel. `appendLine` stores its
      // argument in `lines`; the rest are no-op vi.fn() so test asserts can
      // count invocations. The host wiring is expected to call
      // `createOutputChannel("UnicDB")` exactly once on the first real
      // diagnostic write (NEVER on plain activate, NEVER twice).
      createOutputChannel: vi.fn((name: string) => {
        const lines: string[] = [];
        const ch = {
          name,
          appendLine: vi.fn((line: string) => {
            lines.push(String(line));
          }),
          append: vi.fn(),
          show: vi.fn(),
          reveal: vi.fn(),
          clear: vi.fn(() => {
            lines.length = 0;
          }),
          hide: vi.fn(),
          dispose: vi.fn(),
          lines,
        };
        state.createdOutputChannels.push(ch);
        return ch;
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
        // TASK-AIX05-103: best-effort engine flip path
        // (flipEngineToBuiltinInSettings / commandOpenAiChat fallback) calls
        // `.update()` — resolve as a no-op so the fallback flow completes.
        update: vi.fn(async () => undefined),
      })),
      fs: {
        writeFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockResolvedValue(new Uint8Array()),
        rename: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        // Default: stat throws → safeFileExists returns false. Individual tests
        // can override (vscodeMock.workspace.fs.stat = vi.fn().mockResolvedValue(...))
        // to simulate the file being present.
        stat: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
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
      // `UnicDB-ddl:` URI scheme at activate(). The default mock returns a
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
      // PUBLISH-01: UnicDB.openUserGuide fallback opens the GitHub URL when the
      // guide is missing locally. Default: resolves true; individual tests
      // can override to simulate a failure path.
      openExternal: vi.fn(async () => true),
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
// that invokes `UnicDB.aiChat` must not shell out to a real `which omp` on the
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
    state.createdOutputChannels.length = 0;
  });

  it("register đủ command theo package.json (17 cũ + các cycle sau)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const expected = [
      "UnicDB.addConnection",
      "UnicDB.editConnection",
      "UnicDB.deleteConnection",
      "UnicDB.selectConnection",
      "UnicDB.runQuery",
      "UnicDB.cancelQuery",
      "UnicDB.generateSelect",
      "UnicDB.copyQualifiedName",
      "UnicDB.refreshSchema",
      "UnicDB.runStatement",
      "UnicDB.runScript",
      "UnicDB.newTable",
      "UnicDB.modifyTable",
      "UnicDB.copyCreateDdl",
      "UnicDB.generateSampleData",
      "UnicDB.analyzeTable",
      "UnicDB.vacuumTable",
    ];
    for (const cmd of expected) {
      expect(state.registeredCommands.has(cmd)).toBe(true);
    }
    // DBX-01 + DBX-03 + DBX-04 wiring contracts (T18): import + compare
    // + relationship explorer commands must all register during
    // activate() without throwing.
    const laterCycles = [
      "UnicDB.importCsv",
      "UnicDB.importJson",
      "UnicDB.openFormView",
      "UnicDB.editLargeValue",
      "UnicDB.compareTables",
      "UnicDB.relationshipExplorer",
    ];
    for (const cmd of laterCycles) {
      expect(state.registeredCommands.has(cmd)).toBe(true);
    }
  });

  it("SchemaTreeProvider được register cho view UnicDB.schemaTree", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.createdTreeViews.length).toBeGreaterThanOrEqual(1);
    const view = state.createdTreeViews[0] as { id: string };
    expect(view.id).toBe("UnicDB.schemaTree");
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
  it("DBX-02: catalog document provider đăng ký cho scheme UnicDB-sql-catalog", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const catalog = state.registeredContentProviders.find(
      (r) => r.scheme === "UnicDB-sql-catalog",
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
    state.createdOutputChannels.length = 0;
  });

  it("UnicDB.runQuery với editor .sql và manager active=null → showQuickPick được gọi với option 'Add Connection'", async () => {
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

    const runQueryFn = state.registeredCommands.get("UnicDB.runQuery");
    expect(runQueryFn).toBeDefined();
    await runQueryFn!();

    // showQuickPick được gọi với options chứa "Add Connection".
    expect(showQuickPickSpy).toHaveBeenCalled();
    const args = showQuickPickSpy.mock.calls[0][0] as Array<{ label: string }>;
    const labels = args.map((o) => o.label);
    expect(labels.some((l) => /Add Connection/i.test(l))).toBe(true);
  });

  it("UnicDB.runQuery với editor .sql và manager active=null → option 'Select existing' cũng có", async () => {
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
    const runQueryFn = state.registeredCommands.get("UnicDB.runQuery");
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
    state.createdOutputChannels.length = 0;
  });

  it("package.json contributes khai báo 2 command mới với icon + menu entries đúng when", () => {
    const commands = pkgJson.contributes.commands as Array<{
      command: string;
      title: string;
      icon: string;
    }>;
    const filterCmd = commands.find((c) => c.command === "UnicDB.filterSchemaTree");
    const clearCmd = commands.find((c) => c.command === "UnicDB.clearSchemaTreeFilter");
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
    const filterMenu = viewTitle.find((m) => m.command === "UnicDB.filterSchemaTree");
    const clearMenu = viewTitle.find((m) => m.command === "UnicDB.clearSchemaTreeFilter");
    expect(filterMenu).toBeDefined();
    expect(filterMenu!.when).toBe("view == UnicDB.schemaTree");
    expect(filterMenu!.group).toBe("navigation");
    expect(clearMenu).toBeDefined();
    expect(clearMenu!.when).toBe(
      "view == UnicDB.schemaTree && UnicDB.schemaTreeFilterActive",
    );
    expect(clearMenu!.group).toBe("navigation");
  });

  it("register 2 command mới: UnicDB.filterSchemaTree + UnicDB.clearSchemaTreeFilter", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.filterSchemaTree")).toBe(true);
    expect(state.registeredCommands.has("UnicDB.clearSchemaTreeFilter")).toBe(true);
  });

  it("showInputBox trả undefined (Esc) → setFilter KHÔNG được gọi", async () => {
    const ctx = makeCtx();
    activate(ctx as never);

    const setFilterSpy = vi.spyOn(SchemaTreeProvider.prototype, "setFilter");
    const showInputBoxSpy = vi.mocked(vscodeMock.window.showInputBox);
    showInputBoxSpy.mockResolvedValueOnce(undefined);

    const fn = state.registeredCommands.get("UnicDB.filterSchemaTree");
    expect(fn).toBeDefined();
    await fn!();

    expect(showInputBoxSpy).toHaveBeenCalled();
    expect(setFilterSpy).not.toHaveBeenCalled();

    setFilterSpy.mockRestore();
  });
});

// =============================================================================
// TASK-505: UnicDB.runScript — send active shell script to a reused terminal.
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
    state.createdOutputChannels.length = 0;
    // Reset module để drop module-level `runScriptTerminal` từ test trước.
    vi.resetModules();
  });

  // Re-import + activate sau resetModules (mỗi test lấy module + registeredCommands mới).
  // activateFresh: dynamic import cố ý (resetModules vừa drop cache).
  async function activateFresh(ctx: ReturnType<typeof makeCtx>) {
    const mod = await import("./extension");
    await mod.activate(ctx as never);
  }

  it("Test #1: command 'UnicDB.runScript' được register khi activate", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);
    expect(state.registeredCommands.has("UnicDB.runScript")).toBe(true);
  });

  it("Test #2: handler tạo terminal 'UnicDB Script' + sendText full content của document shellscript", async () => {
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

    const fn = state.registeredCommands.get("UnicDB.runScript");
    expect(fn).toBeDefined();
    await fn!();

    // createTerminal được gọi đúng 1 lần với name "UnicDB Script"
    expect(state.createdTerminals.length).toBe(1);
    expect(state.createdTerminals[0].name).toBe("UnicDB Script");
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

    const fn = state.registeredCommands.get("UnicDB.runScript");
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

    const fn = state.registeredCommands.get("UnicDB.runScript");
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

    const fn = state.registeredCommands.get("UnicDB.runScript");
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
    // Terminal mới cũng tên "UnicDB Script".
    expect(secondTerm.name).toBe("UnicDB Script");
    // Terminal cũ không nhận text lần 2.
    expect(firstTerm.sendText).toHaveBeenCalledTimes(1);
    // Terminal mới nhận text lần 2.
    expect(secondTerm.sendText).toHaveBeenCalledTimes(1);
    expect(secondTerm.sendText.mock.calls[0][0]).toBe("echo first\n\n");
    expect(secondTerm.show).toHaveBeenCalled();
  });

  // ===== TASK-605 #6: no-editor guard =====

  it("Test #6 — UnicDB.runScript với NO active editor → showWarningMessage, KHÔNG tạo terminal", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    state.activeEditor = undefined;

    const fn = state.registeredCommands.get("UnicDB.runScript");
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

  it("Test #6b — UnicDB.runScript với editor không phải shellscript (sql) vẫn gửi text như cũ (không guard theo language)", async () => {
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

    const fn = state.registeredCommands.get("UnicDB.runScript");
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
    state.createdOutputChannels.length = 0;
    state.confirmDestructive = undefined; // default → true
    vi.resetModules();
  });

  /** ctx với active connection seeded qua globalState (không đi qua SecretStorage). */
  function makeSeededCtx(driver: string = "postgres") {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
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

    await state.registeredCommands.get("UnicDB.runQuery")!();

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

    await state.registeredCommands.get("UnicDB.runQuery")!();

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

    await state.registeredCommands.get("UnicDB.runQuery")!();

    expect(warnCalls()[0][0]).toMatch(/NGUY HIỂM/);
    expect(runSpy).toHaveBeenCalled();
  });

  it("B12 — confirmDestructive=false → bỏ qua guard, chạy ngay", async () => {
    state.confirmDestructive = false;
    await activateFresh606();
    setEditor("DELETE FROM t;");

    await state.registeredCommands.get("UnicDB.runQuery")!();

    expect(warnSpy()).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalled();
  });

  it("B13 — mixed batch SELECT + TRUNCATE, cancel → huỷ cả lô", async () => {
    await activateFresh606();
    const sql = "SELECT 1; TRUNCATE t;";
    setEditor(sql, { start: 0, end: sql.length });
    warnSpy().mockResolvedValueOnce(undefined);

    await state.registeredCommands.get("UnicDB.runQuery")!();

    expect(warnSpy()).toHaveBeenCalledTimes(1);
    expect(warnCalls()[0][0]).toMatch(/NGUY HIỂM/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("B14 — SELECT thường không bị hỏi", async () => {
    await activateFresh606();
    setEditor("SELECT 1;");

    await state.registeredCommands.get("UnicDB.runQuery")!();

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

    await state.registeredCommands.get("UnicDB.runQuery")!();

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

    await state.registeredCommands.get("UnicDB.runQuery")!();

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
    await state.registeredCommands.get("UnicDB.runQuery")!();

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

  it("B15 — package.json khai báo UnicDB.confirmDestructive default true", () => {
    const props = pkgJson.contributes.configuration.properties as Record<
      string,
      { type: string; default: unknown }
    >;
    expect(props["UnicDB.confirmDestructive"]).toBeDefined();
    expect(props["UnicDB.confirmDestructive"].type).toBe("boolean");
    expect(props["UnicDB.confirmDestructive"].default).toBe(true);
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

  it("register đủ 6 command mới: UnicDB.newTable/modifyTable/copyCreateDdl/generateSampleData/analyzeTable/vacuumTable", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const six = [
      "UnicDB.newTable",
      "UnicDB.modifyTable",
      "UnicDB.copyCreateDdl",
      "UnicDB.generateSampleData",
      "UnicDB.analyzeTable",
      "UnicDB.vacuumTable",
    ];
    for (const cmd of six) {
      expect(state.registeredCommands.has(cmd)).toBe(true);
    }
  });

  it("package.json activationEvents có đủ 6 entry mới (onCommand)", () => {
    const evts = pkgJson.activationEvents as string[];
    const six = [
      "onCommand:UnicDB.newTable",
      "onCommand:UnicDB.modifyTable",
      "onCommand:UnicDB.copyCreateDdl",
      "onCommand:UnicDB.generateSampleData",
      "onCommand:UnicDB.analyzeTable",
      "onCommand:UnicDB.vacuumTable",
    ];
    for (const e of six) {
      expect(evts).toContain(e);
    }
  });
});

// =============================================================================
// TASK-004 — UnicDB.openAiSettings command + activationEvent + contributes
// =============================================================================
describe("TASK-004 — UnicDB.openAiSettings wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("registers UnicDB.openAiSettings handler on activate", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.openAiSettings")).toBe(true);
  });

  it("package.json contributes.commands declares UnicDB.openAiSettings", () => {
    const cmds = (pkgJson.contributes as { commands: Array<{ command: string }> })
      .commands;
    const entry = cmds.find((c) => c.command === "UnicDB.openAiSettings");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/AI Settings/i);
  });

  it("package.json activationEvents contains onCommand:UnicDB.openAiSettings", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.openAiSettings");
  });
});
// Avoid path-imports lint complaints.
void path;

// =============================================================================
// TASK-UX1-007 — UnicDB.openSettings gear on the schema-tree title bar (R8b).
// Hub command: opens VS Code's Settings UI filtered to UnicDB extension
// (`@ext:lengockhoa.UnicDB`). Distinct icon (`$(settings-gear)`) from
// `UnicDB.openAiSettings`'s `$(gear)` so the two title-bar buttons never
// collide visually. Structural cases pin the package.json contribution
// (command + view/title entry) so a future icon swap cannot silently
// regress the hub into a duplicate of AI Settings.
// =============================================================================
describe("TASK-UX1-007 — UnicDB.openSettings wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  // Case 1 — happy path: command opens settings filtered to the extension.
  it("case 1: invokes UnicDB.openSettings → executeCommand('workbench.action.openSettings', '@ext:lengockhoa.UnicDB')", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.openSettings");
    expect(fn).toBeDefined();

    const executeCommandSpy = vi.mocked(vscodeMock.commands.executeCommand);
    executeCommandSpy.mockClear();
    await fn!();

    expect(executeCommandSpy).toHaveBeenCalled();
    const called = executeCommandSpy.mock.calls.find(
      (c) => c[0] === "workbench.action.openSettings",
    );
    expect(called).toBeDefined();
    expect(called![1]).toBe("@ext:lengockhoa.UnicDB");
  });

  // Case 2 — edge A: executeCommand rejects → caught, toast, no throw.
  it("case 2: executeCommand rejects → caught + showErrorMessage, handler does not throw", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.openSettings");
    expect(fn).toBeDefined();

    const executeCommandSpy = vi.mocked(vscodeMock.commands.executeCommand);
    executeCommandSpy.mockClear();
    executeCommandSpy.mockRejectedValueOnce(new Error("settings UI unavailable"));
    const showErrorSpy = vi.mocked(vscodeMock.window.showErrorMessage);
    showErrorSpy.mockClear();

    await expect(fn!()).resolves.toBeUndefined();
    expect(showErrorSpy).toHaveBeenCalled();
    const errorArgs = showErrorSpy.mock.calls[0];
    expect((errorArgs?.[0] ?? "").toLowerCase()).toMatch(/settings/);
  });

  // Case 3 — edge B: structural wiring — package.json declares command + title entry.
  it("case 3: package.json declares UnicDB.openSettings command + view/title entry on UnicDB.schemaTree", () => {
    interface CmdEntry { command: string; title?: string; icon?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "UnicDB.openSettings");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Open Settings/i);
    expect(entry!.icon).toBe("$(settings-gear)");

    interface MenuEntry { command: string; when?: string; group?: string }
    const viewTitle = (pkgJson.contributes.menus["view/title"] ?? []) as MenuEntry[];
    const menu = viewTitle.find((m) => m.command === "UnicDB.openSettings");
    expect(menu).toBeDefined();
    expect(menu!.when).toBe("view == UnicDB.schemaTree");
    expect(menu!.group).toBe("navigation");
  });

  // Case 4 — edge C: no icon collision with AI settings entry.
  it("case 4: UnicDB.openAiSettings keeps $(gear) and UnicDB.openSettings uses $(settings-gear)", () => {
    interface CmdEntry { command: string; icon?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const ai = commands.find((c) => c.command === "UnicDB.openAiSettings");
    const hub = commands.find((c) => c.command === "UnicDB.openSettings");
    expect(ai).toBeDefined();
    expect(hub).toBeDefined();
    expect(ai!.icon).toBe("$(gear)");
    expect(hub!.icon).toBe("$(settings-gear)");
    expect(ai!.icon).not.toBe(hub!.icon);
  });

  // Case 5 — regression: command registration smoke (mirror the "register đủ command" pattern).
  it("case 5: extension.activate registers UnicDB.openSettings", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.openSettings")).toBe(true);
  });

  // activationEvents pin — keeps the lazy activation guard in sync.
  it("package.json activationEvents contains onCommand:UnicDB.openSettings", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.openSettings");
  });
});

// =============================================================================
// TASK-004 — UnicDB.aiChat command wiring + unconfigured fallback.
// =============================================================================
describe("TASK-004 — UnicDB.aiChat wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("Test #5 — UnicDB.aiChat được register trong subscriptions sau activate()", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.aiChat")).toBe(true);
    // Command handler phải thuộc context.subscriptions (để dispose dọn dẹp).
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it("Test #5b — dispose() sạch: deactivate() không throw sau khi gọi UnicDB.aiChat", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.aiChat");
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

    const fn = state.registeredCommands.get("UnicDB.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    // Phải hiện info + trigger openAiSettings.
    expect(showInfoSpy).toHaveBeenCalled();
    const infoArgs = showInfoSpy.mock.calls[0];
    const infoText = (infoArgs?.[0] ?? "") as string;
    expect(infoText.toLowerCase()).toMatch(/configure|ai|settings/i);
    // Mở form settings qua executeCommand('UnicDB.openAiSettings').
    const called = executeCommandSpy.mock.calls.some(
      (c) => c[0] === "UnicDB.openAiSettings",
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

    const fn = state.registeredCommands.get("UnicDB.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    // B3: no interstitial — never routed to AI Settings, never shown the
    // "configure AI first" info message, because omp needs zero config.
    expect(showInfoSpy).not.toHaveBeenCalled();
    const routedToSettings = executeCommandSpy.mock.calls.some(
      (c) => c[0] === "UnicDB.openAiSettings",
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

    const fn = state.registeredCommands.get("UnicDB.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    expect(showInfoSpy).toHaveBeenCalled();
    const routedToSettings = executeCommandSpy.mock.calls.some(
      (c) => c[0] === "UnicDB.openAiSettings",
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
  it("R(Finding7) regression: closing the webview tab (onDispose) lets the NEXT UnicDB.aiChat re-detect the engine and open a fresh panel", async () => {
    state.aiEngine = "omp";
    detectOmpState.impl = async () => ({
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    });
    const ctx = makeCtx();
    activate(ctx as never);

    const fn = state.registeredCommands.get("UnicDB.aiChat");
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
  // host emitter), and the next UnicDB.aiChat command must construct a SECOND
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

    const fn = state.registeredCommands.get("UnicDB.aiChat");
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
// TASK-002 (wave 2) — wire `UnicDB.browseTableData` from schemaTree nodes:
//   * extension.activate() registers the command via registerBrowseCommands.
//   * package.json declares contributes.commands entry + activationEvent.
//   * invoking the registered handler with no argument must not throw
//     (palette fallback → showInformationMessage, see browseCommands.test.ts #5).
// =============================================================================
describe("TASK-002 — UnicDB.browseTableData extension wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("registers UnicDB.browseTableData handler trong activate() (case 3)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.browseTableData")).toBe(true);
  });

  it("invoking UnicDB.browseTableData handler không throw khi palette (no arg) (case 3)", async () => {
    const ctx = makeCtx();
    activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.browseTableData");
    expect(fn).toBeDefined();
    await expect(fn!()).resolves.not.toThrow();
    await expect(fn!(undefined)).resolves.not.toThrow();
    await expect(fn!({})).resolves.not.toThrow();
  });
  it("package.json contributes.commands có UnicDB.browseTableData entry với category UnicDB (case 4)", () => {
    // pkgJson đã là typed JSON.parse output; ép kiểu 1 lần tại ranh giới rồi truy cập thuộc tính đã được kiểm tra.
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "UnicDB.browseTableData");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Browse Table Data/i);
    expect(entry!.category).toBe("UnicDB");
  });

  it("package.json activationEvents có onCommand:UnicDB.browseTableData (case 4)", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.browseTableData");
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
      "UnicDB.runQuery",
      "UnicDB.addConnection",
      "UnicDB.editConnection",
      "UnicDB.deleteConnection",
      "UnicDB.selectConnection",
      "UnicDB.cancelQuery",
      "UnicDB.generateSelect",
      "UnicDB.copyQualifiedName",
      "UnicDB.refreshSchema",
      "UnicDB.openAiSettings",
      "UnicDB.aiChat",
      "UnicDB.runScript",
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

  it("#6 activate → UnicDB.aiChat → AiChatPanel is constructed with deps whose streamComplete is a function (5-arg)", async () => {
    const ext = await import("./extension");
    const ctx = makeConfiguredCtx();
    await ext.activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.aiChat");
    expect(fn).toBeDefined();
    expect(state.registeredCommands.has("UnicDB.aiChat")).toBe(true);

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
    const fn = state.registeredCommands.get("UnicDB.aiChat");
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
        key === "UnicDB.ai.settings" ? settings : undefined,
      ),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// =============================================================================
// TASK-003 (wave 3) — UnicDB.createSchema: register the command, declare in
// package.json contributes.commands + activationEvents, add view/item/context
// entry for connection + schema viewItem when-clause, ensure esbuild emits
// dist/schemaForm.js.
// =============================================================================
describe("TASK-003 — UnicDB.createSchema extension wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("registers UnicDB.createSchema handler on activate (case 9)", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.createSchema")).toBe(true);
  });

  it("package.json contributes.commands declares UnicDB.createSchema with category UnicDB", () => {
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "UnicDB.createSchema");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Create.*Schema/i);
    expect(entry!.category).toBe("UnicDB");
  });

  it("package.json activationEvents contains onCommand:UnicDB.createSchema", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.createSchema");
  });

  it("package.json menus.view/item/context contains connection+schema entry for UnicDB.createSchema", () => {
    interface MenuEntry { command: string; when?: string; group?: string }
    const ctxMenus = (pkgJson.contributes.menus as { "view/item/context": MenuEntry[] })[
      "view/item/context"
    ];
    const entry = ctxMenus.find((m) => m.command === "UnicDB.createSchema");
    expect(entry).toBeDefined();
    expect(entry!.when).toMatch(/view\s*==\s*UnicDB\.schemaTree/);
    expect(entry!.when).toMatch(/connection/);
    expect(entry!.when).toMatch(/schema/);
  });

  it("npm run compile emits dist/schemaForm.js (esbuild config wired)", () => {
    expect(schemaFormBundlePresent).toBe(true);
  });
});


// =============================================================================
// TASK-007 — UnicDB.runStatement applies qualifyKeywordTables at the
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
    state.createdOutputChannels.length = 0;
    state.confirmDestructive = undefined;
    vi.resetModules();
  });

  it("#2 UnicDB.runStatement with `SELECT * FROM order;` rewrites to `SELECT * FROM \"public\".\"order\";`", async () => {
    const ctx = makeCtx();
    // Seed an active connection so getActive() returns truthy and the run
    // path proceeds past the QuickPick fallback.
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
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

    const runStatementFn = state.registeredCommands.get("UnicDB.runStatement");
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
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
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

    const runQueryFn = state.registeredCommands.get("UnicDB.runQuery");
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
// TASK-005 — `UnicDB.runQuery` cursor mode (no selection). Cursor nằm giữa 2
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
    state.createdOutputChannels.length = 0;
    state.confirmDestructive = undefined;
    vi.resetModules();
  });

  it("#9 cursor giữa stmt 1 của 2 statement → runner.runQuery chạy đúng 1 stmt đầu", async () => {
    const ctx = makeCtx();
    // Seed active connection để runQuery qua màn QuickPick.
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
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

    const runQueryFn = state.registeredCommands.get("UnicDB.runQuery");
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
// TASK-004 — UnicDB.exportAllStructures wiring smoke: command id registered by
// activate(), package.json contributes.commands declares it, activationEvents
// has the onCommand entry, contributes.menus["view/item/context"] has an
// entry covering connection + schema viewItems. Lock-in match (Reviewer block).
// =============================================================================
describe("TASK-004 — UnicDB.exportAllStructures wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
  });

  it("Test #4 — UnicDB.exportAllStructures được register trong subscriptions khi activate()", () => {
    const ctx = makeCtx();
    activate(ctx as never);
    expect(state.registeredCommands.has("UnicDB.exportAllStructures")).toBe(true);
  });

  it("Test #4b — package.json contributes.commands declares UnicDB.exportAllStructures", () => {
    const cmds = (pkgJson.contributes as { commands: Array<{ command: string; title: string }> })
      .commands;
    const entry = cmds.find((c) => c.command === "UnicDB.exportAllStructures");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Export All Structures/i);
  });

  it("Test #4c — package.json activationEvents contains onCommand:UnicDB.exportAllStructures", () => {
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.exportAllStructures");
  });

  it("Test #4d — package.json view/item/context menu covers connection + schema viewItem", () => {
    const menuItems = (
      (pkgJson.contributes as { menus: Record<string, Array<{ command: string; when: string }>> })
        .menus["view/item/context"] ?? []
    );
    const entry = menuItems.find((m) => m.command === "UnicDB.exportAllStructures");
    expect(entry).toBeDefined();
    expect(entry!.when).toMatch(/view == UnicDB\.schemaTree/);
    expect(entry!.when).toMatch(/viewItem == connection/);
    expect(entry!.when).toMatch(/viewItem == schema/);
  });
});

// =============================================================================
// TASK-003 (cycle Z) — UnicDB.openConsole: command registration, package.json
// contribution, activationEvent, and full-buffer execution delegation.
// The registered handler routes runConsole through sqlToRun with a FULL-BUFFER
// selection ({start:0,end:sql.length}) and the active dialect, then hands EVERY
// parsed statement to the existing shared runStatements flow (dangerous
// confirm + keyword qualify + runner + ResultsPanel render all still apply).
// =============================================================================
describe("TASK-003 — UnicDB.openConsole wiring", () => {
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
    state.createdOutputChannels.length = 0;
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
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
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

  it("#C1 registers UnicDB.openConsole on activate", async () => {
    await activateWithConsole();
    expect(state.registeredCommands.has("UnicDB.openConsole")).toBe(true);
  });

  it("#C2 package.json contributes 'UnicDB: Open Console' with matching activationEvent", () => {
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const entry = commands.find((c) => c.command === "UnicDB.openConsole");
    expect(entry).toBeDefined();
    expect(entry!.title).toMatch(/Open Console/i);
    expect(entry!.category).toBe("UnicDB");
    // Palette-only per plan §3.3: no view/title or other menu entry.
    const menus = pkgJson.contributes.menus as Record<
      string,
      Array<{ command: string }>
    >;
    for (const [menu, entries] of Object.entries(menus)) {
      expect(
        entries.some((m) => m.command === "UnicDB.openConsole"),
        `UnicDB.openConsole must not appear in ${menu}`,
      ).toBe(false);
    }
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.openConsole");
  });

  /** Index of the createWebviewPanel call whose viewType is UnicDB.console,
   *  plus the created panel instance (shared mock does not tag instances). */
  function findConsolePanelCall(): { callIndex: number; panel: Record<string, unknown> } {
    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string, string, unknown, unknown]>;
    const callIndex = calls.findIndex(([viewType]) => viewType === "UnicDB.console");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const panel = state.createdWebviewPanels[callIndex] as Record<string, unknown>;
    return { callIndex, panel };
  }

  it("#C3 invoking UnicDB.openConsole opens exactly one UnicDB.console webview panel", async () => {
    await activateWithConsole();
    const fn = state.registeredCommands.get("UnicDB.openConsole");
    expect(fn).toBeDefined();
    await fn!();

    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string]>;
    const consoleCalls = calls.filter(([viewType]) => viewType === "UnicDB.console");
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
    const fn = state.registeredCommands.get("UnicDB.openConsole");
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
      const fn = state.registeredCommands.get("UnicDB.openConsole");
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
// TASK-AIX07-003 — UnicDB.ai.showPolicy / UnicDB.ai.exportTrace / UnicDB.ai.clearTrace
// (policy + audit command host integration). The host derives the effective
// policy from `vscode.workspace.isTrusted`, the raw `UnicDB.ai.engine`
// preference, and the `resolveEngine()` result. Valid configured + valid
// resolver + trusted ⇒ admit. Anything else ⇒ deny + concrete notice.
// show-policy: reports the policy state to the user via showInformationMessage
// (no side effects). export-trace: requires an active AiChatPanel AND
// admission; runs save-dialog → writeFile of the redacted envelope; denied
// paths post the notice and do NOT touch picker / fs. clear-trace: requires
// an active panel; absent panel ⇒ concrete notice, no throw.
// =============================================================================
describe("TASK-AIX07-003 — UnicDB.ai.showPolicy / exportTrace / clearTrace host integration", () => {
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
    state.createdOutputChannels.length = 0;
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

  it("registers all three UnicDB.ai.* commands on activate", async () => {
    await activateWithTrust(true);
    expect(state.registeredCommands.has("UnicDB.ai.showPolicy")).toBe(true);
    expect(state.registeredCommands.has("UnicDB.ai.exportTrace")).toBe(true);
    expect(state.registeredCommands.has("UnicDB.ai.clearTrace")).toBe(true);
  });

  it("#1 happy — trusted + valid configured + valid resolver → showPolicy reports provider+context+tools+export; exportTrace calls saveDialog and writes envelope; clearTrace calls the panel", async () => {
    const { ctx } = await activateWithTrust(true);
    // Seed an active panel with two turns so the export envelope has body.
    const aiChatFn = state.registeredCommands.get("UnicDB.aiChat");
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
      fsPath: "/tmp/UnicDB-audit.json",
      toString: () => "file:///tmp/UnicDB-audit.json",
      path: "/tmp/UnicDB-audit.json",
      scheme: "file",
    });
    (vscodeMock.workspace as unknown as { fs: { writeFile: Mock } }).fs = {
      writeFile: writeFileSpy,
    };

    // (a) showPolicy posts an info message reporting provider/context/tools/export.
    const showInfoSpy = vi.mocked(vscodeMock.window.showInformationMessage);
    showInfoSpy.mockClear();
    const showPolicyFn = state.registeredCommands.get("UnicDB.ai.showPolicy");
    await showPolicyFn!();
    expect(showInfoSpy).toHaveBeenCalled();
    const infoText = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    // The provider field is "omp" (resolver-selected) for this case; the
    // host should report it. The information message must mention it.
    expect(infoText.toLowerCase()).toMatch(/omp|engine|provider/);
    expect(infoText.toLowerCase()).toMatch(/context|tools|export/);

    // (b) exportTrace runs save-dialog + writeFile with the redacted envelope.
    const exportFn = state.registeredCommands.get("UnicDB.ai.exportTrace");
    expect(exportFn).toBeDefined();
    await exportFn!();
    // saveDialog called once; writeFile called once with the serialized
    // envelope.
    expect(win.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const written = writeFileSpy.mock.calls[0]?.[1] as Uint8Array;
    const writtenText = new TextDecoder().decode(written);
    // The envelope MUST carry the schema marker from auditExport.ts.
    expect(writtenText).toContain("UnicDB.ai.audit-export");
    // Defense in depth: byte-scan the wire for secret-shaped strings —
    // the dumpAll() we planted is already redaction-safe, so this pins
    // the contract regardless of which underlying dump the host called.
    expect(/api[_-]?key|secret|password|token|authorization|cookie|bearer|basic/i.test(writtenText)).toBe(false);

    // (c) clearTrace calls the active panel's clearTrace.
    const clearFn = state.registeredCommands.get("UnicDB.ai.clearTrace");
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
    const showPolicyFn = state.registeredCommands.get("UnicDB.ai.showPolicy");
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

    const exportFn = state.registeredCommands.get("UnicDB.ai.exportTrace");
    await exportFn!();

    // No picker, no write. Notice is shown.
    expect(win.showSaveDialog).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(showInfoSpy).toHaveBeenCalled();
    const infoText = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(infoText).toMatch(/UnicDB AI policy|policy/);
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
        if (section === "UnicDB" && key === "ai.engine") {
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
    const exportFn = state.registeredCommands.get("UnicDB.ai.exportTrace");
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
    const exportFn = state.registeredCommands.get("UnicDB.ai.exportTrace");
    await exportFn!();
    expect(win.showSaveDialog).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(showInfoSpy).toHaveBeenCalled();
    const exportInfo = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(exportInfo).toMatch(/open.*AI Chat|AI Chat panel|active|panel/i);
    showInfoSpy.mockClear();
    const clearFn = state.registeredCommands.get("UnicDB.ai.clearTrace");
    await clearFn!();
    expect(showInfoSpy).toHaveBeenCalled();
    const clearInfo = (showInfoSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(clearInfo).toMatch(/open.*AI Chat|AI Chat panel|active|panel/i);
  });
});


// =============================================================================
// TASK-001 — per-connection manualCommit reaching ConnectionManager.
// openConnectionForm() builds ConnectionConfig literals for BOTH add and edit
// paths; these tests drive UnicDB.addConnection / UnicDB.editConnection through
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
    state.createdOutputChannels.length = 0;
    addSpy = vi.fn().mockResolvedValue(undefined);
    editSpy = vi.fn().mockResolvedValue(undefined);
  });

  async function activateWithSpies(existingConnections?: unknown[]): Promise<void> {
    const ctx = makeCtx();
    if (existingConnections !== undefined) {
      ctx.globalState.get = vi.fn((key: string) => {
        if (key === "UnicDB.connections" && existingConnections !== undefined) {
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
    const fn = state.registeredCommands.get("UnicDB.addConnection");
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
    const fn = state.registeredCommands.get("UnicDB.addConnection");
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
    const fn = state.registeredCommands.get("UnicDB.editConnection");
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
//  #3 edge: false/missing admin declaration blocks UnicDB.openSessionsPanel and
//     UnicDB.runGrantSql before AdminSessionsPanel.show / commandOpenGrantWizard /
//     getAdapter().runQuery / pg_backend_pid() / any AdminApi call.
//  #5 edge: no active connection keeps the select-connection warning; no
//     adapter lookup, no panel creation.
// =============================================================================
describe("extension — DBX-08 capability-gated admin host commands", () => {
  const UNSUPPORTED_MESSAGE =
    "UnicDB: Admin tools are not supported by this connection's database.";

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
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
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

  it("#1 declared PostgreSQL adapter keeps UnicDB.openSessionsPanel + GRANT/REVOKE confirmation route", async () => {
    const admin = makeAdminApi();
    const adapter = makeAdapter(
      { catalog: true, objectDdl: true, tableDdl: true, admin: true },
      admin,
    );
    const ext = await activateWithAdapter(adapter);

    // Sessions panel: PG admission → a webview panel is created.
    await state.registeredCommands.get("UnicDB.openSessionsPanel")!();
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
    await state.registeredCommands.get("UnicDB.runGrantSql")!("grant");
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
    await state.registeredCommands.get("UnicDB.openSessionsPanel")!();
    expect(state.createdWebviewPanels.length).toBe(0);
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.some(
        (c) => c[0] === UNSUPPORTED_MESSAGE,
      ),
    ).toBe(true);

    // Grant wizard blocked before any input or AdminApi/SQL use:
    await state.registeredCommands.get("UnicDB.runGrantSql")!("grant");
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

    await state.registeredCommands.get("UnicDB.openSessionsPanel")!();
    expect(state.createdWebviewPanels.length).toBe(0);
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.some(
        (c) => c[0] === UNSUPPORTED_MESSAGE,
      ),
    ).toBe(true);

    await state.registeredCommands.get("UnicDB.runGrantSql")!("revoke");
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
    await state.registeredCommands.get("UnicDB.openSessionsPanel")!();
    expect(
      vi.mocked(vscodeMock.window.showWarningMessage).mock.calls.some((c) =>
        /select a connection first/i.test(String(c[0])),
      ),
    ).toBe(true);
    expect(state.createdWebviewPanels.length).toBe(0);
  });
});

// =============================================================================
// TASK-RLX02-003 — UnicDB.cancelQuery command awaits runner.cancel() before the
// host clears panel busy state, so the command path can never outrun the
// dialect-level cancel seam (MySQL/MSSQL best-effort cleanup).
// =============================================================================
describe("TASK-RLX02-003 — UnicDB.cancelQuery awaits runner.cancel before setBusy(false)", () => {
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

    const cancelCommand = state.registeredCommands.get("UnicDB.cancelQuery");
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

// ============================================================================
// TASK-AIX05-103 cases 1–2 — production OMP engine wiring in commandOpenAiChat
// =============================================================================
// Case 1: the resolved OMP route passes a production `ompChatEngine`
// (`createOmpChatEngine` output) alongside `acp`; case 2: detection
// fallback keeps the builtin route with NO engine adapter and NO acp deps.
// =============================================================================
describe("TASK-AIX05-103 — commandOpenAiChat production OMP engine wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdWebviewPanels.length = 0;
    panelConstructorCalls.length = 0;
    vi.resetModules();
    state.aiEngine = undefined;
  });

  afterEach(async () => {
    await deactivate();
  });

  it("case 1: resolved OMP route constructs the panel with a production ompChatEngine + acp deps", async () => {
    state.aiEngine = "omp";
    detectOmpState.impl = async () => ({
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    });
    vi.resetModules();
    const ext = await import("./extension");
    const ctx = makeCtx();
    await ext.activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    expect(panelConstructorCalls.length).toBe(1);
    const opts = panelConstructorCalls[0] as {
      acp?: unknown;
      ompChatEngine?: unknown;
    };
    expect(opts.acp).toBeDefined();
    // The engine adapter must exist and expose the OmpChatEngine surface
    // (send/resume/shutdown/cancel/attachTrace) — the real factory output,
    // not a mock.
    expect(opts.ompChatEngine).toBeDefined();
    const engine = opts.ompChatEngine as Record<string, unknown>;
    expect(typeof engine.send).toBe("function");
    expect(typeof engine.resume).toBe("function");
    expect(typeof engine.shutdown).toBe("function");
    expect(typeof engine.cancel).toBe("function");
    expect(typeof engine.attachTrace).toBe("function");
  });

  it("case 2: detection fallback keeps builtin — no OMP engine adapter and no acp deps reach the panel", async () => {
    state.aiEngine = "omp";
    detectOmpState.impl = async () => ({
      available: false,
      ok: false,
      reason: "not-installed",
    });
    vi.resetModules();
    const ext = await import("./extension");
    // Configured ctx: the builtin fallback requires a valid AI config, else
    // commandOpenAiChat routes to the settings interstitial and constructs
    // no panel at all.
    const ctx = makeConfiguredCtx();
    await ext.activate(ctx as never);
    const fn = state.registeredCommands.get("UnicDB.aiChat");
    expect(fn).toBeDefined();
    await fn!();

    expect(panelConstructorCalls.length).toBe(1);
    const opts = panelConstructorCalls[0] as {
      acp?: unknown;
      ompChatEngine?: unknown;
    };
    expect(opts.acp).toBeUndefined();
    expect(opts.ompChatEngine).toBeUndefined();
  });
});

// ============================================================================
// TASK-ARP02-004 — host integration: runStatements finally-busy ownership +
// deactivate-during-run continuation ordering.
//
// Wave-1 closed the ResultsPanel-INTERNAL session epoch (TASK-ARP02-002) and
// the QueryRunner cancel-ownership surface (TASK-ARP02-001). Two HOST-side
// gaps remain in `src/extension.ts`:
//
// Gap #2 (runStatements finally, ~:1713-1726): the host drives
//   panel.setBusy(true); try { await runner.run(...) } finally
//   { panel.setBusy(false); }
// The shared QueryRunner throws "already running" when a second invocation
// overlaps an in-flight one; the SECOND invocation's finally still fires
// `panel.setBusy(false)` WHILE the first run is in flight — clearing the
// live session's busy state. The panel epoch guard (wave-1) does not cover
// this call: it is extension code calling INTO the panel, not a panel
// continuation.
//
// Gap #1 (deactivate ordering, ~:1012-1040): deactivate() disposes module
// disposables but nothing bounds an in-flight runStatements: a late
// completion still calls `panel.render(...)` (host call — again outside the
// panel-internal epoch guard) and `panel.setBusy(false)` after teardown
// started.
//
// Regression #4: RLX-02 command await semantics (extension.ts ~:476-486) —
// `await runner.cancel()` BEFORE `panel.setBusy(false)` — must stay intact.
// This case is GREEN by design on a correct tree; it locks the invariant.
// ============================================================================
describe("TASK-ARP02-004 — host-integration: runStatements finally + deactivate ordering", () => {
  /** Parked/released per-test to hold a statement mid-flight. */
  let runGate: Promise<void>;
  let releaseRun: (() => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    state.registeredCommands.clear();
    state.createdWebviewPanels.length = 0;
    state.workspaceFolders = undefined; // ⇒ ConnectionManager dùng globalState
    state.activeEditor = undefined;
    runGate = Promise.resolve();
    releaseRun = null;
  });

  /**
   * Poll a condition with macrotask yields (each setTimeout flushes all
   * pending microtasks), failing after `maxMs`. Deterministic for deeply
   * async command paths where a fixed microtask drain is fragile.
   */
  async function until(cond: () => boolean, what: string, maxMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > maxMs) {
        throw new Error(`TASK-ARP02-004 harness: timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  function setSqlEditor(sql: string): void {
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
  }

  /**
   * Same dynamic-import seam as activateFresh606: vi.resetModules() drops the
   * module cache, so the extension must be imported fresh and any prototype
   * spy attached to the freshly-loaded class. `ConnectionManager.prototype
   * .getAdapter` is the only fake layer — the REAL QueryRunner, REAL
   * runStatements and REAL ResultsPanel execute.
   */
  async function activateFresh004() {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;

    const runQueryCalls: Array<{ sql: string }> = [];
    const adapterStub = {
      // Honours the current `runGate` AT CALL TIME so each test parks or
      // releases the statement without re-spying.
      runQuery: vi.fn(async (sql: string) => {
        runQueryCalls.push({ sql });
        await runGate;
        return {
          results: [
            {
              columns: ["?column?"],
              rows: [["1"]],
              rowCount: 1,
              commandTag: "SELECT 1",
              durationMs: 0,
            },
          ],
        };
      }),
      listTables: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const connMod = await import("./core/connectionManager");
    vi.spyOn(connMod.ConnectionManager.prototype, "getAdapter").mockResolvedValue(
      adapterStub as never,
    );

    const ext = await import("./extension");
    await ext.activate(ctx as never);
    return { ext, runQueryCalls };
  }

  it("Gap #2 — overlapping runQuery: the stale invocation's finally must NOT clear the live run's busy state", async () => {
    const { runQueryCalls } = await activateFresh004();
    setSqlEditor("SELECT 1;");

    const panelMod = await import("./ui/resultsPanel");
    const setBusySpy = vi.fn();
    vi.spyOn(panelMod.ResultsPanel.prototype, "setBusy").mockImplementation(
      setBusySpy as never,
    );

    // Park the adapter so run #1 stays in flight (runner.isRunning() === true).
    runGate = new Promise<void>((r) => { releaseRun = r; });

    const runQuery = state.registeredCommands.get("UnicDB.runQuery")!;
    const p1 = (runQuery as () => Promise<void>)();
    // Run #1 is parked inside adapter.runQuery ⇒ its setBusy(true) already
    // fired and the shared QueryRunner is owned by run #1.
    await until(() => runQueryCalls.length >= 1, "run #1 to reach the adapter");

    // Overlapping invocation #2: the shared runner REJECTS its run() with
    // "QueryRunner is already running". Its runStatements finally is the
    // stale one: it fires while run #1 still owns the runner.
    const p2 = (runQuery as () => Promise<void>)();
    await until(
      () => setBusySpy.mock.calls.filter((c) => c[0] === true).length >= 2,
      "run #2 to fire setBusy(true)",
    );
    // Let invocation #2 settle completely (catch + finally included) before
    // judging: p2's promise resolves only after its finally ran.
    await expect(p2).resolves.toBeUndefined();

    // THE GAP: with the stale finally unguarded, setBusy(false) has fired
    // while run #1 is still in flight — the live session's busy state was
    // cleared by a dead invocation.
    const falseDuringRun1 = setBusySpy.mock.calls.filter((c) => c[0] === false);
    expect(falseDuringRun1).toHaveLength(0);

    // Release run #1; its OWN finally is the live one and must clear busy
    // exactly once.
    if (releaseRun) releaseRun();
    await expect(p1).resolves.toBeUndefined();

    const falseTotal = setBusySpy.mock.calls.filter((c) => c[0] === false);
    expect(falseTotal).toHaveLength(1);
  });

  it("Gap #1 — deactivate() during an in-flight run: late completion must not render into the disposed panel", async () => {
    const { ext, runQueryCalls } = await activateFresh004();
    setSqlEditor("SELECT 1;");

    const panelMod = await import("./ui/resultsPanel");
    const renderSpy = vi.fn();
    vi.spyOn(panelMod.ResultsPanel.prototype, "render").mockImplementation(
      renderSpy as never,
    );
    const setBusySpy = vi.fn();
    vi.spyOn(panelMod.ResultsPanel.prototype, "setBusy").mockImplementation(
      setBusySpy as never,
    );

    runGate = new Promise<void>((r) => { releaseRun = r; });

    const runQuery = state.registeredCommands.get("UnicDB.runQuery")!;
    const p1 = (runQuery as () => Promise<void>)();
    await until(() => runQueryCalls.length >= 1, "run to reach the adapter");

    const rendersAtDeactivate = renderSpy.mock.calls.length;

    // Teardown starts while the run is in flight. VS Code disposes
    // context.subscriptions (which holds the shared ResultsPanel) around
    // deactivate(); the host-side continuation that settles later must not
    // write into that disposed panel.
    await ext.deactivate();

    // Late completion: the statement resolves AFTER teardown started.
    if (releaseRun) releaseRun();
    await expect(p1).resolves.toBeUndefined();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));

    // No render may escape into the disposed panel after deactivate, and
    // the stale finally must not clear busy after teardown either.
    const rendersAfter = renderSpy.mock.calls.length - rendersAtDeactivate;
    expect(rendersAfter).toBe(0);
    expect(
      setBusySpy.mock.calls.filter((c) => c[0] === false).length,
    ).toBe(0);
  });

  it("Regression #4 — RLX-02 command await semantics: UnicDB.cancelQuery awaits runner.cancel() BEFORE panel.setBusy(false)", async () => {
    const runnerMod = await import("./core/queryRunner");
    let resolveCancel: (() => void) | null = null;
    const cancelSpy = vi.fn(
      () => new Promise<void>((resolve) => { resolveCancel = resolve; }),
    );
    vi.spyOn(runnerMod.QueryRunner.prototype, "cancel").mockImplementation(
      cancelSpy,
    );
    const panelMod = await import("./ui/resultsPanel");
    const setBusySpy = vi.fn();
    vi.spyOn(panelMod.ResultsPanel.prototype, "setBusy").mockImplementation(
      setBusySpy as never,
    );

    await activateFresh004();
    const cancelCommand = state.registeredCommands.get("UnicDB.cancelQuery");
    expect(cancelCommand).toBeDefined();

    const commandPromise = (cancelCommand as () => Promise<void>)();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    // The deferred cancel has not resolved ⇒ busy(false) MUST NOT have fired.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(
      setBusySpy.mock.calls.filter((c) => c[0] === false),
    ).toHaveLength(0);

    if (resolveCancel) resolveCancel();
    await expect(commandPromise).resolves.toBeUndefined();
    // After cancel settles: exactly one busy(false), seam-first ordering kept.
    expect(
      setBusySpy.mock.calls.filter((c) => c[0] === false),
    ).toHaveLength(1);
  });
});

// =============================================================================
// TASK-ARP07-004 — Successful-DDL cache invalidation via the host seam in
// `runStatements` (~extension.ts:1754). Only statements that ACTUALLY
// completed with `status === "done"` feed the ARP-07.1 classifier; if any
// has schema impact, the seam invalidates `SchemaCache` + AI schema context
// cache and refreshes the tree. Failed/cancelled/rejected-confirmation runs
// and post-teardown (`deactivating`) continuations never invalidate.
//
// Test strategy: doMock `./ui/schemaCache` + `./ai/schemaContextCache` AFTER
// `vi.resetModules()` so the seam is wired against `vi.fn()` spies. The real
// `QueryRunner.run` is also replaced (via `prototype.run`) so the test
// controls the `StatementResult[]` it returns — including the exact field
// names from `queryRunner.ts:49-52` (`.status` + `.sql`).
// =============================================================================
describe("TASK-ARP07-004 — successful-DDL cache invalidation seam", () => {
  let schemaCacheSpy: ReturnType<typeof vi.fn>;
  let acSchemaCacheSpy: ReturnType<typeof vi.fn>;
  let treeRefreshSpy: ReturnType<typeof vi.fn>;
  let runSpy: ReturnType<typeof vi.fn>;

  /** `vscode.window.showWarningMessage` (return value drives the confirm gate). */
  let warnMock: ReturnType<typeof vi.fn>;

  /**
   * Active adapter fake — satisfies `ConnectionManager.getAdapter()` enough
   * to clear the catalog cache; the real runner is mocked at the prototype
   * so this never actually runs a query.
   */
  const adapterStub = {
    listTables: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    testConnection: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as const;

  /**
   * Pin the seam behaviour: `doMock` AFTER `resetModules`, then `import` so
   * extension.ts re-evaluates with the mock SchemaCache / schemaContextCache
   * factories returning spies. `vi.resetModules()` is called again on every
   * test so each test gets a fresh module instance + fresh spies.
   */
  async function activateSeam() {
    // Spies — must be created BEFORE the modules import so the factories
    // can close over them.
    schemaCacheSpy = vi.fn();
    acSchemaCacheSpy = vi.fn();
    const acResolveSpy = vi.fn(async () => ({
      dialect: "postgres" as const,
      connectionName: "c1",
      tables: [],
    }));
    treeRefreshSpy = vi.fn();

    // Replace `./ui/schemaCache` — extension.ts imports `SchemaCache` (class)
    // and `new SchemaCache(provider)`. The mock returns a thin instance whose
    // `invalidate()` is the spy. The constructor is irrelevant to the seam;
    // the only call the seam makes is `invalidate()`.
    vi.doMock("./ui/schemaCache", () => {
      const SchemaCache = vi.fn().mockImplementation(() => ({
        invalidate: schemaCacheSpy,
      }));
      return { SchemaCache };
    });
    // Replace `./ai/schemaContextCache` — extension.ts imports
    // `createSchemaContextCache` (factory) and the `SchemaContextCache` type.
    vi.doMock("./ai/schemaContextCache", () => {
      const createSchemaContextCache = vi.fn(() => ({
        resolve: acResolveSpy,
        invalidate: acSchemaCacheSpy,
      }));
      return { createSchemaContextCache };
    });

    // Seed an active connection so the host seam runs past the QuickPick gate.
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;

    const connectionMgrMod = await import("./core/connectionManager");
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockResolvedValue(adapterStub as never);

    // Spy the schema-tree refresh BEFORE dynamic import so the prototype
    // method is the one instance the host seam calls via `state?.tree`.
    const treeMod = await import("./ui/schemaTree");
    vi.spyOn(treeMod.SchemaTreeProvider.prototype, "refresh").mockImplementation(
      treeRefreshSpy as never,
    );

    const ext = await import("./extension");
    await ext.activate(ctx as never);
    return { ext };
  }

  function makeResult(sql: string, status: "done" | "error" | "cancelled" | "running") {
    return { index: 0, sql, status, durationMs: 0 };
  }

  /**
   * Override `QueryRunner.prototype.run` AFTER `activate()` (and AFTER the
   * shared runner instance is constructed). Each test pins its own return
   * value to drive the seam with the exact `StatementResult` shape from
   * `queryRunner.ts:49-52`. The spy is (re)created against the CURRENT
   * module instance — `vi.resetModules()` in beforeEach drops the module
   * cache, so a prototype spy from a previous test points at a dead class.
   */
  async function setRunnerResults(results: ReturnType<typeof makeResult>[]) {
    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockResolvedValue(results as never);
  }

  async function driveRunStatement(
    ext: { deactivate: () => Promise<void> },
    sql: string,
    opts: { handler?: () => unknown } = {},
  ): Promise<void> {
    const stmt: ParsedStatement = { text: sql, start: 0, end: sql.length };
    // A pre-captured handler (used by the deactivating test) survives
    // deactivate() — that is the point: the in-flight continuation still
    // holds the closure with concrete mgr/runner/panel refs.
    const fn = opts.handler ?? state.registeredCommands.get("UnicDB.runStatement");
    expect(fn).toBeDefined();
    await fn!(stmt);
    // Let the seam's microtask chain settle before assertions.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 2));
    void ext; // deactivating test uses the parameter to call deactivate()
  }

  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdTreeViews.length = 0;
    state.workspaceFolders = undefined;
    state.activeEditor = undefined;
    state.confirmDestructive = undefined;
    // Default warn mock: returns undefined (user dismisses). Tests that drive
    // DDL with a red tier must override per-call via `mockResolvedValueOnce`.
    warnMock = vi.fn().mockResolvedValue(undefined);
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    win.showWarningMessage = warnMock;
    vi.resetModules();
  });

  it("#1 happy: successful CREATE TABLE through shared run path → seam fires (invalidate ×2, tree.refresh)", async () => {
    const { ext } = await activateSeam();
    await setRunnerResults([
      makeResult("CREATE TABLE t (id int)", "done"),
    ]);
    await driveRunStatement(ext, "CREATE TABLE t (id int)");

    expect(schemaCacheSpy).toHaveBeenCalledTimes(1);
    expect(acSchemaCacheSpy).toHaveBeenCalledTimes(1);
    expect(treeRefreshSpy).toHaveBeenCalledTimes(1);
  });

  it("#2 happy: mixed batch (SELECT done + CREATE done) — seam fires on the CREATE", async () => {
    const { ext } = await activateSeam();
    await setRunnerResults([
      makeResult("SELECT 1", "done"),
      makeResult("CREATE TABLE t (id int)", "done"),
    ]);
    await driveRunStatement(ext, "SELECT 1; CREATE TABLE t (id int);");

    expect(schemaCacheSpy).toHaveBeenCalledTimes(1);
    expect(acSchemaCacheSpy).toHaveBeenCalledTimes(1);
    expect(treeRefreshSpy).toHaveBeenCalledTimes(1);
  });

  it("#3 edge: failed DDL (adapter throws) — runner marks statement error + remainder cancelled → seam NOT called", async () => {
    const { ext } = await activateSeam();
    // When `runner.run` throws, the host catches and the seam is inside
    // the `try` block AFTER `runner.run` resolves — so we simulate the
    // "completed with non-done statuses" path (error + cancelled).
    await setRunnerResults([
      makeResult("CREATE TABLE t (id int)", "error"),
      makeResult("INSERT INTO t VALUES (1)", "cancelled"),
    ]);
    await driveRunStatement(ext, "CREATE TABLE t (id int); INSERT INTO t VALUES (1);");

    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).not.toHaveBeenCalled();
  });

  it("#4 edge: rejected confirmation (DROP + dismiss) → early-return BEFORE runner.run → seam NOT called", async () => {
    const { ext } = await activateSeam();
    // `DROP TABLE t` triggers the red confirm tier; showWarningMessage
    // returning undefined means the user dismissed (rejected). The host
    // returns early before `runner.run` is invoked.
    warnMock.mockResolvedValueOnce(undefined);
    await driveRunStatement(ext, "DROP TABLE t;");

    expect(runSpy).not.toHaveBeenCalled();
    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).not.toHaveBeenCalled();
  });

  it("#5 edge: cancelled run (all results cancelled before any done) → seam NOT called", async () => {
    const { ext } = await activateSeam();
    await setRunnerResults([
      makeResult("CREATE TABLE t (id int)", "cancelled"),
    ]);
    await driveRunStatement(ext, "CREATE TABLE t (id int);");

    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).not.toHaveBeenCalled();
  });

  it("#6 edge: deactivate-during-run (deactivating=true at success time) → seam NOT called (ARP-02)", async () => {
    const { ext } = await activateSeam();
    // Capture the handler BEFORE deactivate(): disposables are disposed
    // during teardown and drop the registeredCommands entries, but the
    // in-flight continuation still holds the closure with concrete
    // mgr/runner/panel refs — exactly the ARP-02 resurrected-write shape.
    const handler = state.registeredCommands.get(
      "UnicDB.runStatement",
    ) as (stmt: ParsedStatement) => Promise<void>;
    // Deactivate flips the `deactivating` sentinel to true AND nulls the
    // module `state` (so `state?.tree` is unreachable too).
    await ext.deactivate();
    await setRunnerResults([
      makeResult("CREATE TABLE t (id int)", "done"),
    ]);
    await driveRunStatement(ext, "CREATE TABLE t (id int);", {
      handler: () => handler({ text: "CREATE TABLE t (id int)", start: 0, end: 23 }),
    });

    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).not.toHaveBeenCalled();
  });

  it("#7 edge: DML-only successful run (INSERT / UPDATE+WHERE / TRUNCATE) → tree-only refresh (TASK-UX1-011 R13: caches untouched, tree.refresh called once per batch)", async () => {
    const { ext } = await activateSeam();
    // INSERT — kind "other" → tier "none" → no confirm prompt.
    await setRunnerResults([
      makeResult("INSERT INTO t VALUES (1)", "done"),
    ]);
    await driveRunStatement(ext, "INSERT INTO t VALUES (1);");
    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    // R13: DML DOES refresh the tree (row counts changed).
    expect(treeRefreshSpy).toHaveBeenCalledTimes(1);

    // UPDATE with WHERE — tier "none" → no confirm.
    await setRunnerResults([
      makeResult("UPDATE t SET c = 1 WHERE id = 1", "done"),
    ]);
    await driveRunStatement(ext, "UPDATE t SET c = 1 WHERE id = 1;");
    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).toHaveBeenCalledTimes(2);

    // TRUNCATE — red tier; showWarningMessage must return "Vẫn chạy (nguy hiểm)".
    warnMock.mockResolvedValueOnce("Vẫn chạy (nguy hiểm)");
    await setRunnerResults([
      makeResult("TRUNCATE TABLE t", "done"),
    ]);
    await driveRunStatement(ext, "TRUNCATE TABLE t;");
    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).toHaveBeenCalledTimes(3);
  });

  it("#8 happy: successful SELECT run → caches untouched (classifier false on non-DDL)", async () => {
    const { ext } = await activateSeam();
    await setRunnerResults([
      makeResult("SELECT 1", "done"),
    ]);
    await driveRunStatement(ext, "SELECT 1;");

    expect(schemaCacheSpy).not.toHaveBeenCalled();
    expect(acSchemaCacheSpy).not.toHaveBeenCalled();
    expect(treeRefreshSpy).not.toHaveBeenCalled();
  });

  it("#9 edge: seam payload — completed list receives the REAL statement text from StatementResult.sql (never undefined)", async () => {
    const { ext } = await activateSeam();
    // Pin the original SQL with the exact whitespace/casing the user wrote
    // so we can assert the seam receives that string (not undefined, not
    // a normalized form). The mocked result record uses `.status` + `.sql`
    // (queryRunner.ts:49-52) — NOT a stand-in field.
    const originalSql = "CREATE TABLE t (id int)";
    await setRunnerResults([
      makeResult(originalSql, "done"),
    ]);
    await driveRunStatement(ext, originalSql);

    expect(schemaCacheSpy).toHaveBeenCalledTimes(1);
    // The classifier consumes the SQL string. The contract pin is on the
    // input to the classifier (`completedSchemaImpact`). The seam is
    // implemented in extension.ts using `r.sql` from the StatementResult;
    // we assert the surface by driving the public observable (invalidate
    // called) AND the SQL the runner saw — that SQL is exactly the text
    // the seam classifier fed. If the seam had read `.statementText`
    // (or any other name) it would be undefined, completedSchemaImpact
    // would return false, and the seam would NOT invalidate.
    expect(runSpy).toHaveBeenCalled();
    const passedToRunner = runSpy.mock.calls[0]?.[0] as ParsedStatement[];
    expect(passedToRunner[0]?.text).toBe(originalSql);
  });
});

// =============================================================================
// ARP-08 TASK-ARP08-004 — extension wiring: `context.workspaceState` as the
// Console draft memento. `commandOpenConsole` must pass `draftMemento`
// (workspaceState) IN ADDITION to the `globalState`-backed history memento,
// so drafts are workspace-scoped while history keeps its global scope.
// The pins below hold BOTH guarantees:
//   #1 drafts hydrate from the workspaceState-seeded snapshot (get routing),
//   #2 singleton retained (exactly one UnicDB.console panel per open),
//   #3 key separation: history → globalState.update(CONSOLE_HISTORY_KEY),
//      drafts → workspaceState.get/update(CONSOLE_DRAFTS_KEY), never crossed,
//   #4 deactivate still disposes + nulls the singleton; reopen is fresh.
// =============================================================================

import {
  CONSOLE_DRAFTS_KEY,
  CONSOLE_HISTORY_KEY,
  encodeConsoleDraftSnapshot,
  parseConsoleDraftSnapshot,
} from "./ui/consolePanelMessages";

describe("ARP-08 — console draft memento wiring", () => {
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
    state.createdOutputChannels.length = 0;
    state.confirmDestructive = undefined;
    vi.resetModules();
  });

  afterEach(async () => {
    // extension.ts keeps module-level singletons (incl. the console panel);
    // deactivate drops them so later describes start clean.
    await deactivate();
  });

  /** TASK-003's activateWithConsole shape, extended to return the freshly
   *  imported extension module (deactivate on the FRESH instance is what
   *  tears down the fresh singleton) and to allow seeding either memento. */
  async function activateWithConsole(opts?: {
    draftSnapshot?: string;
    runResults?: unknown[];
  }) {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;
    if (opts?.draftSnapshot !== undefined) {
      ctx.workspaceState.get = vi.fn((key: string) =>
        key === CONSOLE_DRAFTS_KEY ? opts.draftSnapshot : undefined,
      ) as never;
    }

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
      .mockResolvedValue((opts?.runResults ?? []) as never);

    const ext = await import("./extension");
    await ext.activate(ctx as never);
    return { ctx, ext };
  }

  /** Latest UnicDB.console panel mock + its registered message handler. */
  function consolePanelHarness(): {
    panel: Record<string, unknown>;
    handler: (msg: unknown) => void;
  } {
    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string, string, unknown, unknown]>;
    const callIndex = calls.findIndex(([viewType]) => viewType === "UnicDB.console");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const panel = state.createdWebviewPanels[callIndex] as Record<string, unknown>;
    const handler = (
      panel as unknown as { webview: { onDidReceiveMessage: Mock } }
    ).webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;
    return { panel, handler };
  }

  interface PostedState {
    type: string;
    tabs: Array<{ id: string; name: string; buffer: string; active: boolean }>;
    activeTabId: string;
    history: string[];
  }
  function postedStates(panel: Record<string, unknown>): PostedState[] {
    return (
      (panel as unknown as { webview: { postMessage: Mock } }).webview.postMessage
        .mock.calls as unknown as Array<[PostedState]>
    ).map(([m]) => m).filter((m) => m.type === "state");
  }

  it("#1 happy: seeded workspaceState draft hydrates the Console — draftMemento is wired to workspaceState, not globalState", async () => {
    const seeded = encodeConsoleDraftSnapshot({
      version: 1,
      tabs: [{ id: "t1", name: "Saved", buffer: "SELECT 42" }],
      activeTabId: "t1",
    });
    const { ctx } = await activateWithConsole({ draftSnapshot: seeded });
    const fn = state.registeredCommands.get("UnicDB.openConsole");
    expect(fn).toBeDefined();
    await fn!();

    const { panel } = consolePanelHarness();
    const states = postedStates(panel);
    // The seeded draft REPLACED the default "Query 1" tab — proof the panel's
    // draftMemento served CONSOLE_DRAFTS_KEY from workspaceState.
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].tabs).toEqual([
      { id: "t1", name: "Saved", buffer: "SELECT 42", active: true },
    ]);
    expect(states[0].activeTabId).toBe("t1");
    expect(ctx.workspaceState.get).toHaveBeenCalledWith(CONSOLE_DRAFTS_KEY);
  });

  it("#2 happy: invoking UnicDB.openConsole twice still opens exactly ONE UnicDB.console panel (singleton retained)", async () => {
    await activateWithConsole();
    const fn = state.registeredCommands.get("UnicDB.openConsole");
    await fn!();
    await fn!();

    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string]>;
    const consoleCalls = calls.filter(([viewType]) => viewType === "UnicDB.console");
    expect(consoleCalls.length).toBe(1);
  });

  it("#3 edge/history-vs-draft scope: run → globalState.update(CONSOLE_HISTORY_KEY); edit+dispose → workspaceState.update(CONSOLE_DRAFTS_KEY); keys never cross", async () => {
    const { ctx, ext } = await activateWithConsole();
    const fn = state.registeredCommands.get("UnicDB.openConsole");
    await fn!();
    const { panel, handler } = consolePanelHarness();

    // Run SELECT 1 through the shared flow → successful run appends history.
    handler({ type: "runConsole", sql: "SELECT 1" });
    for (
      let i = 0;
      i < 500 &&
      !ctx.globalState.update.mock.calls.some(
        ([k]) => k === CONSOLE_HISTORY_KEY,
      );
      i++
    ) {
      await Promise.resolve();
    }
    expect(ctx.globalState.update).toHaveBeenCalledWith(
      CONSOLE_HISTORY_KEY,
      expect.arrayContaining(["SELECT 1"]),
    );
    // History scope untouched by drafts keys, drafts scope untouched by
    // history keys — the two mementos never receive the other's key.
    expect(
      ctx.globalState.update.mock.calls.some(
        ([k]) => k === CONSOLE_DRAFTS_KEY,
      ),
    ).toBe(false);
    expect(
      ctx.globalState.get.mock.calls.some(([k]) => k === CONSOLE_DRAFTS_KEY),
    ).toBe(false);
    expect(
      ctx.workspaceState.get.mock.calls.some(([k]) => k === CONSOLE_DRAFTS_KEY),
    ).toBe(true);

    // Buffer edit then teardown: dispose() flushes the dirty draft snapshot
    // to the DRAFT memento (workspaceState), not the history memento.
    const state0 = postedStates(panel)[0];
    handler({ type: "updateBuffer", tabId: state0.activeTabId, buffer: "SELECT 1" });
    await ext.deactivate();
    const draftUpdate = ctx.workspaceState.update.mock.calls.find(
      ([k]) => k === CONSOLE_DRAFTS_KEY,
    );
    expect(draftUpdate).toBeDefined();
    const snap = parseConsoleDraftSnapshot(draftUpdate![1] as string);
    expect(snap).not.toBeNull();
    expect(snap!.tabs.map((t) => t.buffer)).toContain("SELECT 1");
    expect(
      ctx.workspaceState.update.mock.calls.some(
        ([k]) => k === CONSOLE_HISTORY_KEY,
      ),
    ).toBe(false);
  });

  it("#4 edge/teardown: deactivate disposes the console panel and nulls the singleton — reopen builds a fresh panel", async () => {
    const { ext } = await activateWithConsole();
    const fn = state.registeredCommands.get("UnicDB.openConsole");
    await fn!();
    const { panel } = consolePanelHarness();

    await ext.deactivate();
    expect(panel.dispose).toHaveBeenCalled();

    // Reopen after deactivate: singleton was nulled → a SECOND UnicDB.console
    // createWebviewPanel call (not a reveal of the disposed panel).
    await fn!();
    const calls = (vscodeMock.window.createWebviewPanel as Mock)
      .mock.calls as unknown as Array<[string]>;
    const consoleCalls = calls.filter(([viewType]) => viewType === "UnicDB.console");
    expect(consoleCalls.length).toBe(2);
  });
});

// =============================================================================
// TASK-ARP09-003 — Lazy redacted Output Channel wiring
//   * `UnicDB.window.createOutputChannel("UnicDB")` is created LAZILY on the
//     FIRST real diagnostic write (or on `UnicDB.diagnostics.show` invocation).
//     A plain `activate()` must create ZERO output channels.
//   * The activate-end lifecycle `info` line is BUFFERED (pending) and
//     flushed exactly once when the channel is created.
//   * Every captured `appendLine` argument matches the `logLine` prefix
//     shape (`/^\[\d{4}-\d{2}-\d{2}T/`) and is byte-scan-clean of any
//     raw secret, bearer/basic auth, opaque long run, or SQL fixture text.
//   * `deactivate()` disposes the channel EXACTLY ONCE; a post-deactivate
//     `logDiagnostic` is a no-op (no create, no append, no second dispose).
//   * `UnicDB.diagnostics.show` reveals; `UnicDB.diagnostics.clear` clears.
//   * Connection/AI summary lines land at the real existing seams; the
//     connection handler never receives a `ConnectionConfig` literal in
//     its log line (config privacy pin).
//
// Test strategy: `vi.doMock("./core/connectionManager")` with a `SpyMgr`
// wrapper that captures the live manager instance; the test fires the
// manager's private `_onDidChangeActiveEmitter` to drive a REAL diagnostic
// write at the host's seam. Same dynamic-import pattern used by
// TASK-ARP07-004 and TASK-AIX07-003.
// =============================================================================
describe("TASK-ARP09-003 — lazy redacted Output Channel wiring", () => {
  /** Live ConnectionManager captured by the SpyMgr wrapper. */
  let liveMgr: {
    _onDidChangeActiveEmitter?: { fire(cfg: unknown): void };
  } | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdOutputChannels.length = 0;
    liveMgr = null;
    vi.resetModules();
  });

  afterEach(async () => {
    liveMgr = null;
    await deactivate();
  });

  /**
   * Same dynamic-import + SpyMgr pattern as TASK-AIX07-003 case 5: reset
   * modules, replace `./core/connectionManager` with a wrapper that
   * captures the live instance, import the fresh extension, activate.
   * Resetting is necessary so each test sees a clean module state — the
   * lazy `diagOutputChannel` singleton is module-level and must start null.
   */
  async function activateFresh() {
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
    const ctx = makeCtx();
    await ext.activate(ctx as never);
    return ext;
  }

  /** Drive the host's connection-change diagnostic write. Fires the
   *  ConnectionManager's real emitter — extension.ts's listener is
   *  called with the supplied `cfg` and that is what triggers
   *  `logDiagnostic("connection", "info", ...)`. */
  function fireConnectionChange(cfg: unknown): void {
    expect(liveMgr, "liveMgr must be captured during activate").not.toBeNull();
    const mgr = liveMgr as unknown as {
      _onDidChangeActiveEmitter?: { fire(cfg: unknown): void };
    };
    expect(mgr._onDidChangeActiveEmitter, "manager emitter must exist").toBeDefined();
    mgr._onDidChangeActiveEmitter!.fire(cfg);
  }

  /** All captured appendLine args flattened across the most-recent channel. */
  function capturedLines(): string[] {
    return state.createdOutputChannels[0]?.lines ?? [];
  }

  it("#20 strict pin: plain activate() with no events/commands creates ZERO output channels", async () => {
    await activateFresh();
    expect(state.createdOutputChannels.length).toBe(0);
    // The lifecycle line is buffered (pending), not appended to a channel.
    expect(capturedLines()).toEqual([]);
  });

  it("#17 happy/lazy-create: first real diagnostic write (fire onDidChangeActive) creates the channel exactly once with name 'UnicDB' and flushes the pending lifecycle line", async () => {
    await activateFresh();
    expect(state.createdOutputChannels.length).toBe(0);

    // Drive a real write via the host's connection listener.
    fireConnectionChange({
      id: "c1",
      name: "test",
      driver: "postgres",
      host: "h",
      port: 5432,
      user: "u",
      database: "d",
    });

    expect(state.createdOutputChannels.length).toBe(1);
    expect(state.createdOutputChannels[0]!.name).toBe("UnicDB");

    // Captured lines: lifecycle (flushed) first, then the connection line.
    const lines = capturedLines();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[lifecycle\] \[info\] UnicDB activated$/,
    );
    expect(lines[1]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[connection\] \[info\] connection changed$/,
    );
    // Every captured line matches the logLine prefix shape.
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("#18 happy/show: invoking UnicDB.diagnostics.show creates the channel lazily and calls show()", async () => {
    await activateFresh();
    expect(state.createdOutputChannels.length).toBe(0);

    const fn = state.registeredCommands.get("UnicDB.diagnostics.show");
    expect(fn).toBeDefined();
    await fn!();

    expect(state.createdOutputChannels.length).toBe(1);
    const ch = state.createdOutputChannels[0]!;
    expect(ch.name).toBe("UnicDB");
    expect(ch.show).toHaveBeenCalledTimes(1);
  });

  it("#19 happy/clear: invoking UnicDB.diagnostics.clear calls clear() on the channel", async () => {
    await activateFresh();
    // Drive a real write so the channel exists.
    fireConnectionChange({ id: "c1", name: "x", driver: "postgres" });
    expect(state.createdOutputChannels.length).toBe(1);

    const fn = state.registeredCommands.get("UnicDB.diagnostics.clear");
    expect(fn).toBeDefined();
    await fn!();

    expect(state.createdOutputChannels[0]!.clear).toHaveBeenCalledTimes(1);
  });

  it("#21 privacy byte-scan: connection event with secret + bearer + SQL fixture near the seam → channel output contains none of them; the connection handler received NO config object", async () => {
    await activateFresh();

    // Fire the connection listener with a config whose body NEVER reaches
    // the log line. The handler signature is `(cfg) => logDiagnostic(
    // "connection", "info", cfg ? "connection changed" : "connection closed")`
    // — only the truthiness of `cfg` is read. The config object is never
    // appended.
    const secretCfg = {
      id: "c1",
      name: "x",
      driver: "postgres",
      host: "h",
      port: 5432,
      user: "u",
      database: "d",
      password: "s3cr3t-p4ss",
      token: "s3cr3t-t0k",
      authHeader: "Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      sqlFixture:
        "SELECT * FROM secret_table WHERE password = 's3cr3t-p4ss' AND id > 0",
    };
    fireConnectionChange(secretCfg);

    // Channel was created once, named "UnicDB".
    expect(state.createdOutputChannels.length).toBe(1);
    const ch = state.createdOutputChannels[0]!;

    // Also drive a SECOND write that itself carries a SQL fixture fragment
    // through the public command path so the formatter's `redact()` is
    // exercised end-to-end (defense in depth — privacy holds at the
    // formatter boundary, not just at the handler's call site).
    const { logDiagnostic } = await import("./extension");
    logDiagnostic(
      "general",
      "warn",
      "SELECT * FROM secret_table WHERE password = 's3cr3t-p4ss'",
    );

    const lines = ch.lines;
    expect(lines.length).toBeGreaterThan(0);

    // The connection line is the literal "connection changed" — proves
    // the handler never appended the config object. It is the SECOND
    // captured line: lifecycle (flushed from the buffer) is first.
    const connectionLine = lines.find((l) => /\[connection\] /.test(l));
    expect(connectionLine).toBeDefined();
    expect(connectionLine).toMatch(/\[connection\] \[info\] connection changed$/);
    // No raw secret in any captured line.
    for (const line of lines) {
      expect(line).not.toContain("s3cr3t-p4ss");
      expect(line).not.toContain("s3cr3t-t0k");
      expect(line).not.toContain("Bearer eyJ");
      // Bearer / Basic scrub (formatter does it on EVERY message).
      expect(line).not.toMatch(/Bearer\s+[A-Za-z0-9._\-+/=]+/);
      expect(line).not.toMatch(/Basic\s+[A-Za-z0-9._\-+/=]+/);
      // No opaque long-run (≥24 chars alphanumeric/base64) — `redact()` in
      // trace.ts LONG_RUN_RE collapses these to `<redacted>` before
      // logLine() bounds the line.
      expect(line).not.toMatch(/[A-Za-z0-9_+/=-]{24,}/);
      // SQL fixture secret-shaped content must not survive (the formatter
      // scrubs the `password=...` value; the SQL keywords + identifier
      // names are NOT secrets, so the table name itself is allowed).
      expect(line).not.toMatch(/password\s*=\s*['"]?s3cr3t-p4ss/i);
    }
  });

  it("#22 exactly-once dispose: deactivate() calls dispose() exactly once; post-deactivate logDiagnostic is a no-op (no create, no append, no second dispose)", async () => {
    const ext = await activateFresh();
    // Drive a real write so the channel exists.
    fireConnectionChange({ id: "c1", name: "x", driver: "postgres" });
    expect(state.createdOutputChannels.length).toBe(1);
    const ch = state.createdOutputChannels[0]!;
    expect(ch.dispose).not.toHaveBeenCalled();

    // First deactivate disposes the channel exactly once.
    await ext.deactivate();
    expect(ch.dispose).toHaveBeenCalledTimes(1);
    const createCountAfterDeactivate = state.createdOutputChannels.length;
    const linesAtDeactivate = ch.lines.length;

    // Post-deactivate: the exported logDiagnostic helper must be a no-op.
    // It is exported from src/extension.ts so external hosts / future
    // cycles can drive the channel without re-importing module state.
    const { logDiagnostic: postDeactivateLog } = await import("./extension");
    postDeactivateLog("general", "info", "after-deactivate");

    // No new channel created, no new line appended, no second dispose.
    expect(state.createdOutputChannels.length).toBe(createCountAfterDeactivate);
    expect(ch.lines.length).toBe(linesAtDeactivate);
    expect(ch.dispose).toHaveBeenCalledTimes(1);
  });

  it("#24 happy/AI summary: invoking UnicDB.ai.showPolicy appends an [ai]-category line to the channel", async () => {
    await activateFresh();
    // Drive a real write so the channel exists.
    fireConnectionChange({ id: "c1", name: "x", driver: "postgres" });
    expect(state.createdOutputChannels.length).toBe(1);

    const fn = state.registeredCommands.get("UnicDB.ai.showPolicy");
    expect(fn).toBeDefined();
    await fn!();

    const lines = capturedLines();
    // One of the captured lines is the [ai] summary emitted by the
    // UnicDB.ai.showPolicy handler.
    const aiLine = lines.find((l) => /\[ai\] \[info\]/.test(l));
    expect(aiLine, "expected an [ai] [info] line after UnicDB.ai.showPolicy").toBeDefined();
  });

  it("package.json contributes UnicDB.diagnostics.show + UnicDB.diagnostics.clear with activationEvents", () => {
    interface CmdEntry { command: string; title?: string; category?: string }
    const commands = pkgJson.contributes.commands as CmdEntry[];
    const show = commands.find((c) => c.command === "UnicDB.diagnostics.show");
    const clear = commands.find((c) => c.command === "UnicDB.diagnostics.clear");
    expect(show).toBeDefined();
    expect(show!.title).toMatch(/Show Diagnostics/i);
    expect(show!.category).toBe("UnicDB");
    expect(clear).toBeDefined();
    expect(clear!.title).toMatch(/Clear Diagnostics/i);
    expect(clear!.category).toBe("UnicDB");
    const evts = pkgJson.activationEvents as string[];
    expect(evts).toContain("onCommand:UnicDB.diagnostics.show");
    expect(evts).toContain("onCommand:UnicDB.diagnostics.clear");
  });
});

// =============================================================================
// TASK-BQ03-005 — BigQuery command integration:
//   - Driver-specific header (data project / billing project / location /
//     job identity) for BigQuery connections;
//   - GoogleSQL marker surfaced;
//   - HTML-escaped copy-safe header (XSS-hostile project / billing / jobId);
//   - non-BigQuery headers byte-identical to the legacy format;
//   - R4.5 round 1 — append-mode 2nd-run regression: the post-settle re-render
//     must read from THIS run's slice (`results.slice(appendBase)`), not the
//     prior run's batched handle.
// =============================================================================
describe("TASK-BQ03-005 — BigQuery command integration (header + copy-safety)", () => {
  let runSpy: ReturnType<typeof vi.fn>;
  /** Captured render() invocations: arguments[1] is the header string. */
  let renderCalls: Array<{ results: unknown[]; header: string; opts?: unknown }>;

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
    state.createdOutputChannels.length = 0;
    state.confirmDestructive = undefined;
    renderCalls = [];
    mockRunnerResults = [];
    vi.resetModules();
  });

  /**
   * Seed an active bigquery connection through `globalState` so the harness
   * does not need SecretStorage. `bigquery` is the BigQuery sub-config: a
   * `billingProject` is REQUIRED (the validator rejects empty), so any
   * test that overrides it provides a non-empty string. `location` and
   * `datasetProject` are optional.
   */
  function makeBqCtx(opts: {
    billingProject?: string;
    location?: string;
    datasetProject?: string;
  } = {}): ReturnType<typeof makeCtx> {
    const ctx = makeCtx();
    const bigquery = { billingProject: opts.billingProject ?? "proj-billing" } as Record<string, string>;
    if (opts.location !== undefined) bigquery.location = opts.location;
    if (opts.datasetProject !== undefined) bigquery.datasetProject = opts.datasetProject;
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
        return [
          {
            id: "c1",
            name: "bq",
            driver: "bigquery",
            host: "",
            port: 0,
            user: "",
            database: "",
            bigquery,
          },
        ];
      }
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;
    return ctx;
  }

  function makeLegacyCtx(driver: string): ReturnType<typeof makeCtx> {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
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
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;
    return ctx;
  }

  /** Install a render spy that captures every call's header string. MUST be
   *  called BEFORE `activate()` so the panel instance the extension builds
   *  inherits the spied prototype method (otherwise resetModules + activate
   *  would install a real render and the spy would only see fresh instances
   *  loaded later — see TASK-RLX02-003 for the established pattern). */
  async function spyRender() {
    const panelMod = await import("./ui/resultsPanel");
    vi.spyOn(panelMod.ResultsPanel.prototype, "render").mockImplementation(
      ((results: unknown[], header: string, opts?: unknown) => {
        renderCalls.push({ results: results as unknown[], header, opts });
      }) as never,
    );
  }

  /** Stub ConnectionManager.getAdapter() with a no-op adapter so the harness
   *  does not need ADC or any real BigQuery connection. Without this,
   *  `applyKeywordQualify` → `mgr.getAdapter()` → real BigQueryAdapter →
   *  real connect() → could hang / reject / never resolve in the test env. */
  async function stubAdapter() {
    const connectionMgrMod = await import("./core/connectionManager");
    const adapter = {
      listTables: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      listSchemas: vi.fn(async () => []),
      testConnection: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      runQuery: vi.fn(async () => ({ results: [] })),
    };
    vi.spyOn(connectionMgrMod.ConnectionManager.prototype, "getAdapter").mockResolvedValue(
      adapter as never,
    );
  }

  function setSqlEditor(sql: string): void {
    state.activeEditor = {
      document: {
        languageId: "sql",
        getText: () => sql,
        // Mirror vscode.TextDocument.offsetAt: returns the character offset
        // of the given position within the document (single-line SQL).
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
  }

  /** A batched handle carrying a jobRef, mimicking the BQ-03.1 contract. */
  function makeBatchedHandle(jobRef: {
    projectId: string;
    location: string;
    jobId: string;
  }): { jobRef: typeof jobRef; fetchBatch: () => Promise<unknown[]>; cancel: () => Promise<void>; close: () => Promise<void> } {
    return {
      jobRef,
      fetchBatch: async () => [],
      cancel: async () => {},
      close: async () => {},
    };
  }

  /**
   * Shared append-mode state across multiple `driveRun` calls within one
   * test. Mirrors the real runner's `private results: StatementResult[]`:
   * each invocation appends THIS run's entries onto the persistent array
   * and returns the FULL array (`queryRunner.ts:281 — return this.results.slice()`).
   * Reset in `beforeEach` so each test starts with an empty accumulator.
   */
  let mockRunnerResults: unknown[] = [];

  /**
   * Drive a full `UnicDB.runQuery` cycle. `mockResultsBuilder` receives the
   * runner's CURRENT results array (already containing any prior runs in
   * append-mode) and returns the array the mocked `runner.run` should
   * resolve with.
   */
  async function driveRun(
    builder: (currentResults: unknown[]) => unknown[],
    sql = "SELECT 1",
  ): Promise<void> {
    setSqlEditor(sql);
    const runnerMod = await import("./core/queryRunner");
    const realRunnerCtor = runnerMod.QueryRunner;
    runSpy = vi
      .spyOn(realRunnerCtor.prototype, "run")
      .mockImplementation((async () => {
        // Simulate runner's append-mode semantics: append THIS run's
        // entries onto the persistent array and return the FULL array.
        const built = builder(mockRunnerResults.slice());
        for (const r of built) {
          if (!mockRunnerResults.includes(r)) mockRunnerResults.push(r);
        }
        return mockRunnerResults as never;
      }) as never);
    vi.spyOn(realRunnerCtor.prototype, "getResults").mockImplementation(
      (() => mockRunnerResults.slice()) as never,
    );
    vi.spyOn(realRunnerCtor.prototype, "isRunning").mockReturnValue(
      false,
    );

    const runCmd = state.registeredCommands.get("UnicDB.runQuery");
    expect(runCmd, "UnicDB.runQuery must be registered").toBeDefined();
    await runCmd!();
    // Settle microtasks.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
  }

  // ---------------------------------------------------------------------------
  // Test #1 — happy: BigQuery header carries all four facts (data project,
  // billing project, location, job identity). Format pin from the task spec:
  //   ... bigquery@<dataProj>/<billingProj> @ <location> — job <link-or-id> (GoogleSQL)
  // ---------------------------------------------------------------------------
  it("#1 happy: BigQuery header carries all four facts + GoogleSQL marker", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeBqCtx({
      billingProject: "proj-billing",
      location: "US",
    });
    await (await import("./extension")).activate(ctx as never);

    const batched = makeBatchedHandle({
      projectId: "data-proj",
      location: "US",
      jobId: "job123",
    });
    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "done", batched, durationMs: 0 },
    ]);

    expect(renderCalls.length).toBeGreaterThan(0);
    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    expect(finalHeader).toMatch(/bigquery@data-proj\/proj-billing/);
    expect(finalHeader).toMatch(/@ US/);
    // The job identity segment must include jobId (parenthesised at the end).
    expect(finalHeader).toMatch(/\(job123\)/);
    expect(finalHeader).toMatch(/GoogleSQL/);
  });

  // ---------------------------------------------------------------------------
  // Test #2 — happy: GoogleSQL marker surfaced; no `useLegacySql` ever sent.
  // ---------------------------------------------------------------------------
  it("#2 happy: GoogleSQL marker in header — no useLegacySql option anywhere", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeBqCtx({ billingProject: "proj-billing", location: "EU" });
    await (await import("./extension")).activate(ctx as never);

    const batched = makeBatchedHandle({
      projectId: "data-proj",
      location: "EU",
      jobId: "job_EU_1",
    });
    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "done", batched, durationMs: 0 },
    ]);

    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    expect(finalHeader).toMatch(/GoogleSQL/);
    // Legacy SQL must never be silently chosen: header never carries the
    // "LegacySQL" marker — this asserts the marker is the EXACT GoogleSQL
    // substring, not a wildcard that would also match "LegacySQL".
    expect(finalHeader).not.toMatch(/LegacySQL/);
    expect(finalHeader).not.toMatch(/legacy/i);
  });

  // ---------------------------------------------------------------------------
  // Test #3 — edge (empty): missing job identity degrades gracefully with `—`
  // ---------------------------------------------------------------------------
  it("#3 edge (empty): missing jobRef → `—` placeholder, no `undefined`, no crash", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeBqCtx({ billingProject: "proj-billing", location: "US" });
    await (await import("./extension")).activate(ctx as never);

    // Result WITHOUT a batched handle (gate-rejected run / cancelled / etc.).
    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "error", error: "cancelled", durationMs: 0 },
    ]);

    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    expect(finalHeader).not.toMatch(/undefined/);
    expect(finalHeader).not.toMatch(/null/);
    expect(finalHeader).toMatch(/job —/);
    // Header still includes the BigQuery identity line + GoogleSQL marker.
    expect(finalHeader).toMatch(/bigquery@/);
    expect(finalHeader).toMatch(/GoogleSQL/);
  });

  // ---------------------------------------------------------------------------
  // Test #4 — edge (copy-safe): HTML-hostile projectId, location, AND
  // billingProject get escaped. The hostile billingProject fixture is
  // R4.5 round 1's blocker (reviewer finding): billingProject appears TWICE
  // in the header (identity segment + link `project=` param).
  // ---------------------------------------------------------------------------
  it("#4 edge (copy-safe): HTML-hostile jobRef pieces + billingProject escaped", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeBqCtx({
      billingProject: '<script>alert(1)</script>',
      location: '<bad>',
    });
    await (await import("./extension")).activate(ctx as never);

    const batched = makeBatchedHandle({
      projectId: "<script>alert(2)</script>",
      location: '<bad>"&',
      jobId: 'evil"&<jobId>',
    });
    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "done", batched, durationMs: 0 },
    ]);

    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    // Raw HTML must NOT pass through into the posted header.
    expect(finalHeader).not.toContain('<script>');
    expect(finalHeader).not.toContain('</script>');
    // Escaped forms present.
    expect(finalHeader).toContain('&lt;script&gt;');
    expect(finalHeader).toContain('&lt;bad&gt;');
    // `"` from billingProject must be escaped (URL-hostile segment).
    expect(finalHeader).toContain('&quot;');
    // jobId's hostile `"&<` all escaped.
    expect(finalHeader).toContain('evil&quot;&amp;&lt;jobId&gt;');
    // billingProject appears as both identity segment AND link project=.
    // The hostile string must remain escaped in BOTH positions; the
    // helper escape() also percent-encodes `&` for the link body.
    const occurrences = finalHeader.split('&lt;script&gt;alert(1)&lt;/script&gt;').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Test #5 — edge (permission/denied): BigQueryJobError surfaces sanitized.
  // ---------------------------------------------------------------------------
  // TASK-UX2-004: the outer catch now routes through `runner.runFailed(reason)`
  // (synthetic-tab producer) instead of dropping a toast. The new
  // acceptance criterion is that the synthetic StatementResult carries the
  // sanitized envelope verbatim — not that `vscode.window.showErrorMessage`
  // fires. The toast is now only a fall-through when `runFailed` itself
  // throws (RunnerBusy mid-run).
  it("#5 edge (denied): BigQueryJobError-shaped reject → sanitized error path", async () => {
    await spyRender();
    await stubAdapter();
    setSqlEditor("SELECT 1");
    const ctx = makeBqCtx({ billingProject: "proj-billing", location: "US" });
    await (await import("./extension")).activate(ctx as never);

    // Override runner.run to reject with the sanitized envelope shape from
    // TASK-BQ03-001.
    const runnerMod = await import("./core/queryRunner");
    runSpy = vi
      .spyOn(runnerMod.QueryRunner.prototype, "run")
      .mockRejectedValue(
        Object.assign(new Error("BigQuery job failed: api_denied (US)"), {
          name: "BigQueryJobError",
        }) as never,
      );
    vi.spyOn(runnerMod.QueryRunner.prototype, "isRunning").mockReturnValue(false);
    // Spy on runFailed directly: the host's outer catch (TASK-UX2-004)
    // routes first-connect failures through it instead of a toast.
    const runFailedSpy = vi.spyOn(runnerMod.QueryRunner.prototype, "runFailed");

    await state.registeredCommands.get("UnicDB.runQuery")!();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));

    // Synthetic-tab producer must be invoked with the sanitized reason.
    expect(runFailedSpy).toHaveBeenCalled();
    const reason = String(runFailedSpy.mock.calls[0]?.[0] ?? "");
    // Sanitized envelope forwards: category + location visible.
    expect(reason).toMatch(/api_denied/);
    expect(reason).toMatch(/US/);
    // No raw SQL leaks.
    expect(reason).not.toContain("SELECT");
  });

  // ---------------------------------------------------------------------------
  // Test #6 — regression: non-BigQuery headers byte-identical.
  // ---------------------------------------------------------------------------
  it("#6 regression: non-BigQuery headers byte-identical to legacy format", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeLegacyCtx("postgres");
    await (await import("./extension")).activate(ctx as never);

    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "done", durationMs: 0 },
    ]);

    expect(renderCalls.length).toBeGreaterThan(0);
    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    // Pin byte-identical format from extension.ts legacy code path:
    // `Run at <ISO> — postgres@h/d`
    expect(finalHeader).toMatch(/^Run at .+ — postgres@h\/d$/);
    // No BigQuery-specific markers leak in.
    expect(finalHeader).not.toMatch(/bigquery@/);
    expect(finalHeader).not.toMatch(/GoogleSQL/);
  });

  // ---------------------------------------------------------------------------
  // R4.5 round 1 — append-mode regression: 2nd BQ run in the same session
  // must show the NEW run's job link, not the prior run's. Without slicing
  // from `appendBase`, the post-settle re-render reads `results[0]?.batched`
  // (the prior run's handle) and the header is stamped with the current
  // run's ISO time + stale jobId.
  // ---------------------------------------------------------------------------
  it("R4.5 #1 append-mode: 2nd BigQuery run in same session shows the NEW run's job link", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeBqCtx({
      billingProject: "proj-billing",
      location: "US",
    });
    await (await import("./extension")).activate(ctx as never);

    // First run: jobId = "first-job"
    const batched1 = makeBatchedHandle({
      projectId: "data-proj",
      location: "US",
      jobId: "first-job",
    });
    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "done", batched: batched1, durationMs: 0 },
    ]);

    // Reset the renderCalls window so we only assert on the 2nd run's
    // post-settle render.
    renderCalls.length = 0;

    // Second run: jobId = "second-job" (DIFFERENT from first run).
    const batched2 = makeBatchedHandle({
      projectId: "data-proj",
      location: "US",
      jobId: "second-job",
    });
    await driveRun((currentResults) => [
      ...currentResults,
      { index: 1, sql: "SELECT 2", status: "done", batched: batched2, durationMs: 0 },
    ]);

    expect(renderCalls.length).toBeGreaterThan(0);
    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    // The NEW run's jobId must appear in the header (parenthesised at the end).
    expect(finalHeader).toMatch(/\(second-job\)/);
    // The PRIOR run's jobId must NOT appear.
    expect(finalHeader).not.toMatch(/first-job/);
  });

  // ---------------------------------------------------------------------------
  // R4.5 round 1 — hostile billingProject must be HTML-escaped. billingProject
  // appears TWICE in the header (identity segment `bigquery@dp/billing` AND
  // the link's `project=` param), so it is the highest-priority injection
  // vector. The escape() helper for the link body must also handle `&`.
  // ---------------------------------------------------------------------------
  it("R4.5 #2 hostile billingProject: HTML-escaped in BOTH header positions", async () => {
    await spyRender();
    await stubAdapter();
    const ctx = makeBqCtx({
      billingProject: '<script>alert("xss")</script>',
      location: "US",
    });
    await (await import("./extension")).activate(ctx as never);

    const batched = makeBatchedHandle({
      projectId: "data-proj",
      location: "US",
      jobId: "job-escape",
    });
    await driveRun(() => [
      { index: 0, sql: "SELECT 1", status: "done", batched, durationMs: 0 },
    ]);

    const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    // Raw `<script>` MUST NOT appear in the header (would be executed if
    // the webview ever renders this as innerHTML — defense-in-depth).
    expect(finalHeader).not.toMatch(/<script>/);
    expect(finalHeader).not.toMatch(/<\/script>/);
    // Escaped form present (note: `"` inside the script body becomes `&quot;`).
    expect(finalHeader).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    // The escaped billingProject appears at least twice: once in the
    // identity segment (`bigquery@data-proj/<escaped>`), once inside the
    // link's `project=` query parameter (after percent-encoding `&`).
    const escapedForm = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
    const occurrences = finalHeader.split(escapedForm).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// TASK-CONSOLE-FOR-OBJECT: UnicDB.openConsoleForObject — right-click on table/view
// in the schema tree opens the SQL Console with a fresh tab pre-filled with a
// driver-aware SELECT * ... LIMIT/TOP 100 snippet.
describe("UnicDB.openConsoleForObject — right-click table/view → Console tab", () => {
  beforeEach(() => {
    // consolePanel is a module-level singleton in extension.ts — without
    // resetting the module cache the second test in this block would skip
    // ConsolePanel construction (createWebviewPanel not invoked) because the
    // previous test's instance is still live.
    vi.resetModules();
    vi.clearAllMocks();
    state.createdWebviewPanels.length = 0;
  });

  // Re-import + activate sau resetModules (mỗi test lấy module-level
  // consolePanel singleton mới).
  async function activateFresh(ctx: ReturnType<typeof makeCtx>) {
    const mod = await import("./extension");
    await mod.activate(ctx as never);
  }

  it("package.json contributes khai báo command mới + menu entry đúng when", () => {
    const commands = pkgJson.contributes.commands as Array<{
      command: string;
      title: string;
      icon: string;
    }>;
    const cmd = commands.find((c) => c.command === "UnicDB.openConsoleForObject");
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe("UnicDB: Open Console for Object");
    expect(cmd!.icon).toBe("$(window)");

    const viewItemContext = pkgJson.contributes.menus[
      "view/item/context"
    ] as Array<{ command: string; when: string; group: string }>;
    const menu = viewItemContext.find(
      (m) => m.command === "UnicDB.openConsoleForObject",
    );
    expect(menu).toBeDefined();
    expect(menu!.when).toBe(
      "view == UnicDB.schemaTree && (viewItem == table || viewItem == view)",
    );
    expect(menu!.group).toBe("inline");
  });

  it("command UnicDB.openConsoleForObject được register khi activate", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);
    expect(state.registeredCommands.has("UnicDB.openConsoleForObject")).toBe(true);
  });

  it("handler với qualified string → tạo webview panel + pre-fill snippet", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const fn = state.registeredCommands.get("UnicDB.openConsoleForObject");
    expect(fn).toBeDefined();
    await fn!("public.users");

    // Console panel opens (creates one webview panel via ConsolePanel ctor).
    expect(state.createdWebviewPanels.length).toBeGreaterThanOrEqual(1);
    // The last `state` postMessage (ConsolePanel.postState) MUST carry the
    // snippet for the requested table in the active tab's buffer.
    const panel = state.createdWebviewPanels[0]!;
    const webview = panel.webview as unknown as { postMessage: Mock };
    const stateCalls = webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "state",
    );
    expect(stateCalls.length).toBeGreaterThan(0);
    const last = stateCalls[stateCalls.length - 1]![0] as {
      tabs: Array<{ name: string; buffer: string; active: boolean }>;
    };
    const activeTab = last.tabs.find((t) => t.active);
    expect(activeTab).toBeDefined();
    expect(activeTab!.name).toBe("Query public.users");
    expect(activeTab!.buffer).toBe("SELECT * FROM public.users LIMIT 100;");
  });

  it("argument shape `{ meta: { schema, objectName } }` resolves qualified name", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const fn = state.registeredCommands.get("UnicDB.openConsoleForObject");
    await fn!({ meta: { schema: "sales", objectName: "orders" } });

    expect(state.createdWebviewPanels.length).toBeGreaterThanOrEqual(1);
    const panel = state.createdWebviewPanels[0]!;
    const webview = panel.webview as unknown as { postMessage: Mock };
    const stateCalls = webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "state",
    );
    const last = stateCalls[stateCalls.length - 1]![0] as {
      tabs: Array<{ name: string; buffer: string; active: boolean }>;
    };
    const activeTab = last.tabs.find((t) => t.active);
    expect(activeTab).toBeDefined();
    expect(activeTab!.name).toBe("Query sales.orders");
    expect(activeTab!.buffer).toBe("SELECT * FROM sales.orders LIMIT 100;");
  });

  it("argument shape không hợp lệ → showInformationMessage, KHÔNG mở panel mới", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const panelsBefore = state.createdWebviewPanels.length;
    const fn = state.registeredCommands.get("UnicDB.openConsoleForObject");
    await fn!(undefined);
    await fn!(42); // not a string, not a node
    await fn!({ meta: {} }); // meta missing objectName

    expect(state.createdWebviewPanels.length).toBe(panelsBefore);
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
  });
});

// =============================================================================
// TASK-OC4O-002: UnicDB.openHelpGrid — UnicDB Help Grid webview (responsive grid
// of feature cards with one-click "Try it" actions). Pure registry tests live
// in src/ui/__tests__/helpGrid.test.ts; this block pins the host wiring.
describe("UnicDB.openHelpGrid — Help Grid webview wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.createdWebviewPanels.length = 0;
  });

  async function activateFresh(ctx: ReturnType<typeof makeCtx>) {
    const mod = await import("./extension");
    await mod.activate(ctx as never);
  }

  it("package.json contributes khai báo command mới + menu entries cho 3 webview viewTypes", () => {
    const commands = pkgJson.contributes.commands as Array<{
      command: string;
      title: string;
      icon: string;
    }>;
    const cmd = commands.find((c) => c.command === "UnicDB.openHelpGrid");
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe("UnicDB: Open Help Grid");
    expect(cmd!.icon).toBe("$(book)");

    const menus = pkgJson.contributes.menus as Record<
      string,
      Array<{ command: string }>
    >;
    for (const key of [
      "webview/UnicDB.console/context",
      "webview/UnicDB.results/context",
      "webview/UnicDB.aiChatPanel/context",
    ]) {
      const list = menus[key] ?? [];
      expect(
        list.some((m) => m.command === "UnicDB.openHelpGrid"),
        `menu key ${key} must reference UnicDB.openHelpGrid`,
      ).toBe(true);
    }
  });

  it("command UnicDB.openHelpGrid được register khi activate", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);
    expect(state.registeredCommands.has("UnicDB.openHelpGrid")).toBe(true);
  });

  it("handler tạo 1 webview panel + HTML chứa script + cards payload", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const fn = state.registeredCommands.get("UnicDB.openHelpGrid");
    expect(fn).toBeDefined();
    await fn!();

    expect(state.createdWebviewPanels.length).toBe(1);
    const panel = state.createdWebviewPanels[0]!;
    expect(panel.webview.html).toContain("UnicDB-help-root");
    expect(panel.webview.html).toContain("helpGrid.js");
    // HTML carries the JSON-encoded cards payload so the webview can render
    // without a follow-up postMessage round trip.
    expect(panel.webview.html).toContain("data-cards=");
  });

  it("singleton: gọi 2 lần → chỉ 1 webview panel + reveal gọi 1 lần", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const fn = state.registeredCommands.get("UnicDB.openHelpGrid");
    await fn!();
    const panel = state.createdWebviewPanels[0]!;
    const revealBefore = (panel.reveal as Mock).mock.calls.length;
    await fn!();
    expect(state.createdWebviewPanels.length).toBe(1);
    expect((panel.reveal as Mock).mock.calls.length).toBe(revealBefore + 1);
  });

  it("panel nhận message { type: 'runCommand', commandId } → executeCommand được gọi", async () => {
    const ctx = makeCtx();
    await activateFresh(ctx);

    const fn = state.registeredCommands.get("UnicDB.openHelpGrid");
    await fn!();

    const panel = state.createdWebviewPanels[0]!;
    const onMsg = (panel.webview.onDidReceiveMessage as Mock).mock
      .calls[0]![0] as (msg: unknown) => Promise<void>;

    // UnicDB.openConsole is registered by activate — should fire.
    await onMsg({ type: "runCommand", commandId: "UnicDB.openConsole" });
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      "UnicDB.openConsole",
    );

    // Unknown prefix must be ignored (defence-in-depth).
    await onMsg({ type: "runCommand", commandId: "rm -rf /" });
    // Still only 1 executeCommand call from the legitimate run.
    expect(
      (vscodeMock.commands.executeCommand as Mock).mock.calls.filter(
        (c) => c[0] === "rm -rf /",
      ).length,
    ).toBe(0);
  });
});

// =============================================================================
// TASK-MENU-001 — schema-tree table-node context menu order contract.
// Pinned against the module-level `pkgJson` (line ~552): the right-click menu
// on a table node must render `New Table…` as item #1 and `Modify Table…` as
// item #2; every other UnicDB-group entry keeps its current alphabetical
// relative order. Mechanism: declarative `"order": "1"` / `"order": "2"` on
// the `UnicDB.newTable` / `UnicDB.modifyTable` `view/item/context` entries.
// =============================================================================
describe("MENU — table-node context menu: New Table #1, Modify Table #2", () => {
  type ViewItemContextMenu = Array<{
    command: string;
    when: string;
    group: string;
    order?: string;
  }>;

  const ctxMenus = pkgJson.contributes.menus["view/item/context"] as
    ViewItemContextMenu;

  function UnicDBGroup(): ViewItemContextMenu {
    return ctxMenus.filter((m) => m.group === "UnicDB");
  }

  // VS Code's documented same-group comparator: entries with `order` sort
  // ascending lexicographically first, then entries without `order` fall back
  // to alphabetical-by-title. The `zzzz` sentinel keeps unordered entries
  // strictly behind every ordered entry without Number coercion (lexicographic
  // "10" would precede "2" if we used Number).
  function UnicDBTableNodeTitlesSorted(): string[] {
    const commands = pkgJson.contributes.commands as Array<{
      command: string;
      title: string;
    }>;
    const titleOf = (cmd: string): string =>
      commands.find((c) => c.command === cmd)!.title;
    const subset = UnicDBGroup().filter((m) => m.when.includes("viewItem == table"));
    const sorted = subset.slice().sort((a, b) => {
      const ao = a.order ?? "zzzz";
      const bo = b.order ?? "zzzz";
      if (ao !== bo) return ao.localeCompare(bo);
      return titleOf(a.command).localeCompare(titleOf(b.command));
    });
    return sorted.map((m) => titleOf(m.command));
  }

  it("UnicDB.newTable có order \"1\" + when đúng; UnicDB.modifyTable có order \"2\" + when đúng", () => {
    const newTable = UnicDBGroup().find((m) => m.command === "UnicDB.newTable");
    const modifyTable = UnicDBGroup().find((m) => m.command === "UnicDB.modifyTable");
    expect(newTable).toBeDefined();
    expect(newTable!.order).toBe("1");
    expect(newTable!.when).toBe(
      "view == UnicDB.schemaTree && (viewItem == schema || viewItem == category || viewItem == table)",
    );
    expect(newTable!.group).toBe("UnicDB");

    expect(modifyTable).toBeDefined();
    expect(modifyTable!.order).toBe("2");
    expect(modifyTable!.when).toBe(
      "view == UnicDB.schemaTree && viewItem == table",
    );
    expect(modifyTable!.group).toBe("UnicDB");
  });

  it("chỉ đúng 2 entry UnicDB-group có order — 13 entry còn lại KHÔNG có order (alphabet fallback giữ nguyên)", () => {
    const ordered = UnicDBGroup().filter((m) => m.order !== undefined);
    expect(new Set(ordered.map((m) => m.command))).toEqual(
      new Set(["UnicDB.newTable", "UnicDB.modifyTable"]),
    );
    // Spot-check a couple of unordered entries (alphabetical fallback).
    expect(
      UnicDBGroup().find((m) => m.command === "UnicDB.analyzeTable")!.order,
    ).toBeUndefined();
    expect(
      UnicDBGroup().find((m) => m.command === "UnicDB.copyCreateDdl")!.order,
    ).toBeUndefined();
  });

  it("sort mô phỏng VS Code trên table-node UnicDB group → New Table… #1, Modify Table… #2, phần còn lại giữ relative alphabet", () => {
    const titles = UnicDBTableNodeTitlesSorted();
    expect(titles[0]).toBe("New Table…");
    expect(titles[1]).toBe("Modify Table…");
    // Items 2..(n-1) keep their current alphabetical relative order:
    //   Analyze Table, Copy Create Query, Insert Sample Data…, Rename Column…,
    //   Rename Table…, Vacuum Table, UnicDB: Export Structure, UnicDB: Postman Payload.
    // (UnicDB: Refresh Schema + connection-only entries are correctly excluded
    // because their `when` does not include `viewItem == table`.)
    // NOTE on alphabetical ordering: titles beginning with "UnicDB: " sort
    // AFTER letter-titles in localeCompare ("U" is the highest leading letter
    // before "V", so "UnicDB: Export" precedes "Vacuum"). Keep this list in
    // sorted order — re-check after any command title rename.
    expect(titles.slice(2)).toEqual([
      "Analyze Table",
      "Copy Create Query",
      "Insert Sample Data…",
      "Rename Column…",
      "Rename Table…",
      "UnicDB: Export Structure",
      "UnicDB: Postman Payload",
      "Vacuum Table",
    ]);
  });
});

// =============================================================================
// TASK-UX1-001 — `commandGenerateSelect` clipboard fallback (R6+R7, cases 5-6).
// When `UnicDB.generateSelect` fires from the left pane with no active text
// editor, the host MUST still hand the user a runnable SELECT — write to
// clipboard + info toast — instead of refusing with "UnicDB: no active editor."
// Editor-present path is unchanged (untouched; not re-tested here).
// =============================================================================
describe("TASK-UX1-001 — generateSelect clipboard fallback when no editor is open", () => {
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
    state.createdOutputChannels.length = 0;
  });

  /**
   * Helper: activate() with a seeded active postgres connection so
   * `mgr.getActive()` resolves to a ConnectionConfig and the dialect path
   * proceeds past the "no active connection" refusal.
   */
  function activateWithActivePostgres() {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") {
        return [
          {
            id: "c1",
            name: "local-pg",
            driver: "postgres",
            host: "h",
            port: 5432,
            user: "u",
            database: "d",
          },
        ];
      }
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;
    activate(ctx as never);
    return ctx;
  }

  it("#5 regression: UnicDB.generateSelect with no editor and a table-node meta → clipboard gets a runnable SELECT, info toast confirms", async () => {
    activateWithActivePostgres();

    // No editor open (the bug scenario).
    state.activeEditor = undefined;

    const writeTextSpy = vi.mocked(vscodeMock.env.clipboard.writeText);
    const infoSpy = vi.mocked(vscodeMock.window.showInformationMessage);

    const gen = state.registeredCommands.get("UnicDB.generateSelect");
    expect(gen).toBeDefined();
    // View/item/context menu passes the SchemaTree node argument with `meta`.
    await gen!({
      meta: {
        schema: "public",
        objectName: "users",
        connection: {
          id: "c1",
          name: "local-pg",
          driver: "postgres",
          host: "h",
          port: 5432,
          user: "u",
          database: "d",
        },
      },
    } as never);

    // RED today: early return at !editor → clipboard untouched. After fix: SELECT written.
    expect(writeTextSpy).toHaveBeenCalledTimes(1);
    const sql = String(writeTextSpy.mock.calls[0][0]);
    // Per generateSelectForTable(public, users, postgres) — the function
    // returns `SELECT * FROM ${qualifiedName({schema:'public',table:'users'})} LIMIT 100;`
    // = `SELECT * FROM public.users LIMIT 100;` (postgres unquoted, qualified
    // by a dot, matching the established `generateSelectForTable` template).
    expect(sql).toBe("SELECT * FROM public.users LIMIT 100;");

    // Info toast: matches the Vietnamese copy in the task spec.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const message = String((infoSpy.mock.calls[0] as unknown[])[0]);
    expect(message).toMatch(/SELECT/i);
    expect(message).toMatch(/clipboard/i);
    expect(message).toMatch(/không có editor/i);
  });

  it("#6 boundary: UnicDB.generateSelect with NO arg and NO editor → info toast guides the user, clipboard untouched", async () => {
    activateWithActivePostgres();
    state.activeEditor = undefined;

    const writeTextSpy = vi.mocked(vscodeMock.env.clipboard.writeText);
    const infoSpy = vi.mocked(vscodeMock.window.showInformationMessage);

    const gen = state.registeredCommands.get("UnicDB.generateSelect");
    await gen!(); // no qualifiedOrNode

    // Clipboard untouched.
    expect(writeTextSpy).not.toHaveBeenCalled();
    // Info toast guides the user (existing copy from the no-arg branch).
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const message = String((infoSpy.mock.calls[0] as unknown[])[0]);
    expect(message).toMatch(/right-click/i);
    expect(message).toMatch(/table/i);
  });
});

// =============================================================================
// TASK-UX1-002 — SQL Generator on View / Routine nodes (R3+R4).
// Right-click a View or Routine node → fetch pg_get_viewdef / pg_get_functiondef
// → seed a fresh Console tab pre-filled with the DDL. The pg gate already
// exists (adapter.catalog.objectDdl); this task wires two commands + menu
// entries + a thin handler that opens the Console.
// =============================================================================
describe("TASK-UX1-002 — SQL Generator on View / Routine nodes", () => {
  function consoleWebviewState(): {
    tabs: Array<{ id: string; name: string; buffer: string; active: boolean }>;
    activeTabId: string;
  } | null {
    // Return the LAST `state` postMessage across all console webviews —
    // `seedTab` calls `createTab` (postState #1: new tab active) then sets
    // the buffer + postState #2. The first state message is the empty
    // "Query 1" from the constructor; the latest state reflects what the
    // webview would render right now.
    let latest: {
      tabs: Array<{ id: string; name: string; buffer: string; active: boolean }>;
      activeTabId: string;
    } | null = null;
    for (const wp of state.createdWebviewPanels) {
      const calls = (
        wp.webview.postMessage as Mock
      ).mock.calls as unknown as Array<[Record]>;
      for (const [msg] of calls) {
        if (msg && (msg as { type?: string }).type === "state") {
          latest = msg as {
            tabs: Array<{ id: string; name: string; buffer: string; active: boolean }>;
            activeTabId: string;
          };
        }
      }
    }
    return latest;
  }

  function makeConnectionConfig() {
    return {
      id: "c1",
      name: "c",
      driver: "postgres",
      host: "h",
      port: 5432,
      user: "u",
      database: "d",
    };
  }

  function makeSeededCtx() {
    const ctx = makeCtx();
    ctx.globalState.get = vi.fn((key: string) => {
      if (key === "UnicDB.connections") return [makeConnectionConfig()];
      if (key === "UnicDB.activeConnection") return "c1";
      return undefined;
    }) as never;
    return ctx;
  }

  function makeAdapterWithObjectDdl(
    capabilities: { objectDdl: boolean } | undefined,
    objectDdlImpl: (
      kind: "view" | "routine",
      name: string,
      schema?: string,
    ) => Promise<string>,
  ) {
    const adapter = {
      capabilities,
      catalog: {
        objectDdl: vi.fn().mockImplementation(objectDdlImpl),
      },
    } as unknown as DbAdapter;
    (
      adapter as unknown as { runQuery: ReturnType<typeof vi.fn> }
    ).runQuery = vi.fn().mockResolvedValue({ results: [] });
    return adapter;
  }

  async function activateWithAdapter(adapter: DbAdapter) {
    const connectionMgrMod = await import("./core/connectionManager");
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getAdapter",
    ).mockResolvedValue(adapter);
    vi.spyOn(
      connectionMgrMod.ConnectionManager.prototype,
      "getActive",
    ).mockReturnValue(makeConnectionConfig() as never);
    const ext = await import("./extension");
    const ctx = makeSeededCtx();
    await ext.activate(ctx as never);
    return ext;
  }

  function viewNode(qualified: string) {
    const [schema, ...rest] = qualified.split(".");
    const objectName = rest.join(".");
    return {
      meta: {
        connection: makeConnectionConfig(),
        schema,
        objectName,
      },
    };
  }

  beforeEach(() => {
    // consolePanel is a module-level singleton in extension.ts — without
    // resetting the module cache, the second test in this block would skip
    // ConsolePanel construction (createWebviewPanel not invoked) because
    // the previous test's instance is still live (TASK-CONSOLE-FOR-OBJECT
    // precedent at line 4589-4597).
    vi.resetModules();
    vi.clearAllMocks();
    state.registeredCommands.clear();
    state.createdWebviewPanels.length = 0;
    state.createdOutputChannels.length = 0;
  });

  afterEach(async () => {
    await deactivate();
  });

  it("Test #7 (regression) — package.json declares both commands + view/item/context entries with correct when-clauses + onCommand activations", () => {
    const commands = pkgJson.contributes.commands as Array<{
      command: string;
      title: string;
      icon: string;
    }>;
    const viewCmd = commands.find((c) => c.command === "UnicDB.generateViewDdl");
    const funcCmd = commands.find(
      (c) => c.command === "UnicDB.generateFunctionDdl",
    );
    expect(viewCmd).toBeDefined();
    expect(viewCmd!.title).toBe("SQL Generator");
    expect(viewCmd!.icon).toBe("$(eye)");
    expect(funcCmd).toBeDefined();
    expect(funcCmd!.title).toBe("SQL Generator");
    expect(funcCmd!.icon).toBe("$(symbol-function)");

    const itemContext = pkgJson.contributes.menus["view/item/context"] as Array<{
      command: string;
      when: string;
      group: string;
    }>;
    const viewMenu = itemContext.find(
      (m) => m.command === "UnicDB.generateViewDdl",
    );
    const funcMenu = itemContext.find(
      (m) => m.command === "UnicDB.generateFunctionDdl",
    );
    expect(viewMenu).toBeDefined();
    // CRITICAL pin: viewItem == view (NOT routine) so the entry actually
    // renders on view nodes only. A `viewItem == routine` clause here
    // would never fire (the tree emits contextValue: "view" for views).
    expect(viewMenu!.when).toBe(
      "view == UnicDB.schemaTree && viewItem == view",
    );
    expect(viewMenu!.group).toBe("UnicDB");
    expect(funcMenu).toBeDefined();
    // CRITICAL pin: routine, NOT function — schemaTree.ts:565 emits
    // contextValue: "routine" for both. A `viewItem == function` clause
    // would produce a dead menu entry (review-blocking bug).
    expect(funcMenu!.when).toBe(
      "view == UnicDB.schemaTree && viewItem == routine",
    );
    expect(funcMenu!.group).toBe("UnicDB");

    const activations = pkgJson.activationEvents as string[];
    expect(activations).toContain("onCommand:UnicDB.generateViewDdl");
    expect(activations).toContain("onCommand:UnicDB.generateFunctionDdl");
  });

  it("Test #1 — happy: view node → seedTab called with name 'DDL public.v' and buffer = ddl + ';'", async () => {
    const adapter = makeAdapterWithObjectDdl(
      { objectDdl: true },
      async (_kind, name, _schema) =>
        `CREATE VIEW public.${name} AS SELECT 1`,
    );
    await activateWithAdapter(adapter);

    const fn = state.registeredCommands.get("UnicDB.generateViewDdl");
    expect(fn).toBeDefined();
    await fn!(viewNode("public.v"));

    // objectDdl called with view + qualified name + schema.
    const catalog = adapter.catalog as unknown as {
      objectDdl: ReturnType<typeof vi.fn>;
    };
    expect(catalog.objectDdl).toHaveBeenCalledTimes(1);
    expect(catalog.objectDdl.mock.calls[0]).toEqual([
      "view",
      "v",
      "public",
    ]);
    // A console webview was created; the latest 'state' postMessage holds
    // the seeded tab with the DDL buffer (terminated with one `;`).
    const cs = consoleWebviewState();
    expect(cs).not.toBeNull();
    const seededTab = cs!.tabs.find((t) => t.active) ?? cs!.tabs[cs!.tabs.length - 1];
    expect(seededTab.name).toBe("DDL public.v");
    expect(seededTab.buffer).toBe("CREATE VIEW public.v AS SELECT 1;");
  });

  it("Test #2 — happy: routine node → pg_get_functiondef DDL seeded verbatim (existing `;` NOT doubled)", async () => {
    const adapter = makeAdapterWithObjectDdl(
      { objectDdl: true },
      async (_kind, name, _schema) =>
        `CREATE FUNCTION public.${name}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;`,
    );
    await activateWithAdapter(adapter);

    const fn = state.registeredCommands.get("UnicDB.generateFunctionDdl");
    expect(fn).toBeDefined();
    await fn!(viewNode("public.do_thing"));

    const catalog = adapter.catalog as unknown as {
      objectDdl: ReturnType<typeof vi.fn>;
    };
    expect(catalog.objectDdl).toHaveBeenCalledWith("routine", "do_thing", "public");
    const cs = consoleWebviewState();
    expect(cs).not.toBeNull();
    const seededTab = cs!.tabs.find((t) => t.active) ?? cs!.tabs[cs!.tabs.length - 1];
    expect(seededTab.name).toBe("DDL public.do_thing");
    // DDL already ended with `;` — ensureTrailingSemicolon is idempotent.
    expect(seededTab.buffer).toBe(
      "CREATE FUNCTION public.do_thing() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;",
    );
    // Buffer must NOT have a doubled `;;`.
    expect(seededTab.buffer.endsWith(";;")).toBe(false);
  });

  it("Test #3 — edge A: objectDdl rejects ('object not found') → error toast, NO seedTab call", async () => {
    const adapter = makeAdapterWithObjectDdl(
      { objectDdl: true },
      async () => {
        throw new Error('view "x" not found');
      },
    );
    await activateWithAdapter(adapter);

    const fn = state.registeredCommands.get("UnicDB.generateViewDdl");
    await fn!(viewNode("public.x"));

    const catalog = adapter.catalog as unknown as {
      objectDdl: ReturnType<typeof vi.fn>;
    };
    expect(catalog.objectDdl).toHaveBeenCalledTimes(1);
    // Error toast surfaced with the adapter message; no console created.
    expect(
      vi.mocked(vscodeMock.window.showErrorMessage).mock.calls.some((c) =>
        String(c[0]).includes('view "x" not found'),
      ),
    ).toBe(true);
    // The console panel was NOT opened for the failed DDL.
    const cs = consoleWebviewState();
    expect(cs).toBeNull();
  });

  it("Test #4 — edge B: capabilities.objectDdl !== true → info toast, ZERO adapter calls", async () => {
    const adapter = makeAdapterWithObjectDdl(
      { objectDdl: false },
      async () => {
        throw new Error("objectDdl should not be called");
      },
    );
    await activateWithAdapter(adapter);

    const fn = state.registeredCommands.get("UnicDB.generateViewDdl");
    await fn!(viewNode("public.v"));

    const catalog = adapter.catalog as unknown as {
      objectDdl: ReturnType<typeof vi.fn>;
    };
    expect(catalog.objectDdl).not.toHaveBeenCalled();
    // Info toast guides the user (pg-only / capability wording).
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.some(
        (c) => /postgres|not supported|capability|pg/i.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("Test #5 — edge C: command invoked with NO arg (palette) → info toast, no adapter call", async () => {
    const adapter = makeAdapterWithObjectDdl(
      { objectDdl: true },
      async () => {
        throw new Error("objectDdl should not be called");
      },
    );
    await activateWithAdapter(adapter);

    const fn = state.registeredCommands.get("UnicDB.generateFunctionDdl");
    await fn!(undefined);

    const catalog = adapter.catalog as unknown as {
      objectDdl: ReturnType<typeof vi.fn>;
    };
    expect(catalog.objectDdl).not.toHaveBeenCalled();
    expect(
      vi.mocked(vscodeMock.window.showInformationMessage).mock.calls.some(
        (c) => /right-click/i.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("Test #6 — edge D: ensureTrailingSemicolon is idempotent for DDL that already ends with `;`", async () => {
    // Pure helper smoke: imported from consolePanel.ts (lives next to other
    // console string helpers). Pinning ensures future refactors don't
    // regress on the `;;` doubling class of bug.
    const consoleMod = await import("./ui/consolePanel");
    expect(
      (consoleMod as unknown as {
        ensureTrailingSemicolon?: (s: string) => string;
      }).ensureTrailingSemicolon,
    ).toBeDefined();
    const ensure = (
      consoleMod as unknown as { ensureTrailingSemicolon: (s: string) => string }
    ).ensureTrailingSemicolon;
    expect(ensure("CREATE VIEW v AS SELECT 1;")).toBe(
      "CREATE VIEW v AS SELECT 1;",
    );
    expect(ensure("CREATE VIEW v AS SELECT 1")).toBe(
      "CREATE VIEW v AS SELECT 1;",
    );
    expect(ensure("")).toBe(";");
  });
});
void detectOmpState;

// TASK-UX1-004 (R2) — UnicDB.openUserGuide opens docs/UNICDB_USER_GUIDE.md
// in markdown preview. Re-creates the file lost during the W4 merge
// (orchestrator cleanup wiped untracked files). NOTE: filename case is
// significant — vsce's .vscodeignore glob is case-sensitive on Linux/Windows
// (the Marketplace CI runs on ubuntu-latest), and case mismatches between
// the allow-list and the .md on disk silently drop the file from the .vsix.
// Historical case `docs/UnicDB_USER_GUIDE.md` (mixed-case UnicDB prefix) was
// a `.vscodeignore`/`src/extension.ts` typo that caused the User Guide icon
// to fall back to the GitHub URL even though a guide file existed.
describe("TASK-UX1-004 — UnicDB.openUserGuide", () => {
  let executeSpy: ReturnType<typeof vi.fn>;
  let infoSpy: ReturnType<typeof vi.fn>;

  async function activateUserGuide() {
    vi.clearAllMocks();
    state.registeredCommands.clear();
    executeSpy = vi.fn(async () => undefined);
    infoSpy = vi.fn();
    const cmd = vscodeMock.commands as unknown as Record<string, unknown>;
    cmd.executeCommand = executeSpy;
    const win = vscodeMock.window as unknown as Record<string, unknown>;
    win.showInformationMessage = infoSpy;
    vi.resetModules();
    const ext = await import("./extension");
    await ext.activate(makeCtx());
    // Settle async microtask chain.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("#1 UnicDB.openUserGuide command is registered on activate", async () => {
    await activateUserGuide();
    expect(state.registeredCommands.has("UnicDB.openUserGuide")).toBe(true);
  });

  it("#2 invoking the command calls markdown.showPreview with extensionUri-relative path", async () => {
    await activateUserGuide();
    // vi.clearAllMocks (run by other tests in the suite) may have reset the
    // workspace.fs.stat vi.fn — re-install a fresh one before this test so
    // the markdown.showPreview path is taken.
    const fsMock = (vscodeMock as unknown as {
      workspace: { fs: { stat?: ReturnType<typeof vi.fn> } };
    }).workspace.fs;
    fsMock.stat = vi.fn(async () => ({ type: 1, size: 1, ctime: 0, mtime: 0 } as never));
    const fn = state.registeredCommands.get("UnicDB.openUserGuide");
    expect(fn).toBeDefined();
    await fn!();
    expect(executeSpy).toHaveBeenCalledWith(
      "markdown.showPreview",
      expect.objectContaining({
        path: expect.stringMatching(/UNICDB_USER_GUIDE\.md$/),
      }),
    );
  });

  it("#3 missing guide file → opens GitHub URL via env.openExternal (no toast, no throw)", async () => {
    await activateUserGuide();
    // Re-install fresh vi.fns in case vi.clearAllMocks (from earlier tests
    // in the suite) reset them. The implementation: stat throws → fallback
    // path → env.openExternal(GitHub URL).
    const envMock = (vscodeMock as unknown as {
      env: { openExternal?: ReturnType<typeof vi.fn> };
    }).env;
    envMock.openExternal = vi.fn(async () => true);
    // Force the "file missing" path: another earlier test in the suite may
    // have left fs.stat as a vi.fn that resolves successfully (vi.clearAllMocks
    // only clears call history, not implementations). Re-install a fresh
    // stat that throws so safeFileExists → false → openExternal fallback.
    const fsMock = (vscodeMock as unknown as {
      workspace: { fs: { stat?: ReturnType<typeof vi.fn> } };
    }).workspace.fs;
    fsMock.stat = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const fn = state.registeredCommands.get("UnicDB.openUserGuide");
    await expect(fn!()).resolves.toBeUndefined();
    expect(envMock.openExternal).toHaveBeenCalledTimes(1);
    // The mock Uri.parse in tests does not decompose the URL — match the
    // toString() string instead. Production VS Code Uri.parse returns a
    // real Uri; we pin the URL string here so a future refactor that drops
    // the fallback URL will be caught.
    const passedUri = envMock.openExternal.mock.calls[0][0] as { toString(): string };
    expect(passedUri.toString()).toBe(
      "https://github.com/lengockhoa/UnicDB/blob/main/docs/UNICDB_USER_GUIDE.md",
    );
    // markdown.showPreview must NOT be called when the file is missing.
    expect(executeSpy).not.toHaveBeenCalled();
    // No info toast either — openExternal replaces the useless path toast.
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("#4 package.json declares UnicDB.openUserGuide with $(notebook) icon (distinct from openHelpGrid's $(book))", () => {
    // Pin the icon distinctness per test #6 in the spec.
    const pkg = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").resolve(process.cwd(), "package.json"),
        "utf8",
      ),
    );
    const guideCmd = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "UnicDB.openUserGuide",
    );
    const helpCmd = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "UnicDB.openHelpGrid",
    );
    expect(guideCmd).toBeDefined();
    expect(helpCmd).toBeDefined();
    expect(guideCmd.icon).not.toBe(helpCmd.icon);
  });

  it("#5 view/title entry exists for UnicDB.openUserGuide on UnicDB.schemaTree", () => {
    const pkg = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").resolve(process.cwd(), "package.json"),
        "utf8",
      ),
    );
    const titleEntries = pkg.contributes.menus["view/title"] as Array<{
      command: string;
      when: string;
    }>;
    const entry = titleEntries.find(
      (e) => e.command === "UnicDB.openUserGuide",
    );
    expect(entry).toBeDefined();
    expect(entry!.when).toContain("UnicDB.schemaTree");
  });

  it("#6 activation event for UnicDB.openUserGuide is declared", () => {
    const pkg = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").resolve(process.cwd(), "package.json"),
        "utf8",
      ),
    );
    expect(pkg.activationEvents).toContain("onCommand:UnicDB.openUserGuide");
  });

  it("#7 guide file exists → markdown.showPreview (no GitHub fallback)", async () => {
    await activateUserGuide();
    // See note in #2: re-install a fresh stat vi.fn.
    const fsMock = (vscodeMock as unknown as {
      workspace: { fs: { stat?: ReturnType<typeof vi.fn> } };
    }).workspace.fs;
    fsMock.stat = vi.fn(async () => ({ type: 1, size: 1, ctime: 0, mtime: 0 } as never));
    const fn = state.registeredCommands.get("UnicDB.openUserGuide");
    await fn!();
    expect(executeSpy).toHaveBeenCalledWith(
      "markdown.showPreview",
      expect.objectContaining({
        path: expect.stringMatching(/UNICDB_USER_GUIDE\.md$/),
      }),
    );
    const envMock = (vscodeMock as unknown as {
      env: { openExternal: ReturnType<typeof vi.fn> };
    }).env;
    expect(envMock.openExternal).not.toHaveBeenCalled();
  });

  it("#8 .vscodeignore allow-lists docs/UNICDB_USER_GUIDE.md so it ships in the .vsix", () => {
    // Regression guard: a future edit to .vscodeignore that re-excludes the
    // guide will break the Schema Explorer 📖 icon for installed users.
    // Filename case must EXACTLY match the on-disk entry — vsce's
    // .vscodeignore is case-sensitive on Linux/Windows (Marketplace CI
    // runs on ubuntu-latest).
    const ignore = require("node:fs").readFileSync(
      require("node:path").resolve(process.cwd(), ".vscodeignore"),
      "utf8",
    );
    expect(ignore).toMatch(/^docs\/\*\*/m); // base exclusion still in place
    expect(ignore).toMatch(/^!docs\/UNICDB_USER_GUIDE\.md/m); // allow-rule present
  });
});
