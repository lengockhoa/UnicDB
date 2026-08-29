// src/ui/__tests__/adminWizard.test.ts
// Tests for adminWizard (TASK-AHL-002).
import { describe, it, expect, vi } from "vitest";

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => {}; fire() {}; dispose() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn() },
  workspace: { getConfiguration: vi.fn() },
  Uri: { file: (p: string) => ({ toString: () => p, fsPath: p }) },
}));
import {
  buildGrantPlan,
  buildRevokePlan,
  runGrantWizard,
  runRevokeWizard,
  type WizardDeps,
} from "../adminWizard";
import { buildGrantSql, buildRevokeSql, AdminError } from "../../core/admin/pgAdmin";

function makeDeps(overrides?: Partial<WizardDeps>): WizardDeps {
  return {
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue("OK"),
    ...overrides,
  };
}

describe("adminWizard.buildGrantPlan", () => {
  it("produces SQL identical to pgAdmin.buildGrantSql for table target", () => {
    const plan = buildGrantPlan({
      grantee: "alice",
      privileges: ["SELECT", "INSERT"],
      schema: "public",
      object: "orders",
    });
    const expected = buildGrantSql({
      grantee: "alice",
      privileges: ["SELECT", "INSERT"],
      on: { kind: "table", schema: "public", table: "orders" },
    });
    expect(plan.sql).toBe(expected);
    expect(plan.sql).toContain('"alice"');
    expect(plan.sql).toContain('"public"');
    expect(plan.sql).toContain('"orders"');
  });

  it("rejects PUBLIC grantee with structured AdminError when allowGrantPublic omitted", () => {
    expect(() =>
      buildGrantPlan({
        grantee: "PUBLIC",
        privileges: ["SELECT"],
        schema: "public",
        object: "t",
      }),
    ).toThrow(AdminError);
    try {
      buildGrantPlan({
        grantee: "PUBLIC",
        privileges: ["SELECT"],
        schema: "public",
        object: "t",
      });
    } catch (e) {
      expect((e as AdminError).code).toBe("granteePublicForbidden");
    }
  });

  it("allows PUBLIC when allowGrantPublic:true", () => {
    const plan = buildGrantPlan({
      grantee: "PUBLIC",
      privileges: ["SELECT"],
      schema: "public",
      object: "t",
      allowGrantPublic: true,
    });
    expect(plan.sql).toContain('"PUBLIC"');
  });
});

describe("adminWizard.buildRevokePlan", () => {
  it("produces SQL identical to pgAdmin.buildRevokeSql", () => {
    const plan = buildRevokePlan({
      grantee: "alice",
      privileges: ["SELECT"],
      schema: "public",
      object: "t",
    });
    const expected = buildRevokeSql({
      grantee: "alice",
      privileges: ["SELECT"],
      on: { kind: "table", schema: "public", table: "t" },
    });
    expect(plan.sql).toBe(expected);
  });

  it("CASCADE option is rendered in SQL", () => {
    const plan = buildRevokePlan({
      grantee: "alice",
      privileges: ["SELECT"],
      schema: "public",
      object: "t",
      cascade: true,
    });
    expect(plan.sql).toMatch(/CASCADE$/);
  });
});

describe("adminWizard.runGrantWizard", () => {
  it("returns the SQL on confirm OK", async () => {
    const deps = makeDeps({ showInformationMessage: vi.fn().mockResolvedValue("OK") });
    const sql = await runGrantWizard({
      schema: "public",
      object: "t",
      grantee: "alice",
      privileges: ["SELECT"],
      deps,
    });
    expect(sql).toBeDefined();
    expect(sql).toContain("GRANT");
  });

  it("returns undefined on cancel (showInformationMessage returns undefined)", async () => {
    const deps = makeDeps({ showInformationMessage: vi.fn().mockResolvedValue(undefined) });
    const sql = await runGrantWizard({
      schema: "public",
      object: "t",
      grantee: "alice",
      privileges: ["SELECT"],
      deps,
    });
    expect(sql).toBeUndefined();
  });

  it("rejects PUBLIC grantee and returns undefined", async () => {
    const showInfo = vi.fn().mockResolvedValue("OK");
    const deps = makeDeps({ showInformationMessage: showInfo });
    const sql = await runGrantWizard({
      schema: "public",
      object: "t",
      grantee: "PUBLIC",
      privileges: ["SELECT"],
      deps,
    });
    expect(sql).toBeUndefined();
    expect(showInfo).toHaveBeenCalled();
  });
});

describe("adminWizard.runRevokeWizard", () => {
  it("returns the SQL on confirm OK", async () => {
    const deps = makeDeps({ showInformationMessage: vi.fn().mockResolvedValue("OK") });
    const sql = await runRevokeWizard({
      schema: "public",
      object: "t",
      grantee: "alice",
      privileges: ["SELECT"],
      deps,
    });
    expect(sql).toBeDefined();
    expect(sql).toContain("REVOKE");
  });

  it("returns undefined on cancel", async () => {
    const deps = makeDeps({ showInformationMessage: vi.fn().mockResolvedValue(undefined) });
    const sql = await runRevokeWizard({
      schema: "public",
      object: "t",
      grantee: "alice",
      privileges: ["SELECT"],
      deps,
    });
    expect(sql).toBeUndefined();
  });
});
