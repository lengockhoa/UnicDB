// src/__tests__/dbx03Scaffold.test.ts
// DBX-03 scaffold — manifest entry for vsdb.compareTables plus the
// hygiene guards: no second cache/debounce in the compare path and a
// CSP-clean webview.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

interface PackageJson {
  contributes: {
    commands: Array<{ command: string; category?: string; icon?: string }>;
  };
}

function readJson<T>(relPath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf-8")) as T;
}

describe("DBX-03 scaffold — package.json", () => {
  const pkg = readJson<PackageJson>("package.json");

  it("vsdb.compareTables is declared with category VSDB + icon", () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === "vsdb.compareTables");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("VSDB");
    expect(cmd?.icon).toBeTruthy();
  });
});

describe("DBX-03 scaffold — compare path hygiene", () => {
  const modules = [
    "src/core/compare/schemaDiff.ts",
    "src/core/compare/dataDiff.ts",
    "src/core/compare/syncPlan.ts",
    "src/ui/compareService.ts",
    "src/ui/comparePanelHtml.ts",
  ];

  it("compare modules import no vscode and no SchemaCache, and own no timers", () => {
    for (const rel of modules) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      expect(src, `${rel} imports vscode`).not.toMatch(/from ["']vscode["']/);
      expect(src, `${rel} touches SchemaCache`).not.toMatch(/SchemaCache|acSchemaCache/);
      expect(src, `${rel} uses timers`).not.toMatch(/setTimeout|setInterval|debounce/i);
    }
  });

  it("webview main is CSP-clean (no innerHTML/eval/document.write)", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "webview", "comparePanelMain.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/innerHTML|outerHTML|document\.write|eval\(/);
    expect(src).toContain("textContent");
  });

  it("compare html keeps script-src restricted to the webview source", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src", "ui", "comparePanelHtml.ts"), "utf-8");
    expect(src).toContain("`script-src ${cspSource}`");
    expect(src).not.toContain("'unsafe-eval'");
  });
});
