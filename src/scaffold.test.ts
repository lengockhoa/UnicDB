import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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

    // views.vsdb.schemaTree
    expect(pkg.contributes.views.vsdb).toBeTruthy();
    const schemaTree = pkg.contributes.views.vsdb.find(
      (v: { id: string }) => v.id === "vsdb.schemaTree",
    );
    expect(schemaTree).toBeTruthy();

    // configuration
    expect(pkg.contributes.configuration).toBeTruthy();
    expect(pkg.contributes.configuration.properties["vsdb.showRunLens"]).toBeTruthy();
    expect(pkg.contributes.configuration.properties["vsdb.showRunLens"].type).toBe("boolean");
    expect(pkg.contributes.configuration.properties["vsdb.batchSize"]).toBeTruthy();
    expect(pkg.contributes.configuration.properties["vsdb.batchSize"].type).toBe("number");
  });

  it("icon.png exists and >0 bytes", () => {
    const iconPath = path.resolve(__dirname, "..", "media", "icon.png");
    expect(fs.existsSync(iconPath)).toBe(true);
    expect(fs.statSync(iconPath).size).toBeGreaterThan(0);
  });
});
