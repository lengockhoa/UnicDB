// src/ui/__tests__/adminTree.test.ts
// Tests for AdminTreeProvider (TASK-AHL-002).
import { describe, it, expect, vi } from "vitest";

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => {}; fire() {}; dispose() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { getConfiguration: vi.fn() },
  Uri: { file: (p: string) => ({ toString: () => p, fsPath: p }) },
}));
import { AdminTreeProvider } from "../adminTree";
import type { ConnectionConfig } from "../../config/types";
import type { ConnectionManager } from "../../core/connectionManager";
import type { DbAdapter, AdminApi } from "../../adapters/types";

function fakeConn(id: string, name: string, driver: string): ConnectionConfig {
  return {
    id,
    name,
    driver: driver as ConnectionConfig["driver"],
    host: "localhost",
    port: 5432,
    user: "u",
    password: "",
    database: "d",
    savePassword: false,
  };
}

function fakeMgr(conns: ConnectionConfig[]): ConnectionManager {
  return {
    listConnections: () => conns,
    getActive: () => null,
    onDidChangeActive: () => ({ dispose: () => {} }),
    getAdapter: vi.fn(),
    getAdapterFor: vi.fn(),
  } as unknown as ConnectionManager;
}

function pgAdapterWithAdmin(admin: AdminApi): DbAdapter {
  return { admin } as unknown as DbAdapter;
}

function pgAdapterNoAdmin(): DbAdapter {
  return {} as unknown as DbAdapter;
}

describe("AdminTreeProvider", () => {
  it("shows Admin category for postgres adapter with admin capability", async () => {
    const conn = fakeConn("c1", "pg", "postgres");
    const admin: AdminApi = {
      listRoles: vi.fn().mockResolvedValue([]),
      listRoleGrants: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listLockWaits: vi.fn().mockResolvedValue([]),
      buildGrantSql: vi.fn(),
      buildRevokeSql: vi.fn(),
    };
    const mgr = fakeMgr([conn]);
    vi.spyOn(mgr, "getAdapterFor").mockResolvedValue(pgAdapterWithAdmin(admin));
    const tree = new AdminTreeProvider(mgr);
    const root = await tree.getChildren();
    expect(root).toHaveLength(1);
    expect(root[0].contextValue).toBe("admin_category");
    expect(root[0].label).toContain("pg");
    tree.dispose();
  });

  it("hides Admin category for mysql/mssql (no admin capability)", async () => {
    const mysqlConn = fakeConn("c2", "my", "mysql");
    const mgr = fakeMgr([mysqlConn]);
    vi.spyOn(mgr, "getAdapterFor").mockResolvedValue(pgAdapterNoAdmin());
    const tree = new AdminTreeProvider(mgr);
    const root = await tree.getChildren();
    expect(root).toHaveLength(0);
    tree.dispose();
  });

  it("expanding Admin shows 3 sub-categories: Roles, Sessions, Locks", async () => {
    const conn = fakeConn("c3", "pg", "postgres");
    const admin: AdminApi = {
      listRoles: vi.fn().mockResolvedValue([]),
      listRoleGrants: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listLockWaits: vi.fn().mockResolvedValue([]),
      buildGrantSql: vi.fn(),
      buildRevokeSql: vi.fn(),
    };
    const mgr = fakeMgr([conn]);
    vi.spyOn(mgr, "getAdapterFor").mockResolvedValue(pgAdapterWithAdmin(admin));
    const tree = new AdminTreeProvider(mgr);
    const root = await tree.getChildren();
    const sub = await tree.getChildren(root[0]);
    const kinds = sub.map((s) => s.contextValue).sort();
    expect(kinds).toEqual(["locks", "roles", "sessions"]);
    tree.dispose();
  });

  it("expanding Roles shows one node per role from listRoles()", async () => {
    const conn = fakeConn("c4", "pg", "postgres");
    const admin: AdminApi = {
      listRoles: vi.fn().mockResolvedValue([
        { name: "alice", canLogin: true, isSuperuser: false, memberOf: [] },
        { name: "report", canLogin: false, isSuperuser: false, memberOf: [] },
      ]),
      listRoleGrants: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listLockWaits: vi.fn().mockResolvedValue([]),
      buildGrantSql: vi.fn(),
      buildRevokeSql: vi.fn(),
    };
    const mgr = fakeMgr([conn]);
    vi.spyOn(mgr, "getAdapterFor").mockResolvedValue(pgAdapterWithAdmin(admin));
    const tree = new AdminTreeProvider(mgr);
    const root = await tree.getChildren();
    const sub = await tree.getChildren(root[0]);
    const roles = sub.find((s) => s.contextValue === "roles")!;
    const roleNodes = await tree.getChildren(roles);
    expect(roleNodes.map((r) => r.label)).toEqual(["alice", "report"]);
    tree.dispose();
  });

  it("insufficient_privilege surfaces as admin_error node carrying 42501", async () => {
    const conn = fakeConn("c5", "pg", "postgres");
    const err = new Error("ERROR: 42501 insufficient_privilege");
    const admin: AdminApi = {
      listRoles: vi.fn().mockRejectedValue(err),
      listRoleGrants: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listLockWaits: vi.fn().mockResolvedValue([]),
      buildGrantSql: vi.fn(),
      buildRevokeSql: vi.fn(),
    };
    const mgr = fakeMgr([conn]);
    vi.spyOn(mgr, "getAdapterFor").mockResolvedValue(pgAdapterWithAdmin(admin));
    const tree = new AdminTreeProvider(mgr);
    const root = await tree.getChildren();
    const sub = await tree.getChildren(root[0]);
    const roles = sub.find((s) => s.contextValue === "roles")!;
    const roleNodes = await tree.getChildren(roles);
    expect(roleNodes).toHaveLength(1);
    expect(roleNodes[0].contextValue).toBe("admin_error");
    expect(roleNodes[0].label).toContain("42501");
    tree.dispose();
  });
});
