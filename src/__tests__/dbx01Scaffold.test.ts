// src/__tests__/dbx01Scaffold.test.ts
// DBX-01 — scaffold smoke: 4 new commands, activation events, the
// import batchSize setting, and the no-second-cache regression guard
// for the import path.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

interface PackageJson {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string }>;
    configuration: { properties: Record<string, { default?: unknown }> };
  };
}

function readJson<T>(relPath: string): T {
  const raw = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
  return JSON.parse(raw) as T;
}

describe("DBX-01 scaffold — package.json", () => {
  const pkg = readJson<PackageJson>("package.json");

  it("4 new command ids exist in contributes.commands", () => {
    const expected = [
      "vsdb.importCsv",
      "vsdb.importJson",
      "vsdb.openFormView",
      "vsdb.editLargeValue",
    ];
    const ids = pkg.contributes.commands.map((c) => c.command);
    for (const want of expected) {
      expect(ids, `missing command id: ${want}`).toContain(want);
    }
  });

  it("activation events for importCsv + importJson are declared", () => {
    expect(pkg.activationEvents).toContain("onCommand:vsdb.importCsv");
    expect(pkg.activationEvents).toContain("onCommand:vsdb.importJson");
  });

  it("vsdb.import.batchSize defaults to 1000", () => {
    const setting =
      pkg.contributes.configuration.properties["vsdb.import.batchSize"];
    expect(setting).toBeDefined();
    expect(setting?.default).toBe(1000);
  });
});

describe("DBX-01 scaffold — import path hygiene", () => {
  it("importWizard owns no second cache and no debounce (regression guard)", () => {
    const wizardSrc = fs.readFileSync(
      path.join(repoRoot, "src", "ui", "importWizard.ts"),
      "utf-8",
    );
    expect(wizardSrc).not.toMatch(/acSchemaCache|SchemaContextCache/);
    expect(wizardSrc).not.toMatch(/debounce/i);
  });

  it("importer pure modules import no vscode", () => {
    const files = [
      "src/core/importer/importCsv.ts",
      "src/core/importer/importJson.ts",
      "src/core/importer/importMapping.ts",
      "src/core/importer/importDryRun.ts",
      "src/core/importer/importExecute.ts",
      "src/core/importer/importTypes.ts",
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      expect(src, `${rel} imports vscode`).not.toMatch(/from ["']vscode["']/);
    }
  });
});
