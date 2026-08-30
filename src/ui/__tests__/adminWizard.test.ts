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
  commandOpenGrantWizard,
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

describe("commandOpenGrantWizard — gated execution path (re-review)", () => {
  async function wizardIo(answers: (string | undefined)[]) {
    // `defaultDeps` captured the vi.fn() refs from the vi.mock factory at
    // import time — reconfigure THOSE refs instead of replacing properties.
    const vscode = (await import("vscode")) as unknown as {
      window: Record<string, ReturnType<typeof vi.fn>>;
    };
    vscode.window.showInputBox = vi.fn().mockImplementation(() => Promise.resolve(answers.shift()));
    vscode.window.showInformationMessage.mockResolvedValue("OK");
    vscode.window.showErrorMessage = vi.fn().mockResolvedValue(undefined);
    vscode.window.showWarningMessage = vi.fn().mockResolvedValue(undefined);
    return vscode;
  }

  it("routes the confirmed SQL through the execute callback (not bare runQuery)", async () => {
    await wizardIo(["public", "t1", "app_rw", "SELECT"]);
    const executed: string[] = [];
    const runQuery = vi.fn();
    const mgr = { getActive: () => ({ id: "c1", label: "dev" }), getAdapter: async () => ({ runQuery }) };
    await commandOpenGrantWizard(mgr, "grant", async (sql) => {
      executed.push(sql);
    });
    expect(executed.length).toBe(1);
    expect(executed[0]).toContain('GRANT SELECT ON TABLE "public"."t1"');
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("propagates gate rejection as an error message and skips runQuery", async () => {
    const vscode = await wizardIo(["public", "t1", "app_rw", "SELECT"]);
    const runQuery = vi.fn();
    const mgr = { getActive: () => ({ id: "c1", label: "dev" }), getAdapter: async () => ({ runQuery }) };
    await commandOpenGrantWizard(mgr, "grant", async () => {
      throw new Error("Cancelled at the admin confirmation gate.");
    });
    expect(runQuery).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Cancelled at the admin confirmation gate."),
    );
  });
});
