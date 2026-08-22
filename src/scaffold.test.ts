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
    const commandIds = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const cmd of requiredCommands) {
      expect(commandIds).toContain(cmd);
    }

    // keybindings có cmd+enter & ctrl+enter → vsdb.runQuery (when editorTextFocus && resourceLangId == sql)
    expect(Array.isArray(pkg.contributes.keybindings)).toBe(true);
    const runKeybindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "vsdb.runQuery",
    );
    expect(runKeybindings.length).toBeGreaterThanOrEqual(2);
    const mac = runKeybindings.find((k: { mac?: string }) => k.mac === "cmd+enter");
    const win = runKeybindings.find((k: { win?: string }) => k.win === "ctrl+enter");
    expect(mac).toBeTruthy();
    expect(win).toBeTruthy();

    // viewsContainers.activitybar PHẢI tồn tại — regression v1.2.1: mất key này
    // → mất icon VSDB trên Activity Bar sau reload window.
    const activitybar = pkg.contributes.viewsContainers?.activitybar;
    expect(activitybar, "viewsContainers.activitybar must exist").toBeTruthy();
    expect(activitybar[0].id).toBe("vsdb");
    expect(activitybar[0].icon).toBe("media/vsdb.svg");

    // views.vsdb.schemaTree
    expect(pkg.contributes.views.vsdb).toBeTruthy();

    // DataGrip-style: mọi command có icon; view/title chỉ icon (navigation group),
    // refresh đứng trước add để toolbar không đổi chỗ khi connection xuất hiện.
    for (const cmd of pkg.contributes.commands) {
      expect(cmd.icon, `command ${cmd.command} phải có icon`).toMatch(/^\$\(/);
    }
    const viewTitle = pkg.contributes.menus["view/title"];
    expect(viewTitle).toBeTruthy();
    expect(viewTitle.every((m: { group?: string }) => m.group === "navigation")).toBe(true);
    expect(viewTitle[0].command).toBe("vsdb.refreshSchema");
    expect(viewTitle[1].command).toBe("vsdb.addConnection");

    // Empty state: viewsWelcome thay cho tree node "No connections" — không còn
    // node placeholder nào trong tree.
    const welcome = pkg.contributes.viewsWelcome?.find(
      (w: { view: string }) => w.view === "vsdb.schemaTree",
    );
    expect(welcome?.contents).toContain("command:vsdb.addConnection");

    // configuration
    expect(pkg.contributes.configuration).toBeTruthy();
    expect(pkg.contributes.configuration.properties["vsdb.showRunLens"]).toBeTruthy();
    expect(pkg.contributes.configuration.properties["vsdb.showRunLens"].type).toBe("boolean");
    expect(pkg.contributes.configuration.properties["vsdb.batchSize"]).toBeTruthy();
    expect(pkg.contributes.configuration.properties["vsdb.batchSize"].type).toBe("number");
  });

  it("package.json declares hideSystemSchemas setting enabled by default", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const setting = pkg.contributes.configuration.properties["vsdb.hideSystemSchemas"];

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
});
