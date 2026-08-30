// src/__tests__/ahlScaffold.test.ts
// TASK-AHL-004 — smoke tests for the admin cycle manifest.
//   - 5 new command ids declared (refreshAdmin, openSessionsPanel, killSession,
//     terminateSession, runGrantSql) with category "VSDB" + icon.
//   - 2 new activation events (`onCommand:vsdb.refreshAdmin` + openSessionsPanel).
//   - New view `vsdb.adminTree` declared.
//   - Setting `vsdb.admin.confirmGrant` defaults to true.
//   - Dangerous-statement kind/tier unions widened to admin DCL.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

interface PackageJson {
  version: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{
      command: string;
      title: string;
      category?: string;
      icon?: string;
    }>;
    views: Record<string, Array<{ id: string; name: string }>>;
    configuration: {
      properties: Record<
        string,
        { type: string; default?: unknown; description?: string }
      >;
    };
  };
}

function readJson<T>(relPath: string): T {
  const raw = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
  return JSON.parse(raw) as T;
}

describe("TASK-AHL-004 — admin scaffold (package.json)", () => {
  const pkg = readJson<PackageJson>("package.json");

  it("5 new admin command ids exist in contributes.commands", () => {
    const expected = [
      "vsdb.refreshAdmin",
      "vsdb.openSessionsPanel",
      "vsdb.killSession",
      "vsdb.terminateSession",
      "vsdb.runGrantSql",
    ];
    const ids = pkg.contributes.commands.map((c) => c.command);
    for (const want of expected) {
      expect(ids, `missing command id: ${want}`).toContain(want);
    }
  });

  it("each new admin command has category='VSDB' + an icon", () => {
    const expected = [
      "vsdb.refreshAdmin",
      "vsdb.openSessionsPanel",
      "vsdb.killSession",
      "vsdb.terminateSession",
      "vsdb.runGrantSql",
    ];
    for (const id of expected) {
      const cmd = pkg.contributes.commands.find((c) => c.command === id);
      expect(cmd, `command ${id} not found`).toBeDefined();
      expect(cmd?.category, `${id} category`).toBe("VSDB");
      expect(cmd?.icon, `${id} icon`).toBeTruthy();
    }
  });

  it("command count is at least the AHL baseline of 35 (DBX-01 adds 4 more)", () => {
    // DBX-01 (TASK-DBX01-004) added importCsv/importJson/openFormView/
    // editLargeValue on top of the AHL baseline; later cycles may add
    // more, so assert a floor rather than an exact count.
    expect(pkg.contributes.commands.length).toBeGreaterThanOrEqual(35);
  });

  it("activation events include onCommand:vsdb.refreshAdmin + openSessionsPanel", () => {
    expect(pkg.activationEvents).toContain("onCommand:vsdb.refreshAdmin");
    expect(pkg.activationEvents).toContain("onCommand:vsdb.openSessionsPanel");
  });

  it("view vsdb.adminTree is registered", () => {
    const views = pkg.contributes.views.vsdb ?? [];
    const ids = views.map((v) => v.id);
    expect(ids).toContain("vsdb.adminTree");
  });

  it("setting vsdb.admin.confirmGrant defaults to true", () => {
    const setting = pkg.contributes.configuration.properties["vsdb.admin.confirmGrant"];
    expect(setting, "vsdb.admin.confirmGrant setting not declared").toBeDefined();
    expect(setting?.type).toBe("boolean");
    expect(setting?.default).toBe(true);
  });
});

describe("TASK-AHL-004 — dangerous-statement union widening (compile-time check)", () => {
  it("DangerousKind includes grant|revoke|kill|terminate", async () => {
    const mod = await import("../core/dangerousStatement");
    expect(typeof mod.analyzeStatement).toBe("function");
    expect(typeof mod.guardTier).toBe("function");
    const grant = mod.analyzeStatement("GRANT SELECT ON TABLE x TO y");
    expect(grant.kind).toBe("grant");
    const kill = mod.analyzeStatement("SELECT pg_cancel_backend(12345)");
    expect(kill.kind).toBe("kill");
    const terminate = mod.analyzeStatement("SELECT pg_terminate_backend(12345)");
    expect(terminate.kind).toBe("terminate");
    expect(mod.guardTier(grant)).toBe("admin-red");
    expect(mod.guardTier(kill)).toBe("admin-red");
    expect(mod.guardTier(terminate)).toBe("admin-red");
  });
});
