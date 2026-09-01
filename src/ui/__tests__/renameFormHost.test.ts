// src/ui/__tests__/renameFormHost.test.ts — TASK-DBX06-003 (host logic)
// RenameForm.analyzeName against a stubbed adapter.renameUsage capability.
import { describe, expect, it, vi } from "vitest";
import type { RenameUsageApi } from "../../adapters/types";

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: () => ({
      webview: {
        postMessage: () => {},
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        asWebviewUri: () => "file://stub",
        cspSource: "stub",
        html: "",
      },
      onDidDispose: () => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    }),
  },
  Uri: { joinPath: () => ({}) },
  ViewColumn: { Active: 1 },
  window2: undefined,
}));

import { RenameForm } from "../renameForm";

function fakeUsage(
  overrides: Partial<RenameUsageApi> = {},
): RenameUsageApi {
  return {
    dependentViews: () => Promise.resolve([{ name: "v_users", kind: "view" }]),
    referencingFks: () =>
      Promise.resolve([{ constraint: "fk_orders_users", fromTable: "orders" }]),
    routines: () => Promise.resolve([]),
    nameCollision: () => Promise.resolve([]),
    triggers: () => Promise.resolve([]),
    indexes: () => Promise.resolve([]),
    ...overrides,
  };
}

function fakeMgr(renameUsage: RenameUsageApi | null) {
  return {
    getAdapterFor: () =>
      Promise.resolve({
        renameUsage,
        runQuery: () => Promise.resolve({ results: [] }),
      }),
  };
}

function form(mgr: unknown): RenameForm {
  return new RenameForm({
    extensionUri: "/tmp" as never,
    mode: "table",
    schema: "public",
    table: "users",
    oldName: "users",
    mgr: mgr as never,
    conn: {} as never,
  });
}

describe("RenameForm.analyzeName (host logic)", () => {
  it("invalid name → error, no adapter calls", async () => {
    let called = 0;
    const base = fakeMgr(fakeUsage());
    const wrapped = {
      getAdapterFor: () => {
        called++;
        return base.getAdapterFor();
      },
    };
    const r = await form(wrapped).analyzeName('us"; DROP TABLE x; --');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("plain identifier");
    expect(r.statements).toEqual([]);
    expect(called).toBe(0); // guarded BEFORE any adapter access
  });

  it("valid name → 4 catalog lookups + plan statements", async () => {
    const calls: string[] = [];
    const u: RenameUsageApi = {
      dependentViews: (schema, table) => {
        calls.push(`views:${schema}.${table}`);
        return Promise.resolve([]);
      },
      referencingFks: (schema, table) => {
        calls.push(`fks:${schema}.${table}`);
        return Promise.resolve([{ constraint: "fk1", fromTable: "orders" }]);
      },
      routines: (schema, table) => {
        calls.push(`routines:${schema}.${table}`);
        return Promise.resolve([]);
      },
      nameCollision: (schema, candidate) => {
        calls.push(`collision:${schema}:${candidate}`);
        return Promise.resolve([]);
      },
      triggers: (schema, table, column) => {
        calls.push(`triggers:${schema}.${table}:${column}`);
        return Promise.resolve([]);
      },
      indexes: (schema, table, column) => {
        calls.push(`indexes:${schema}.${table}:${column}`);
        return Promise.resolve([]);
      },
    };
    const r = await form(fakeMgr(u)).analyzeName("customers");
    expect(r.errors).toEqual([]);
    expect(r.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    expect(r.report.referencingFks).toEqual([
      { constraint: "fk1", fromTable: "orders" },
    ]);
    expect(calls).toContain("views:public.users");
    expect(calls).toContain("fks:public.users");
    expect(calls).toContain("routines:public.users");
    expect(calls).toContain("collision:public:customers");
  });

  it("collision rows surface as errors and suppress statements", async () => {
    const u = fakeUsage({
      nameCollision: () => Promise.resolve([{ name: "customers", kind: "table" }]),
    });
    const r = await form(fakeMgr(u)).analyzeName("customers");
    expect(r.statements).toEqual([]);
    expect(r.errors.join(" ")).toContain("customers (table)");
  });

  it("missing renameUsage capability → analysis error", async () => {
    const r = await form(fakeMgr(null)).analyzeName("customers");
    expect(r.statements).toEqual([]);
    expect(r.errors[0]).toContain("PostgreSQL adapter");
  });
});
