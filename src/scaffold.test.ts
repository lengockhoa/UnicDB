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
    // v1.53.30: icon chuyển từ media/UnicDB.svg → media/icon.png vì VS Code
    // activity-bar icon masker âm thầm từ chối render SVG monochrome cho một
    // số users (icon biến mất khỏi Workbench visibility menu ngay cả sau
    // Reload / Disable+Re-enable / full uninstall+reinstall). PNG render
    // universally — same icon đã được dùng cho top-level `icon` field (visible
    // trong Extensions panel và extension detail page).
    const activitybar = pkg.contributes.viewsContainers?.activitybar;
    expect(activitybar, "viewsContainers.activitybar must exist").toBeTruthy();
    expect(activitybar[0].id).toBe("UnicDB");
    expect(activitybar[0].icon).toBe("media/icon.png");

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
    // Toolbar order: refresh, AI settings (sparkle — 1.53.x), add connection
    // (plus), filter, AI chat (TASK-009), clear-filter (chỉ hiện khi filter
    // active — luôn cuối, vị trí ổn định khi connection/filter state xuất hiện).
    expect(viewTitle[0].command).toBe("UnicDB.refreshSchema");
    expect(viewTitle[1].command).toBe("UnicDB.openAiSettings");
    expect(viewTitle[2].command).toBe("UnicDB.addConnection");
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

  // ===== TASK-SH-001: UnicDB.runShellSelection manifest + shellscript keybindings =====

  it("Test #1 (TASK-SH-001) — keybindings chứa UnicDB.runShellSelection với mac cmd+enter (shellscript)", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    expect(Array.isArray(pkg.contributes.keybindings)).toBe(true);
    const shellKeybindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "UnicDB.runShellSelection",
    );
    expect(shellKeybindings.length).toBeGreaterThanOrEqual(1);

    const mac = shellKeybindings.find((k: { mac?: string }) => k.mac === "cmd+enter");
    expect(mac, "phải có row mac=cmd+enter cho UnicDB.runShellSelection").toBeTruthy();
    expect(mac.when).toBe("editorTextFocus && resourceLangId == shellscript");
  });

  it("Test #2 (TASK-SH-001) — command UnicDB.runShellSelection + activation event được contribute", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    const runShellSelectionCmd = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "UnicDB.runShellSelection",
    );
    expect(runShellSelectionCmd, "contributes.commands phải có UnicDB.runShellSelection").toBeTruthy();
    expect(runShellSelectionCmd.title).toMatch(/^UnicDB: Run Selection/);
    expect(runShellSelectionCmd.category).toBe("UnicDB");
    // icon codicon (string starting with $(...)) — same shape as UnicDB.runScript
    expect(
      typeof runShellSelectionCmd.icon === "string" && /^\$\(/.test(runShellSelectionCmd.icon),
      `UnicDB.runShellSelection phải có icon codicon (got ${JSON.stringify(runShellSelectionCmd.icon)})`,
    ).toBe(true);

    const events: string[] = Array.isArray(pkg.activationEvents) ? pkg.activationEvents : [];
    expect(events).toContain("onCommand:UnicDB.runShellSelection");
    expect(events).toContain("onLanguage:shellscript");
  });

  it("Test #3 (TASK-SH-001) — win/linux ctrl+enter variant tồn tại cho UnicDB.runShellSelection", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    const shellKeybindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "UnicDB.runShellSelection",
    );
    const win = shellKeybindings.find((k: { win?: string }) => k.win === "ctrl+enter");
    expect(win, "phải có row win=ctrl+enter cho UnicDB.runShellSelection").toBeTruthy();
    expect(win.linux).toBe("ctrl+enter");
    expect(win.when).toBe("editorTextFocus && resourceLangId == shellscript");
  });

  it("Test #4 (TASK-SH-001) — keybinding mới không clobber runQuery (SQL), đúng ngôn ngữ tách biệt", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    const runQueryKeybindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "UnicDB.runQuery",
    );
    expect(runQueryKeybindings.length).toBeGreaterThanOrEqual(2);
    for (const k of runQueryKeybindings) {
      expect(k.when, `UnicDB.runQuery row phải scope vào sql (got ${k.when})`).toMatch(
        /resourceLangId == sql/,
      );
    }

    const shellKeybindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "UnicDB.runShellSelection",
    );
    expect(shellKeybindings.length).toBeGreaterThanOrEqual(2);
    for (const k of shellKeybindings) {
      expect(k.when, `UnicDB.runShellSelection row phải scope vào shellscript (got ${k.when})`).toMatch(
        /shellscript/,
      );
      // negative: không lan sang SQL
      expect(k.when).not.toMatch(/resourceLangId == sql/);
    }
  });

  // ===== TASK-013: UnicDB.ai.engine description copy =======================

  it("Test (TASK-013) — UnicDB.ai.engine description names claude-code/codex + builtin fallback; default 'omp'; JSON still valid", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    // Parsing again must succeed — guards against malformed contribution JSON.
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    const engine = pkg.contributes.configuration?.properties?.["UnicDB.ai.engine"];
    expect(engine, "UnicDB.ai.engine phải tồn tại").toBeTruthy();
    expect(engine.type).toBe("string");
    expect(engine.default).toBe("omp");

    const desc: string = String(engine.description ?? "");
    // Both new engine ids are named in the description (P0.3 visibility).
    expect(desc, "description phải nhắc tới claude-code").toMatch(/claude-code/);
    expect(desc, "description phải nhắc tới codex").toMatch(/codex/);
    // Builtin fallback semantics must be mentioned (user-chosen unavailable
    // agent falls back to builtin with hint).
    expect(desc, "description phải đề cập builtin fallback").toMatch(/builtin/);
  });
});
