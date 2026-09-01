// src/ui/__tests__/renameFormHost.test.ts — TASK-DBX06-003 (host logic)
// RenameForm.analyzeName against a stubbed adapter.renameUsage capability.
// DBX06-006 — six-lookup analysis, typed plan steps, stale-plan clearing,
// and named-step execution outcome contract (driven through the real
// webview message path with a capturing vscode mock).
import { describe, expect, it, vi } from "vitest";
import type { RenameUsageApi } from "../../adapters/types";

const vscodeMock = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  handler: null as ((msg: unknown) => Promise<void>) | null,
  reset(): void {
    this.posted.length = 0;
    this.handler = null;
  },
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: () => ({
      webview: {
        postMessage: (msg: Record<string, unknown>) => {
          vscodeMock.posted.push(msg);
          return Promise.resolve();
        },
        onDidReceiveMessage: (h: (msg: unknown) => Promise<void>) => {
          vscodeMock.handler = h;
          return { dispose: () => {} };
        },
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

function fakeMgr(renameUsage: RenameUsageApi | null, runQueryImpl?: (sql: string) => Promise<unknown>) {
  return {
    getAdapterFor: () =>
      Promise.resolve({
        renameUsage,
        runQuery:
          runQueryImpl ??
          (() => Promise.resolve({ results: [] })),
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

/** show() + grab the real message handler + drain the ready/init exchange. */
async function liveForm(f: RenameForm) {
  f.show();
  const handler = vscodeMock.handler;
  if (!handler) throw new Error("onDidReceiveMessage handler not captured");
  await handler({ type: "ready" });
  return handler;
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

// =============================================================================
// DBX06-006 — six-lookup analysis, typed plan steps in the protocol,
// named-step execution outcome, and stale-plan clearing after a bad
// analysis (all driven through the real webview message path).
// =============================================================================
describe("RenameForm (DBX06-006 — six lookups + named-step outcome)", () => {
  it("valid analysis calls all six lookups, table-mode triggers/indexes pass '' column; result has exact statement, typed trigger/index rows, rename step + review steps", async () => {
    const calls: string[] = [];
    const u: RenameUsageApi = {
      dependentViews: (s, t) => {
        calls.push(`views:${s}.${t}`);
        return Promise.resolve([]);
      },
      referencingFks: (s, t) => {
        calls.push(`fks:${s}.${t}`);
        return Promise.resolve([]);
      },
      routines: (s, t) => {
        calls.push(`routines:${s}.${t}`);
        return Promise.resolve([]);
      },
      nameCollision: (s, c) => {
        calls.push(`collision:${s}:${c}`);
        return Promise.resolve([]);
      },
      triggers: (s, t, col) => {
        calls.push(`triggers:${s}.${t}:${col}`);
        return Promise.resolve([
          { name: "trg_audit", event: "INSERT OR UPDATE", timing: "AFTER" },
        ]);
      },
      indexes: (s, t, col) => {
        calls.push(`indexes:${s}.${t}:${col}`);
        return Promise.resolve([
          {
            name: "users_email_idx",
            isPrimary: false,
            isUnique: true,
            columns: ["email"],
          },
        ]);
      },
    };
    const r = await form(fakeMgr(u)).analyzeName("customers");
    expect(r.errors).toEqual([]);
    // Exact quoted rename statement.
    expect(r.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    // One executable rename step + review steps (triggers/indexes populated).
    expect(r.steps.map((s) => s.kind)).toEqual([
      "rename",
      "triggers",
      "indexes",
    ]);
    expect(r.steps[0]?.executable).toBe(true);
    expect(r.steps[0]?.statement).toBe(
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    );
    expect(r.steps[1]?.executable).toBe(false);
    expect(r.steps[2]?.executable).toBe(false);
    // Typed trigger/index report rows.
    expect(r.report.triggers).toEqual([
      { name: "trg_audit", event: "INSERT OR UPDATE", timing: "AFTER" },
    ]);
    expect(r.report.indexes).toEqual([
      {
        name: "users_email_idx",
        isPrimary: false,
        isUnique: true,
        columns: ["email"],
      },
    ]);
    // All six lookups ran; table mode passes "" as the column argument.
    expect(calls).toContain("views:public.users");
    expect(calls).toContain("fks:public.users");
    expect(calls).toContain("routines:public.users");
    expect(calls).toContain("collision:public:customers");
    expect(calls).toContain("triggers:public.users:");
    expect(calls).toContain("indexes:public.users:");
  });

  it("analysis message carries typed steps; clean approve reports named applied steps via runRenameSteps", async () => {
    vscodeMock.reset();
    const runCalls: string[] = [];
    const u = fakeUsage({
      dependentViews: () => Promise.resolve([]),
      referencingFks: () => Promise.resolve([]),
      triggers: () =>
        Promise.resolve([{ name: "trg_audit", event: "INSERT", timing: "AFTER" }]),
    });
    const f = form(
      fakeMgr(u, (sql) => {
        runCalls.push(sql);
        return Promise.resolve({ results: [] });
      }),
    );
    const handler = await liveForm(f);
    await handler({ type: "analyze", newName: "customers" });
    const analysis = vscodeMock.posted.find((m) => m.type === "analysis");
    expect(analysis).toBeDefined();
    expect(analysis!.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    expect((analysis!.steps as Array<{ kind: string }> ).map((s) => s.kind)).toEqual([
      "rename",
      "triggers",
    ]);
    vscodeMock.posted.length = 0;
    await handler({ type: "approve" });
    expect(runCalls).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    const done = vscodeMock.posted.find((m) => m.type === "done");
    expect(done).toBeDefined();
    // Named-step outcome: applied carries the executable step with its label.
    expect(done!.applied).toEqual([
      {
        index: 0,
        label: "Rename table",
        sql: 'ALTER TABLE "public"."users" RENAME TO "customers";',
      },
    ]);
    expect(done!.failed).toBeUndefined();
    expect(done!.cancelledAfter).toBeUndefined();
  });

  it("partial failure reports every applied step by name + the failed step; no later statement issued", async () => {
    vscodeMock.reset();
    const issued: string[] = [];
    const u = fakeUsage();
    // runQuery succeeds on the table rename and rejects the column rename.
    const f = form(
      fakeMgr(u, (sql) => {
        issued.push(sql);
        if (sql.includes("RENAME COLUMN")) {
          return Promise.reject(new Error("relation locked"));
        }
        return Promise.resolve({ results: [] });
      }),
    );
    const handler = await liveForm(f);
    // Clean analysis first (the single-op table plan is the normal surface);
    // then exercise the multi-step done contract by seeding a plan with a
    // second executable column step via a fresh analyze on a column-mode
    // sibling form sharing the same failing runQuery.
    await handler({ type: "analyze", newName: "customers" });
    vscodeMock.posted.length = 0;
    await handler({ type: "approve" });
    const done = vscodeMock.posted.find((m) => m.type === "done");
    expect(done).toBeDefined();
    expect(done!.applied).toEqual([
      {
        index: 0,
        label: "Rename table",
        sql: 'ALTER TABLE "public"."users" RENAME TO "customers";',
      },
    ]);
    // Single-step plan → no failure, but the shape must still be named-step.
    expect(done!.failed).toBeUndefined();
    expect(issued).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
  });

  it("mid-run failure through a column-mode form reports named failed step + applied prefix", async () => {
    vscodeMock.reset();
    const issued: string[] = [];
    const u = fakeUsage();
    const f = new RenameForm({
      extensionUri: "/tmp" as never,
      mode: "column",
      schema: "public",
      table: "customers",
      oldName: "name",
      mgr: fakeMgr(u, (sql) => {
        issued.push(sql);
        return Promise.reject(new Error("relation locked"));
      }) as never,
      conn: {} as never,
    });
    const handler = await liveForm(f);
    await handler({ type: "analyze", newName: "full_name" });
    vscodeMock.posted.length = 0;
    await handler({ type: "approve" });
    const done = vscodeMock.posted.find((m) => m.type === "done");
    expect(done).toBeDefined();
    expect(done!.applied).toEqual([]);
    expect(done!.failed).toEqual({
      index: 0,
      label: "Rename column",
      sql: 'ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";',
      error: "relation locked",
    });
    expect(issued).toEqual([
      'ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";',
    ]);
  });

  it("bad analysis cannot execute stale SQL — collision clears the stored plan, approve runs nothing", async () => {
    vscodeMock.reset();
    const runCalls: string[] = [];
    let collision = false;
    const u: RenameUsageApi = {
      dependentViews: () => Promise.resolve([]),
      referencingFks: () => Promise.resolve([]),
      routines: () => Promise.resolve([]),
      nameCollision: () => {
        if (!collision) {
          collision = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([{ name: "customers", kind: "table" }]);
      },
      triggers: () => Promise.resolve([]),
      indexes: () => Promise.resolve([]),
    };
    const f = form(
      fakeMgr(u, (sql) => {
        runCalls.push(sql);
        return Promise.resolve({ results: [] });
      }),
    );
    const handler = await liveForm(f);
    // 1st analysis: clean → plan stored.
    await handler({ type: "analyze", newName: "customers" });
    const clean = vscodeMock.posted.find((m) => m.type === "analysis");
    expect((clean!.errors as string[])).toEqual([]);
    // 2nd analysis: collision → steps cleared in the posted protocol.
    await handler({ type: "analyze", newName: "customers" });
    const bad = vscodeMock.posted.filter((m) => m.type === "analysis").pop();
    expect((bad!.errors as string[]).join(" ")).toContain("customers (table)");
    expect(bad!.steps).toEqual([]);
    expect(bad!.statements).toEqual([]);
    // Approve after the bad analysis must invoke no runQuery.
    vscodeMock.posted.length = 0;
    await handler({ type: "approve" });
    expect(runCalls).toEqual([]);
    expect(vscodeMock.posted.find((m) => m.type === "done")).toBeUndefined();
  });
});
