// src/__tests__/dbx04Scaffold.test.ts
// DBX-04 scaffold — manifest entry for UnicDB.relationshipExplorer plus the
// hygiene guards: pure ER modules stay vscode-free and the diagram webview
// stays CSP-clean (no raw-HTML injection APIs).

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

describe("DBX-04 scaffold — package.json", () => {
  const pkg = readJson<PackageJson>("package.json");

  it("UnicDB.relationshipExplorer is declared with category UnicDB + icon", () => {
    const cmd = pkg.contributes.commands.find(
      (c) => c.command === "UnicDB.relationshipExplorer",
    );
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("UnicDB");
    expect(cmd?.icon).toBeTruthy();
  });
});

describe("DBX-04 scaffold — ER path hygiene", () => {
  const modules = [
    "src/core/er/fkGraph.ts",
    "src/core/er/layout.ts",
    "src/core/er/svgExport.ts",
    "src/ui/erService.ts",
    "src/ui/erPanelHtml.ts",
  ];

  it("ER modules import no vscode and own no timers", () => {
    for (const rel of modules) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      expect(src, `${rel} imports vscode`).not.toMatch(/from ["']vscode["']/);
      expect(src, `${rel} uses timers`).not.toMatch(
        /\b(setTimeout|setInterval)\b|\bdebounce\b/i,
      );
    }
  });

  it("diagram webview is CSP-clean (no raw-HTML injection APIs)", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "webview", "erPanelMain.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(
      /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b|\beval\s*\(|new\s+Function\s*\(/,
    );
    expect(src).toContain("createElementNS");
  });

  it("ER html keeps script-src restricted to the webview source", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "src", "ui", "erPanelHtml.ts"),
      "utf-8",
    );
    expect(src).toContain("`script-src ${cspSource}`");
    expect(src).not.toContain("'unsafe-eval'");
  });
});
