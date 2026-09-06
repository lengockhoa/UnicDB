import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

vi.mock("vscode", () => ({
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: () => ({ dispose: () => {} }),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    createStatusBarItem: vi.fn(() => ({
      text: "",
      tooltip: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    createWebviewPanel: vi.fn(() => ({
      webview: { html: "", postMessage: vi.fn(), onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })), asWebviewUri: vi.fn(), cspSource: "" },
      onDidDispose: vi.fn(() => ({ dispose: () => {} })),
      reveal: vi.fn(),
      dispose: vi.fn(),
      visible: false,
    })),
    createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    get workspaceFolders() {
      return undefined;
    },
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: () => {} })),
    executeCommand: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p, scheme: "file", toString: () => p }),
    parse: (s: string) => ({ toString: () => s }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({ path: p.join("/"), toString: () => `${String(u)}/${p.join("/")}` })),
  },
  CodeLens: vi.fn(),
  Range: vi.fn(),
  ViewColumn: { Beside: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeDataProvider: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: vi.fn(),
  ThemeColor: vi.fn(),
  languages: {
    registerCodeLensProvider: vi.fn(() => ({ dispose: () => {} })),
  },
}));

describe("scaffold", () => {
  it("placeholder vitest chạy được", () => {
    expect(1 + 1).toBe(2);
  });

  it("extension.ts exports activate function with correct signature", async () => {
    const ext = await import("../src/extension");
    expect(typeof ext.activate).toBe("function");
    expect(typeof ext.deactivate).toBe("function");
  });

  it("package.json manifest hợp lệ — đủ commands (≥ 10), keybindings, views, configuration", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    // main + engines.vscode
    expect(pkg.main).toBe("dist/extension.js");
    expect(pkg.engines.vscode).toBeTruthy();

    // commands ≥ 10
    expect(Array.isArray(pkg.contributes.commands)).toBe(true);
    expect(pkg.contributes.commands.length).toBeGreaterThanOrEqual(10);

    const requiredCommands = [
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
    ];
    const commandIds = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const cmd of requiredCommands) {
      expect(commandIds).toContain(cmd);
    }

    // keybindings có cmd+enter & ctrl+enter → UnicDB.runQuery (when editorTextFocus && resourceLangId == sql)
    expect(Array.isArray(pkg.contributes.keybindings)).toBe(true);
    const runKeybindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "UnicDB.runQuery",
    );
    expect(runKeybindings.length).toBeGreaterThanOrEqual(2);
    const mac = runKeybindings.find((k: { mac?: string }) => k.mac === "cmd+enter");
    const win = runKeybindings.find((k: { win?: string }) => k.win === "ctrl+enter");
    expect(mac).toBeTruthy();
    expect(win).toBeTruthy();

    // viewsContainers.activitybar PHẢI tồn tại — regression v1.2.1: mất key này
    // → mất icon UnicDB trên Activity Bar sau reload window.
    const activitybar = pkg.contributes.viewsContainers?.activitybar;
    expect(activitybar, "viewsContainers.activitybar must exist").toBeTruthy();
    expect(activitybar[0].id).toBe("UnicDB");
    expect(activitybar[0].icon).toBe("media/UnicDB.svg");

    // views.UnicDB.schemaTree
    expect(pkg.contributes.views.UnicDB).toBeTruthy();

    // DataGrip-style: mọi command có icon; view/title chỉ icon (navigation group),
    // refresh đứng trước add để toolbar không đổi chỗ khi connection xuất hiện.
    // Icon có thể là codicon string ("$(…)") HOẶC object {light,dark} trỏ tới SVG.
    for (const cmd of pkg.contributes.commands) {
      const ok =
        typeof cmd.icon === "string"
          ? /^\$\(/.test(cmd.icon)
          : cmd.icon && typeof cmd.icon === "object" && typeof cmd.icon.light === "string";
      expect(ok, `command ${cmd.command} phải có icon (codicon hoặc {light,dark})`).toBe(true);
    }
    const viewTitle = pkg.contributes.menus["view/title"];
    expect(viewTitle).toBeTruthy();
    expect(viewTitle.every((m: { group?: string }) => m.group === "navigation")).toBe(true);
    // Toolbar order: refresh, add connection, AI settings (sparkle — 1.53.x),
    // filter, AI chat (TASK-009), clear-filter (chỉ hiện khi filter active —
    // luôn cuối, vị trí ổn định khi connection/filter state xuất hiện).
    expect(viewTitle[0].command).toBe("UnicDB.refreshSchema");
    expect(viewTitle[1].command).toBe("UnicDB.addConnection");
    expect(viewTitle[2].command).toBe("UnicDB.openAiSettings");
    expect(viewTitle[3].command).toBe("UnicDB.filterSchemaTree");
    expect(viewTitle[4].command).toBe("UnicDB.aiChat");
    expect(viewTitle[5].command).toBe("UnicDB.clearSchemaTreeFilter");

    // Empty state: viewsWelcome thay cho tree node "No connections" — không còn
    // node placeholder nào trong tree.
    const welcome = pkg.contributes.viewsWelcome?.find(
      (w: { view: string }) => w.view === "UnicDB.schemaTree",
    );
    expect(welcome?.contents).toContain("command:UnicDB.addConnection");

    // configuration
    expect(pkg.contributes.configuration).toBeTruthy();
    expect(pkg.contributes.configuration.properties["UnicDB.showRunLens"]).toBeTruthy();
    expect(pkg.contributes.configuration.properties["UnicDB.showRunLens"].type).toBe("boolean");
    expect(pkg.contributes.configuration.properties["UnicDB.batchSize"]).toBeTruthy();
    expect(pkg.contributes.configuration.properties["UnicDB.batchSize"].type).toBe("number");
  });

  it("package.json declares hideSystemSchemas setting enabled by default", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const setting = pkg.contributes.configuration.properties["UnicDB.hideSystemSchemas"];

    expect(setting).toBeTruthy();
    expect(setting.type).toBe("boolean");
    expect(setting.default).toBe(true);
    expect(setting.description).toBeTruthy();
  });

  it("icon.png exists and >0 bytes", () => {
    const iconPath = path.resolve(__dirname, "..", "media", "icon.png");
    expect(fs.existsSync(iconPath)).toBe(true);
    expect(fs.statSync(iconPath).size).toBeGreaterThan(0);
  });

  // ===== TASK-605: Run .sh fix (activation events + shellscript config)  =====

  it("Test #1 (TASK-605) — activationEvents có 'onCommand:UnicDB.runScript' và 'onLanguage:shellscript'", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const events: string[] = Array.isArray(pkg.activationEvents) ? pkg.activationEvents : [];
    expect(events).toContain("onCommand:UnicDB.runScript");
    expect(events).toContain("onLanguage:shellscript");
  });

  it("Test #2 (TASK-605) — editor/title menu có UnicDB.runScript cho shellscript + command có icon + showRunLensSh config", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    const editorTitle = pkg.contributes?.menus?.["editor/title"] ?? [];
    const runScriptEntry = editorTitle.find(
      (m: { command: string }) => m.command === "UnicDB.runScript",
    );
    expect(runScriptEntry, "editor/title menu cần có UnicDB.runScript").toBeTruthy();
    expect(runScriptEntry.when).toMatch(/shellscript/);
    expect(runScriptEntry.group).toBe("navigation");

    const runScriptCmd = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "UnicDB.runScript",
    );
    expect(runScriptCmd).toBeTruthy();
    expect(runScriptCmd.icon).toMatch(/^\$\(/);

    const showRunLensSh = pkg.contributes.configuration?.properties?.["UnicDB.showRunLensSh"];
    expect(showRunLensSh, "UnicDB.showRunLensSh config phải tồn tại").toBeTruthy();
    expect(showRunLensSh.type).toBe("boolean");
    expect(showRunLensSh.default).toBe(true);
  });
});
