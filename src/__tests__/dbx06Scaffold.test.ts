// src/__tests__/dbx06Scaffold.test.ts — TASK-DBX06-004
// Hygiene + exports + package.json contribution assertions for the
// DBX-06 Safe Rename Refactor cycle.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateNewName,
  analyzeUsage,
} from "../core/ddl/renameAnalysis";
import {
  DEPENDENT_VIEWS_SQL,
  TABLE_FKS_SQL,
  ROUTINES_SQL,
  NAME_COLLISION_SQL,
  buildRenamePlan,
} from "../core/ddl/renameCatalog";
import { runRenameStatements } from "../core/ddl/renameRunner";

const srcRoot = resolve(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(srcRoot, rel), "utf8");
}

describe("DBX-06 — pure modules are vscode-free", () => {
  const pure = [
    "src/core/ddl/renameAnalysis.ts",
    "src/core/ddl/renameCatalog.ts",
    "src/core/ddl/renameRunner.ts",
  ];
  for (const f of pure) {
    it(`${f} imports nothing from vscode, fs, child_process, or shell`, () => {
      const s = read(f);
      expect(s).not.toMatch(/from\s+["']vscode["']/);
      expect(s).not.toMatch(/from\s+["']node:fs["']/);
      expect(s).not.toMatch(/from\s+["']node:child_process["']/);
      expect(s).not.toMatch(/shell:\s*true/);
      expect(s).not.toMatch(/execSync\s*\(/);
    });
  }
});

describe("DBX-06 — SQL builders are parameterized", () => {
  it("all 4 builders contain $1 / $2 and never interpolate identifiers", () => {
    for (const sql of [
      DEPENDENT_VIEWS_SQL(),
      TABLE_FKS_SQL(),
      ROUTINES_SQL(),
      NAME_COLLISION_SQL(),
    ]) {
      expect(sql).toMatch(/\$1/);
      expect(sql).not.toMatch(/\$\{schema\}|\$\{table\}|\$\{name\}/);
    }
  });
});

describe("DBX-06 — exports", () => {
  it("analysis / catalog / runner public surface is present", () => {
    expect(typeof validateNewName).toBe("function");
    expect(typeof analyzeUsage).toBe("function");
    expect(typeof DEPENDENT_VIEWS_SQL).toBe("function");
    expect(typeof TABLE_FKS_SQL).toBe("function");
    expect(typeof ROUTINES_SQL).toBe("function");
    expect(typeof NAME_COLLISION_SQL).toBe("function");
    expect(typeof buildRenamePlan).toBe("function");
    expect(typeof runRenameStatements).toBe("function");
  });
});

describe("DBX-06 — package.json contributions", () => {
  const pkg = JSON.parse(read("package.json")) as {
    contributes: { commands: Array<{ command: string }> };
  };
  const commands = new Set(
    pkg.contributes.commands.map((c) => c.command),
  );
  it("declares vsdb.renameTable + vsdb.renameColumn", () => {
    expect(commands.has("vsdb.renameTable")).toBe(true);
    expect(commands.has("vsdb.renameColumn")).toBe(true);
  });
});

describe("DBX-06 — files exist", () => {
  const must = [
    "src/core/ddl/renameAnalysis.ts",
    "src/core/ddl/renameCatalog.ts",
    "src/core/ddl/renameRunner.ts",
    "src/ui/renameForm.ts",
    "src/ui/renameFormMessages.ts",
    "webview/renameFormMain.ts",
  ];
  for (const f of must) {
    it(f, () => {
      expect(existsSync(resolve(srcRoot, f))).toBe(true);
    });
  }
});
