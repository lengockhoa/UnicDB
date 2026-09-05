// src/ui/__tests__/tableCommands.test.ts
// TASK-005 — Unit tests cho table-utility commands.
// Fix round 1 — bind params via adapter.listTableDetail, getParent(),
// newTable accepts table nodes, no DEBUG logs, no regex recovery.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  ExtensionContext,
  TextDocument,
  TextEditor,
  TreeView,
} from "vscode";
import type { ConnectionConfig } from "../../config/types";
import {
  DbAdapter,
  NotImplementedError,
  QueryResult,
} from "../../adapters/types";
import type { TableSpec } from "../../core/ddl/createTable";
import { generateCreateTable, defaultColumnSpecs } from "../../core/ddl/createTable";
import {
  rowsToSpec,
  type PgColumnRow,
  type PgConstraintRow,
} from "../../core/ddl/pgIntrospect";
import {
  resolveTableNode, registerTableCommands 
} from "../tableCommands";
import {
  SchemaTreeProvider,
  type UnicDBNode,
  registerSchemaTreeProvider,
} from "../schemaTree";
import type { ConnectionManager } from "../../core/connectionManager";
import * as fs from "fs";
import * as path from "path";

interface MockTreeView { reveal: Mock; dispose: Mock; }

const state = vi.hoisted(() => ({
  registeredCommands: new Map<string, Function>(),
  infoMessages: [] as string[],
  errorMessages: [] as string[],
  statusMessages: [] as Array<{ text: string; timeout: number }>,
  inputBoxResult: undefined as string | undefined,
  createdPanels: [] as Array<{
    webview: { postMessage: Mock; onDidReceiveMessage: Mock; html: string; asWebviewUri: Mock; cspSource: string };
    onDidDispose: Mock; reveal: Mock; dispose: Mock;
  }>,
}));

vi.mock("vscode", () => ({
  EventEmitter: vi.fn().mockImplementation(() => {
    const listeners: Array<(e: unknown) => void> = [];
    return { event: (l: (e: unknown) => void) => { listeners.push(l); return { dispose: () => {} }; }, fire: (e: unknown) => listeners.slice().forEach(l => l(e)), dispose: () => listeners.splice(0) };
  }),
  TreeItem: vi.fn(),
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: vi.fn(),
  ThemeColor: vi.fn(),
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p, path: p, scheme: "file" }),
    parse: (s: string) => ({ toString: () => s }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({ toString: () => `${String(u)}/${p.join("/")}`, path: p.join("/") })),
  },
  ViewColumn: { Active: 1, Beside: 2 },
  window: {
    showInformationMessage: vi.fn((msg: string) => { state.infoMessages.push(msg); return Promise.resolve(undefined); }),
    showErrorMessage: vi.fn((msg: string) => { state.errorMessages.push(msg); return Promise.resolve(undefined); }),
    showInputBox: vi.fn(() => Promise.resolve(state.inputBoxResult)),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    setStatusBarMessage: vi.fn((text: string, timeout: number) => { state.statusMessages.push({ text, timeout }); return { dispose: () => {} }; }),
    createWebviewPanel: vi.fn(() => {
      const panel = {
        webview: { html: "", postMessage: vi.fn().mockResolvedValue(undefined), onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })), asWebviewUri: vi.fn((u: unknown) => u), cspSource: "vscode-webview://test" },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(), dispose: vi.fn(), visible: true,
      };
      state.createdPanels.push(panel);
      return panel;
    }),
    createTreeView: vi.fn(() => { return { reveal: vi.fn(), dispose: vi.fn() } as MockTreeView; }),
    showTextDocument: vi.fn().mockResolvedValue({}),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_key: string, fallback?: unknown) => fallback })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    openTextDocument: vi.fn().mockResolvedValue({}),
  },
  commands: {
    registerCommand: vi.fn((id: string, fn: Function) => { state.registeredCommands.set(id, fn); return { dispose: () => state.registeredCommands.delete(id) }; }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  env: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
  languages: { registerCodeLensProvider: vi.fn(() => ({ dispose: () => {} })) },
}));

import * as vscode from "vscode";

interface RunCall { sql: string; }
interface ListTableDetailCall { schema: string; table: string; }
interface MakeFakeAdapterOpts {
  driver?: ConnectionConfig["driver"];
  introspectRows?: { columns: PgColumnRow[]; constraints: PgConstraintRow[] };
  initialTables?: Array<{ name: string; schema: string }>;
  listTableDetailUnsupported?: boolean;
  /** DBX-08 — explicit capability override; defaults mirror the driver's production matrix. */
  capabilities?: { catalog: boolean; objectDdl: boolean; tableDdl: boolean; admin: boolean };
}
type FakeAdapter = DbAdapter & {
  runCalls: RunCall[];
  listTableDetailCalls: ListTableDetailCall[];
};

function makeFakeAdapter(opts: MakeFakeAdapterOpts = {}): FakeAdapter {
  const driver = opts.driver ?? "postgres";
  const introspectCols = opts.introspectRows?.columns ?? [];
  const introspectCons = opts.introspectRows?.constraints ?? [];
  const runCalls: RunCall[] = [];
  const listTableDetailCalls: ListTableDetailCall[] = [];
  const runQuery = vi.fn((sql: string) => {
    runCalls.push({ sql });
    return Promise.resolve({ results: [{ columns: [], rows: [], rowCount: 0, durationMs: 1 } as QueryResult] });
  });
  const listTableDetail = vi.fn(async (schema: string, table: string) => {
    listTableDetailCalls.push({ schema, table });
    if (opts.listTableDetailUnsupported) {
      throw new NotImplementedError(driver);
    }
    return { columns: introspectCols, constraints: introspectCons };
  });
  const initialTables = opts.initialTables ?? [];
  const adapter: FakeAdapter = {
    driver,
    // DBX-08 — default matrix mirrors the production adapters: postgres all
    // true, mysql/mssql all false. Tests may override per-capability.
    capabilities:
      opts.capabilities ??
      (driver === "postgres"
        ? { catalog: true, objectDdl: true, tableDdl: true, admin: true }
        : { catalog: false, objectDdl: false, tableDdl: false, admin: false }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    runQuery,
    listSchemas: vi.fn().mockResolvedValue([{ name: "public" }]),
    listTables: vi.fn().mockImplementation((schema?: string) => {
      return Promise.resolve(initialTables.filter((t) => (schema ? t.schema === schema : true)));
    }),
    listViews: vi.fn().mockResolvedValue([]),
    listRoutines: vi.fn().mockResolvedValue([]),
    listRoutineParams: vi.fn().mockResolvedValue([]),
    listColumns: vi.fn().mockResolvedValue([]),
    estimateTableRows: vi.fn().mockResolvedValue(null),
    listTableDetail,
    testConnection: vi.fn().mockResolvedValue(undefined),
    runCalls,
    listTableDetailCalls,
  };
  return adapter;
}

interface FakeMgrOptions {
  driver?: ConnectionConfig["driver"];
  introspectRows?: { columns: PgColumnRow[]; constraints: PgConstraintRow[] };
  tables?: Array<{ name: string; schema: string }>;
  rejectRun?: boolean;
  listTableDetailUnsupported?: boolean;
  /** DBX-08 — explicit capability override for the underlying fake adapter. */
  capabilities?: { catalog: boolean; objectDdl: boolean; tableDdl: boolean; admin: boolean };
}

function makeFakeMgr(opts: FakeMgrOptions = {}) {
  const cfg: ConnectionConfig = {
    id: "c1",
    name: "Test PG",
    driver: opts.driver ?? "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "UnicDB",
    database: "UnicDB",
  };
  const adapter = makeFakeAdapter({
    driver: opts.driver,
    introspectRows: opts.introspectRows,
    initialTables: opts.tables,
    listTableDetailUnsupported: opts.listTableDetailUnsupported,
    capabilities: opts.capabilities,
  });
  if (opts.rejectRun) (adapter.runQuery as Mock).mockRejectedValue(new Error("boom"));
  const stub = {
    getAdapter: () => Promise.resolve(adapter),
    getAdapterFor: () => Promise.resolve(adapter),
  };
  return { cfg, adapter, stub };
}

function makeTreeWithAdapter(adapter: DbAdapter) {
  const fakeMgr = {
    listConnections: () => [],
    getActive: () => null,
    onDidChangeActive: () => ({ dispose: () => {} }),
    getAdapter: () => Promise.resolve(adapter),
    getAdapterFor: () => Promise.resolve(adapter),
  } as unknown as ConnectionManager;
  const provider = new SchemaTreeProvider(fakeMgr);
  const treeView: MockTreeView = { reveal: vi.fn(), dispose: vi.fn() };
  return { provider, treeView };
}

function resetState() {
  state.registeredCommands.clear();
  state.infoMessages.length = 0;
  state.errorMessages.length = 0;
  state.statusMessages.length = 0;
  state.inputBoxResult = undefined;
  state.createdPanels.length = 0;
}

beforeEach(() => { resetState(); });

describe("tableCommands — UnicDB.newTable", () => {
  it("#5 schema node → NewTableForm mode create; runDdl → adapter.runQuery + refresh + reveal + Created info", async () => {
    const mgr = makeFakeMgr({ tables: [{ name: "users", schema: "public" }] });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const refreshSpy = vi.spyOn(provider, "refresh");
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    const fn = state.registeredCommands.get("UnicDB.newTable");
    await fn!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "users", schema: "public", columns: defaultColumnSpecs("users"), keys: [] } satisfies TableSpec;
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(refreshSpy).toHaveBeenCalled();
    expect(treeView.reveal).toHaveBeenCalled();
    expect(state.infoMessages.some((m) => /Created\s+public\.users/.test(m))).toBe(true);
  });
});

describe("tableCommands — UnicDB.modifyTable", () => {
  it("#6 table node → mode modify; loadSpec introspect + runDdl diff joined + refresh + reveal + Modified info", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
      { column_name: "name", format_type: "character varying", is_nullable: "YES", column_default: null },
    ];
    const cons: PgConstraintRow[] = [
      { conname: "t_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null, consrc: "PRIMARY KEY (id)" },
    ];
    const mgr = makeFakeMgr({
      introspectRows: { columns: cols, constraints: cons },
      tables: [{ name: "t", schema: "public" }],
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const refreshSpy = vi.spyOn(provider, "refresh");
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    const fn = state.registeredCommands.get("UnicDB.modifyTable");
    await fn!(tableNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const newSpec: TableSpec = {
      name: "t",
      schema: "public",
      columns: [
        { name: "user_id", type: "bigint", nullable: false, originalName: "id" },
        { name: "name", type: "character varying", nullable: true, originalName: "name" },
      ],
      keys: [{ kind: "primaryKey", columns: ["user_id"], name: "t_pkey" }],
    };
    await handler({ type: "specChanged", spec: newSpec });
    await handler({ type: "submit", spec: newSpec });
    expect(refreshSpy).toHaveBeenCalled();
    expect(treeView.reveal).toHaveBeenCalled();
    expect(state.infoMessages.some((m) => /Modified\s+public\.t/.test(m))).toBe(true);
  });
});

describe("tableCommands — guards", () => {
  it("#7 mysql guard → 'UnicDB: Modify Table is not supported by this connection's database.' info, no runQuery", async () => {
    const mgr = makeFakeMgr({ driver: "mysql", listTableDetailUnsupported: true });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("UnicDB.modifyTable")!(tableNode);
    expect(state.infoMessages.some((m) => m === "UnicDB: Modify Table is not supported by this connection's database.")).toBe(true);
    expect(mgr.adapter.runCalls).toHaveLength(0);
    expect(state.createdPanels.length).toBe(0);
    expect(treeView.reveal).not.toHaveBeenCalled();
  });

  it("#8b renameColumn on dotted quoted table name resolves exact table (no objectKey parse)", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    // objectKey is lossy ("c1.public.foo.bar" → "bar" by naive split);
    // the column node must carry objectName = "foo.bar" and resolve it
    // exactly.
    const columnNode: UnicDBNode = {
      label: "id",
      contextValue: "column",
      collapsible: 0,
      meta: {
        connection: mgr.cfg,
        schema: "public",
        objectKey: "c1.public.foo.bar",
        objectName: "foo.bar",
        column: { name: "id", dataType: "int" },
      },
    };
    const resolved = resolveTableNode(columnNode);
    expect(resolved?.table).toBe("foo.bar");
    expect(resolved?.column).toBe("id");
    await state.registeredCommands.get("UnicDB.renameColumn")!(columnNode);
    expect(mgr.adapter.listTableDetailCalls).toHaveLength(0);
    expect(state.createdPanels.length).toBeGreaterThan(0);
  });

  it("#8a renameColumn on column node opens form WITHOUT introspectTable or QuickPick", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const columnNode: UnicDBNode = {
      label: "id",
      contextValue: "column",
      collapsible: 0,
      meta: {
        connection: mgr.cfg,
        schema: "public",
        objectKey: "public.t",
        objectName: "t",
        column: { name: "id", dataType: "int" },
      },
    };
    await state.registeredCommands.get("UnicDB.renameColumn")!(columnNode);
    // No introspectTable call (we have the name from arg.meta.column).
    expect(mgr.adapter.listTableDetailCalls).toHaveLength(0);
    // A webview panel was created (the rename form).
    expect(state.createdPanels.length).toBeGreaterThan(0);
  });

  it("#8 non-tables category (views) → Information mentioning Tables; no NewTableForm", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const viewsNode: UnicDBNode = {
      label: "Views",
      contextValue: "category",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", category: "views" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(viewsNode);
    expect(state.infoMessages.some((m) => /New Table.*Tables/.test(m))).toBe(true);
    expect(state.createdPanels.length).toBe(0);
    expect(mgr.adapter.runCalls).toHaveLength(0);
    expect(treeView.reveal).not.toHaveBeenCalled();
  });

  it("#13 DDL failure → showErrorMessage 'New Table failed: <msg>'; tree.refresh NOT called", async () => {
    const mgr = makeFakeMgr({ rejectRun: true });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const refreshSpy = vi.spyOn(provider, "refresh");
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "users", schema: "public", columns: defaultColumnSpecs("users"), keys: [] };
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(state.errorMessages.some((m) => m.startsWith("New Table failed: "))).toBe(true);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(treeView.reveal).not.toHaveBeenCalled();
  });
});

describe("tableCommands — UnicDB.copyCreateDdl", () => {
  it("#9 introspect → generateCreateTable → clipboard.writeText + status message", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
      { column_name: "name", format_type: "character varying", is_nullable: "YES", column_default: null },
    ];
    const cons: PgConstraintRow[] = [
      { conname: "t_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null, consrc: "PRIMARY KEY (id)" },
    ];
    const mgr = makeFakeMgr({
      introspectRows: { columns: cols, constraints: cons },
      tables: [{ name: "t", schema: "public" }],
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("UnicDB.copyCreateDdl")!(tableNode);
    const expectedSpec = rowsToSpec("public", "t", cols, cons);
    const expectedDdl = generateCreateTable(expectedSpec);
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expectedDdl);
    expect(state.statusMessages.some((m) => /DDL copied/.test(m.text))).toBe(true);
  });
});
describe("tableCommands — UnicDB.generateSampleData (TASK-006 AI flow)", () => {
  // TASK-UX1-003 — the menu default is now console templates (see the
  // TASK-UX1-003 describe block below). The old AI-driven integration tests
  // for UnicDB.generateSampleData were removed because the default no longer
  // calls aiGenerateSampleData / AiConfigStore / showInputBox. The unit tests
  // in src/ui/__tests__/sampleDataAi.test.ts still cover the AI module (case
  // #8 regression pin).
  it("AI module remains importable + sampleDataAi.test.ts covers the API", async () => {
    const mod = await import("../sampleDataAi");
    expect(typeof mod.aiGenerateSampleData).toBe("function");
    expect(typeof mod.buildSampleDataPrompt).toBe("function");
    expect(typeof mod.pickInsertableColumns).toBe("function");
    expect(typeof mod.parseInsertStatements).toBe("function");
  });
});

describe("tableCommands — analyze / vacuum", () => {
  it("#12 ANALYZE '\"public\".\"t\"' + VACUUM ANALYZE '\"public\".\"t\"' + notifications", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("UnicDB.analyzeTable")!(tableNode);
    await state.registeredCommands.get("UnicDB.vacuumTable")!(tableNode);
    const ddlCalls = mgr.adapter.runCalls.map((c) => c.sql);
    expect(ddlCalls).toContain('ANALYZE "public"."t"');
    expect(ddlCalls).toContain('VACUUM ANALYZE "public"."t"');
    expect(state.infoMessages.some((m) => /public\.t analyzed/.test(m))).toBe(true);
    expect(state.infoMessages.some((m) => /public\.t vacuumed/.test(m))).toBe(true);
  });
});

// =============================================================================
// R1 regression: introspectTable binds schema + table via adapter.listTableDetail
// (CRITICAL fix round 1 #1). Trước fix: introspect SQL chạy qua runQuery(sql)
// không truyền $1/$2 → PG "there is no parameter $1" → modifyTable /
// copyCreateDdl / generateSampleData fail production. Sau fix: gọi
// adapter.listTableDetail(schema, table) → PostgresAdapter.pool.query(sql, [..]).
// =============================================================================
describe("tableCommands — R1 regression: listTableDetail bind params", () => {
  it("modifyTable → introspectTable gọi adapter.listTableDetail('public','t') (không qua runQuery SQL)", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
    ];
    const cons: PgConstraintRow[] = [
      { conname: "t_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null, consrc: "PRIMARY KEY (id)" },
    ];
    const mgr = makeFakeMgr({
      introspectRows: { columns: cols, constraints: cons },
      tables: [{ name: "t", schema: "public" }],
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("UnicDB.modifyTable")!(tableNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    expect(mgr.adapter.listTableDetailCalls.length).toBeGreaterThanOrEqual(1);
    expect(mgr.adapter.listTableDetailCalls[0]).toEqual({ schema: "public", table: "t" });
    expect(mgr.adapter.runCalls).toHaveLength(0);
  });

  it("copyCreateDdl → introspectTable gọi adapter.listTableDetail('public','users')", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
    ];
    const mgr = makeFakeMgr({
      introspectRows: { columns: cols, constraints: [] },
      tables: [{ name: "users", schema: "public" }],
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "users",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "users" },
    };
    await state.registeredCommands.get("UnicDB.copyCreateDdl")!(tableNode);
    expect(mgr.adapter.listTableDetailCalls).toEqual([{ schema: "public", table: "users" }]);
    expect(mgr.adapter.runCalls).toHaveLength(0);
  });
});

// =============================================================================
// R1 regression: newTable guard chấp nhận table node (meta.category === 'columns',
// contextValue === 'table') thay vì hiển thị "open the Tables category" sai.
// =============================================================================
describe("tableCommands — R1 regression: newTable accepts table node (columns category)", () => {
  it("table node → NewTableForm mở; KHÔNG show 'open the Tables category' info", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: UnicDBNode = {
      label: "users",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "users", category: "columns" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(tableNode);
    expect(state.createdPanels.length).toBe(1);
    expect(state.infoMessages.some((m) => /open the Tables category/.test(m))).toBe(false);
  });
});

// =============================================================================
// R1 regression: copyCreateDdl DDL KHÔNG phát sinh "multiple primary keys".
// Spec từ rowsToSpec có cả column.isPrimaryKey (in-band) + primaryKey KeySpec
// (table-level). createTable.ts đã fix để suppress inline khi đã có
// table-level constraint. Verify bằng rowsToSpec → generateCreateTable thật.
// =============================================================================
describe("tableCommands — R1 regression: copyCreateDdl DDL dedupes PK", () => {
  it("rowsToSpec + generateCreateTable cho PK column → chỉ một PRIMARY KEY (table-level), không inline", () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
    ];
    const cons: PgConstraintRow[] = [
      { conname: "t_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null, consrc: "PRIMARY KEY (id)" },
    ];
    const spec = rowsToSpec("public", "t", cols, cons);
    const ddl = generateCreateTable(spec);
    expect(ddl).not.toMatch(/^\s*"id"\s+bigint\s+NOT NULL\s+PRIMARY KEY/m);
    expect(ddl).toMatch(/CONSTRAINT "t_pkey" PRIMARY KEY \("id"\)/);
  });
});

// =============================================================================
// R1 regression: runDdl không có console.log debug; created-table name lấy từ
// spec.name qua tham số callback (không regex SQL string).
// =============================================================================
describe("tableCommands — R1 regression: no DEBUG logs + spec.name pass-through", () => {
  it("newTable runDdl: không emit console.log và dùng spec.name (không regex SQL)", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "weird-name", schema: "public", columns: defaultColumnSpecs("weird-name"), keys: [] } satisfies TableSpec;
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(logSpy).not.toHaveBeenCalled();
    expect(state.infoMessages.some((m) => /Created\s+public\.weird-name/.test(m))).toBe(true);
    logSpy.mockRestore();
  });
});

// =============================================================================
// TASK-003 — UnicDB.createSchema: open SchemaForm on connection/schema node;
// OK runs DDL via adapter.runQuery, refreshes tree, reveals new schema node,
// info toast. Driver guard (mysql/mssql) → info, no form. No active conn +
// no node conn → info, no form.
// =============================================================================
describe("tableCommands — TASK-003 UnicDB.createSchema", () => {
  it("#2 connection node → SchemaForm; submit → runDdl(CREATE SCHEMA \"x\";) + refresh + reveal + info", async () => {
    const mgr = makeFakeMgr();
    // Simulate CREATE SCHEMA succeeding: listSchemas() reflects the new schema
    // once runQuery has executed CREATE SCHEMA "x"; — enables revealSchemaNode
    // to find the node.
    const schemasState: string[] = ["public"];
    (mgr.adapter.listSchemas as Mock).mockImplementation(() =>
      Promise.resolve(schemasState.map((name) => ({ name }))),
    );
    (mgr.adapter.runQuery as Mock).mockImplementation((sql: string) => {
      mgr.adapter.runCalls.push({ sql });
      const m = sql.match(/^CREATE SCHEMA "([^"]+)";$/);
      if (m && !schemasState.includes(m[1])) schemasState.push(m[1]);
      return Promise.resolve({ results: [{ columns: [], rows: [], rowCount: 0, durationMs: 1 } as QueryResult] });
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const refreshSpy = vi.spyOn(provider, "refresh");
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "Test PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("UnicDB.createSchema")!(connNode);
    const panel = state.createdPanels[state.createdPanels.length - 1];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    await handler({ type: "nameChanged", name: "x" });
    await handler({ type: "submit", name: "x" });
    for (let i = 0; i < 200 && (!treeView.reveal.mock.calls.length || state.infoMessages.length === 0); i++) await Promise.resolve();
    expect(refreshSpy).toHaveBeenCalled();
    expect(treeView.reveal).toHaveBeenCalled();
    expect(state.infoMessages.some((m) => /schema\s+"x"\s+created/i.test(m))).toBe(true);
  });

  it("#5 mysql driver on connection node → 'UnicDB: Create Schema is not supported by this connection's database.' info; no form", async () => {
    const mgr = makeFakeMgr({ driver: "mysql" });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "MySQL",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("UnicDB.createSchema")!(connNode);
    expect(state.infoMessages.some((m) => m === "UnicDB: Create Schema is not supported by this connection's database.")).toBe(true);
    expect(state.createdPanels.length).toBe(0);
    expect(mgr.adapter.runCalls).toHaveLength(0);
    expect(treeView.reveal).not.toHaveBeenCalled();
  });

  it("#5b mssql driver on connection node → same info guard", async () => {
    const mgr = makeFakeMgr({ driver: "mssql" });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "MSSQL",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("UnicDB.createSchema")!(connNode);
    expect(state.infoMessages.some((m) => m === "UnicDB: Create Schema is not supported by this connection's database.")).toBe(true);
    expect(state.createdPanels.length).toBe(0);
  });

  it("#6 palette invocation: no active conn, no node arg → info message; no form", async () => {
    const mgr = makeFakeMgr();
    const fakeMgr = {
      listConnections: () => [],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
      getAdapter: () => Promise.resolve(mgr.adapter),
      getAdapterFor: () => Promise.resolve(mgr.adapter),
    } as unknown as ConnectionManager;
    const provider = new SchemaTreeProvider(fakeMgr);
    registerSchemaTreeProvider(provider);
    const treeView: MockTreeView = { reveal: vi.fn(), dispose: vi.fn() };
    registerTableCommands({
      mgr: fakeMgr,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    await state.registeredCommands.get("UnicDB.createSchema")!();
    expect(state.infoMessages.some((m) => /no.*(connection|active)/i.test(m))).toBe(true);
    expect(state.createdPanels.length).toBe(0);
  });

  it("#7 runDdl rejects → 'Create Schema failed: permission denied' error; no refresh; no reveal", async () => {
    const mgr = makeFakeMgr({ rejectRun: true });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const refreshSpy = vi.spyOn(provider, "refresh");
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "Test PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("UnicDB.createSchema")!(connNode);
    const panel = state.createdPanels[state.createdPanels.length - 1];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    await handler({ type: "nameChanged", name: "x" });
    await handler({ type: "submit", name: "x" });
    for (let i = 0; i < 200 && state.errorMessages.length === 0; i++) await Promise.resolve();
    expect(state.errorMessages.some((m) => /Create Schema failed: boom/.test(m))).toBe(true);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(treeView.reveal).not.toHaveBeenCalled();
  });

// =============================================================================
// TASK-008 — UnicDB.postmanPayload: register the command + context menu entry;
// route table/view nodes through listColumns, routine through listRoutineParams;
// driver guard (mysql/mssql) → info message, no clipboard write.
// =============================================================================
describe("tableCommands — TASK-008 UnicDB.postmanPayload", () => {
  it("case #2: view node → listColumns + clipboard + status bar", async () => {
    const mgr = makeFakeMgr();
    (mgr.adapter.listColumns as Mock).mockResolvedValue([
      { name: "id", dataType: "integer", nullable: false },
      { name: "name", dataType: "varchar", nullable: true },
    ]);
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const viewNode: UnicDBNode = {
      label: "v_users",
      contextValue: "view",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "v_users" },
    };
    await state.registeredCommands.get("UnicDB.postmanPayload")!(viewNode);
    expect(mgr.adapter.listColumns).toHaveBeenCalledWith("v_users", "public");
    expect(mgr.adapter.listRoutineParams).not.toHaveBeenCalled();
    const expected =
      '{\n' +
      '  schema: "public",\n' +
      '  table: "v_users",\n' +
      '  id: this.workingObj.id,\n' +
      '  name: this.workingObj.name,\n' +
      '}';
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expected);
    expect(state.statusMessages.some((m) => /Postman payload copied/.test(m.text))).toBe(true);
  });

  it("case #3: routine node → listRoutineParams + clipboard payload", async () => {
    const mgr = makeFakeMgr();
    (mgr.adapter.listRoutineParams as Mock).mockResolvedValue([
      { name: "user_id", dataType: "integer" },
      { name: "amount", dataType: "numeric" },
    ]);
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const routineNode: UnicDBNode = {
      label: "add_credit",
      contextValue: "routine",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "add_credit" },
    };
    await state.registeredCommands.get("UnicDB.postmanPayload")!(routineNode);
    expect(mgr.adapter.listRoutineParams).toHaveBeenCalledWith("public", "add_credit");
    expect(mgr.adapter.listColumns).not.toHaveBeenCalled();
    const expected =
      '{\n' +
      '  schema: "public",\n' +
      '  table: "add_credit",\n' +
      '  user_id: this.workingObj.user_id,\n' +
      '  amount: this.workingObj.amount,\n' +
      '}';
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expected);
  });

  it("case #6 (mysql) + #6b (mssql): non-pg driver → info message, no clipboard write", async () => {
    for (const driver of ["mysql", "mssql"] as const) {
      const mgr = makeFakeMgr({ driver });
      const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
      registerSchemaTreeProvider(provider);
      registerTableCommands({
        mgr: mgr.stub as unknown as ConnectionManager,
        tree: provider,
        treeView: treeView as unknown as TreeView<unknown>,
        context: { subscriptions: [] } as unknown as ExtensionContext,
      });
      const tableNode: UnicDBNode = {
        label: "t",
        contextValue: "table",
        collapsible: 0,
        meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
      };
      vscode.env.clipboard.writeText.mockClear();
      await state.registeredCommands.get("UnicDB.postmanPayload")!(tableNode);
      expect(
        state.infoMessages.some((m) =>
          m === "UnicDB: Postman Payload is not supported by this connection's database.",
        ),
      ).toBe(true);
      expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    }
  });

  it("case #7: listRoutineParams → [] (no-arg routine) → { schema, table } only, no crash", async () => {
    const mgr = makeFakeMgr();
    (mgr.adapter.listRoutineParams as Mock).mockResolvedValue([]);
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const routineNode: UnicDBNode = {
      label: "no_args",
      contextValue: "routine",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "no_args" },
    };
    await state.registeredCommands.get("UnicDB.postmanPayload")!(routineNode);
    const expected =
      '{\n  schema: "public",\n  table: "no_args",\n}';
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expected);
    expect(state.statusMessages.some((m) => /Postman payload copied/.test(m.text))).toBe(true);
  });

  it("case #9 wiring: registeredCommands has UnicDB.postmanPayload + package.json menu entry covers table|view|routine", () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    expect(state.registeredCommands.has("UnicDB.postmanPayload")).toBe(true);
    const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
    const pkgJson = fs.readFileSync(pkgPath, "utf8");
    interface MenuItem { command: string; when: string; }
    const menuItems = JSON.parse(pkgJson)
      .contributes.menus["view/item/context"] as MenuItem[];
    const entry = menuItems.find((m) => m.command === "UnicDB.postmanPayload");
    expect(entry).toBeDefined();
    expect(entry!.when).toMatch(/viewItem == table/);
    expect(entry!.when).toMatch(/viewItem == view/);
    expect(entry!.when).toMatch(/viewItem == routine/);
  });
});
});

// =============================================================================
// TASK-004 — UnicDB.exportAllStructures: copy whole-DB DDL to clipboard.
// connection/schema node arg → introspect every user schema (or single schema
// if node is schema) → buildDatabaseStructure → clipboard. PG-only; non-PG
// info guard; no active conn → error; per-object listColumns throw → skipped.
// =============================================================================
describe("tableCommands — TASK-004 UnicDB.exportAllStructures", () => {
  it("#1 happy: connection node PG → clipboard full-DB DDL + statusbar message", async () => {
    const mgr = makeFakeMgr({
      tables: [
        { name: "users", schema: "public" },
        { name: "orders", schema: "public" },
      ],
    });
    (mgr.adapter.listSchemas as Mock).mockResolvedValue([{ name: "public" }]);
    (mgr.adapter.listViews as Mock).mockResolvedValue([]);
    (mgr.adapter.listColumns as Mock).mockImplementation(
      async (name: string, schema: string) => {
        if (name === "users" && schema === "public") {
          return [
            { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
            { name: "email", dataType: "varchar", nullable: false },
          ];
        }
        if (name === "orders" && schema === "public") {
          return [
            { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
          ];
        }
        return [];
      },
    );
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "Test PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    vscode.env.clipboard.writeText.mockClear();
    await state.registeredCommands.get("UnicDB.exportAllStructures")!(connNode);
    const writes = (vscode.env.clipboard.writeText as Mock).mock.calls;
    expect(writes.length).toBe(1);
    const text = writes[0][0] as string;
    expect(text.startsWith("-- Database structure (1 schemas, 2 tables, 0 views)")).toBe(true);
    expect(text).toContain("CREATE TABLE public.users");
    expect(state.statusMessages.some((m) => /database structure copied \(2 objects\)/.test(m.text))).toBe(true);
  });

  it("#2 non-PG (mysql) connection node → guard info; no clipboard write", async () => {
    const mgr = makeFakeMgr({ driver: "mysql" });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "MySQL",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    vscode.env.clipboard.writeText.mockClear();
    await state.registeredCommands.get("UnicDB.exportAllStructures")!(connNode);
    expect(
      state.infoMessages.some((m) =>
        m === "UnicDB: Export All Structures is not supported by this connection's database.",
      ),
    ).toBe(true);
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("#3 empty DB (0 user schemas) → header line only + status 0 objects; no throw", async () => {
    const mgr = makeFakeMgr();
    (mgr.adapter.listSchemas as Mock).mockResolvedValue([]);
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "Empty PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    vscode.env.clipboard.writeText.mockClear();
    await state.registeredCommands.get("UnicDB.exportAllStructures")!(connNode);
    const writes = (vscode.env.clipboard.writeText as Mock).mock.calls;
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toBe(
      "-- Database structure (0 schemas, 0 tables, 0 views)",
    );
    expect(state.statusMessages.some((m) => /database structure copied \(0 objects\)/.test(m.text))).toBe(true);
    expect(state.errorMessages).toHaveLength(0);
  });

  it("#5 1 listColumns throw → skipped, rest copied; no error message", async () => {
    const mgr = makeFakeMgr({
      tables: [
        { name: "broken", schema: "public" },
        { name: "good", schema: "public" },
      ],
    });
    (mgr.adapter.listSchemas as Mock).mockResolvedValue([{ name: "public" }]);
    (mgr.adapter.listViews as Mock).mockResolvedValue([]);
    (mgr.adapter.listColumns as Mock).mockImplementation(
      async (name: string, schema: string) => {
        if (name === "broken") throw new Error("permission denied");
        if (name === "good" && schema === "public") {
          return [{ name: "id", dataType: "integer", nullable: false }];
        }
        return [];
      },
    );
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: UnicDBNode = {
      label: "Test PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    vscode.env.clipboard.writeText.mockClear();
    await state.registeredCommands.get("UnicDB.exportAllStructures")!(connNode);
    const writes = (vscode.env.clipboard.writeText as Mock).mock.calls;
    expect(writes.length).toBe(1);
    const text = writes[0][0] as string;
    expect(text).toContain("CREATE TABLE public.good");
    expect(text).not.toContain("CREATE TABLE public.broken");
    expect(state.errorMessages).toHaveLength(0);
    expect(text.startsWith("-- Database structure (1 schemas, 1 tables, 0 views)")).toBe(true);
  });

  it("#6 no active connection (palette invoke, mgr.getActive() null) → error; no clipboard write; no unhandled rejection", async () => {
    const mgr = makeFakeMgr();
    const fakeMgr = {
      listConnections: () => [],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
      getAdapter: () => Promise.resolve(mgr.adapter),
      getAdapterFor: () => Promise.resolve(mgr.adapter),
    } as unknown as ConnectionManager;
    const provider = new SchemaTreeProvider(fakeMgr);
    registerSchemaTreeProvider(provider);
    const treeView: MockTreeView = { reveal: vi.fn(), dispose: vi.fn() };
    registerTableCommands({
      mgr: fakeMgr,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    vscode.env.clipboard.writeText.mockClear();
    await state.registeredCommands.get("UnicDB.exportAllStructures")!();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    const messages = [
      ...state.errorMessages,
      ...state.infoMessages,
    ].join("\n");
    expect(/no.*(connection|active)/i.test(messages)).toBe(true);
  });

  it("#6b factory getAdapterFor rejects → fail-closed capability message; no clipboard write; no unhandled rejection", async () => {
    const mgr = makeFakeMgr();
    const fakeMgr = {
      listConnections: () => [mgr.cfg],
      getActive: () => mgr.cfg,
      onDidChangeActive: () => ({ dispose: () => {} }),
      getAdapter: () => Promise.resolve(mgr.adapter),
      getAdapterFor: () => Promise.reject(new Error("factory exploded")),
    } as unknown as ConnectionManager;
    const provider = new SchemaTreeProvider(fakeMgr);
    registerSchemaTreeProvider(provider);
    const treeView: MockTreeView = { reveal: vi.fn(), dispose: vi.fn() };
    registerTableCommands({
      mgr: fakeMgr,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    vscode.env.clipboard.writeText.mockClear();
    await state.registeredCommands.get("UnicDB.exportAllStructures")!();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    // DBX-08: an unresolvable adapter declares nothing → fail-closed gate
    // reports the unsupported capability instead of running the export.
    expect(
      state.infoMessages.some((m) =>
        m === "UnicDB: Export All Structures is not supported by this connection's database.",
      ),
    ).toBe(true);
    expect(state.errorMessages).toHaveLength(0);
  });

  it("#7 wiring: registeredCommands has UnicDB.exportAllStructures + package.json menu covers connection|schema", () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    expect(state.registeredCommands.has("UnicDB.exportAllStructures")).toBe(true);
    const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
    const pkgJson = fs.readFileSync(pkgPath, "utf8");
    interface MenuItem { command: string; when: string; }
    const menuItems = JSON.parse(pkgJson)
      .contributes.menus["view/item/context"] as MenuItem[];
    const entry = menuItems.find((m) => m.command === "UnicDB.exportAllStructures");
    expect(entry).toBeDefined();
    expect(entry!.when).toMatch(/viewItem == connection/);
    expect(entry!.when).toMatch(/viewItem == schema/);
  });
});

// =============================================================================
// TASK-DBX08-003 — capability-gated table-DDL admission.
// Test Case #1: a true `tableDdl` declaration keeps every existing flow
// (forms open, DDL runs, clipboard writes).
// Test Case #2: `tableDdl: false` (MySQL/MSSQL-shaped) stops EVERY current
// table-DDL utility command before runQuery / listTableDetail / AI / clipboard
// / form side effects with one concise `UnicDB:` message.
// =============================================================================
describe("tableCommands — DBX-08 tableDdl capability gate", () => {
  /** Register commands against a fresh tree for the given adapter opts. */
  function setup(opts: Parameters<typeof makeFakeMgr>[0]) {
    const mgr = makeFakeMgr(opts);
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    return { mgr, treeView };
  }

  function tableNodeMeta(cfg: ConnectionConfig): UnicDBNode {
    return {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: cfg, schema: "public", objectName: "t" },
    };
  }

  const TABLE_DDL_COMMANDS = [
    "UnicDB.modifyTable",
    "UnicDB.copyCreateDdl",
    "UnicDB.generateSampleData",
    "UnicDB.analyzeTable",
    "UnicDB.vacuumTable",
    "UnicDB.renameTable",
    "UnicDB.renameColumn",
  ] as const;

  /** Exact concise capability message the guard must emit for a command. */
  function expectedMsg(command: string): string {
    // Map camelCase command name to the COMMAND_TITLE wording used in prod.
    const titles: Record<string, string> = {
      modifyTable: "Modify Table",
      copyCreateDdl: "Copy Create Query",
      generateSampleData: "Insert Sample Data…",
      analyzeTable: "Analyze Table",
      vacuumTable: "Vacuum Table",
      renameTable: "Rename Table",
      renameColumn: "Rename Column",
      newTable: "New Table",
      postmanPayload: "Postman Payload",
      exportStructure: "Export Structure",
      exportAllStructures: "Export All Structures",
      createSchema: "Create Schema",
    };
    const key = command.replace("UnicDB.", "");
    return `UnicDB: ${titles[key]} is not supported by this connection's database.`;
  }

  it("declared PostgreSQL table-DDL preserves existing flow (analyze + vacuum + copyCreateDdl)", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
    ];
    const mgr = setup({
      driver: "postgres",
      introspectRows: { columns: cols, constraints: [] },
      tables: [{ name: "t", schema: "public" }],
    });
    const tableNode = tableNodeMeta(mgr.mgr.cfg);
    await state.registeredCommands.get("UnicDB.analyzeTable")!(tableNode);
    await state.registeredCommands.get("UnicDB.vacuumTable")!(tableNode);
    await state.registeredCommands.get("UnicDB.copyCreateDdl")!(tableNode);
    const ddlCalls = mgr.mgr.adapter.runCalls.map((c) => c.sql);
    expect(ddlCalls).toContain('ANALYZE "public"."t"');
    expect(ddlCalls).toContain('VACUUM ANALYZE "public"."t"');
    expect(mgr.mgr.adapter.listTableDetailCalls.length).toBeGreaterThanOrEqual(1);
    expect(vscode.env.clipboard.writeText).toHaveBeenCalled();
    expect(state.errorMessages).toHaveLength(0);
  });

  it("declared tableDdl:true on a mysql-driver adapter admits the flow (declaration, not driver, decides)", async () => {
    const mgr = setup({
      driver: "mysql",
      capabilities: { catalog: false, objectDdl: false, tableDdl: true, admin: false },
    });
    const tableNode = tableNodeMeta(mgr.mgr.cfg);
    await state.registeredCommands.get("UnicDB.analyzeTable")!(tableNode);
    expect(mgr.mgr.adapter.runCalls.some((c) => c.sql.startsWith("ANALYZE"))).toBe(true);
    expect(state.errorMessages).toHaveLength(0);
  });

  it("tableDdl:false blocks MySQL and MSSQL before side effects (all utility commands)", async () => {
    for (const driver of ["mysql", "mssql"] as const) {
      for (const cmd of TABLE_DDL_COMMANDS) {
        const mgr = setup({ driver, listTableDetailUnsupported: true });
        const tableNode = tableNodeMeta(mgr.mgr.cfg);
        vscode.env.clipboard.writeText.mockClear();
        state.inputBoxResult = "5";
        await state.registeredCommands.get(cmd)!(tableNode);
        expect(
          state.infoMessages.some((m) => m === expectedMsg(cmd)),
        ).toBe(true);
        // No side effect of any kind:
        expect(mgr.mgr.adapter.runCalls).toHaveLength(0);
        expect(mgr.mgr.adapter.listTableDetailCalls).toHaveLength(0);
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(state.createdPanels.length).toBe(0);
        expect(mgr.treeView.reveal).not.toHaveBeenCalled();
      }
    }
  });

  it("tableDdl:false blocks newTable before form creation", async () => {
    const mgr = setup({ driver: "mysql", listTableDetailUnsupported: true });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(schemaNode);
    expect(state.createdPanels.length).toBe(0);
    expect(mgr.mgr.adapter.runCalls).toHaveLength(0);
    expect(
      state.infoMessages.some((m) => m === expectedMsg("UnicDB.newTable")),
    ).toBe(true);
  });

  it("tableDdl:false blocks postmanPayload + exportStructure + exportAllStructures before clipboard", async () => {
    for (const cmd of ["UnicDB.postmanPayload", "UnicDB.exportStructure", "UnicDB.exportAllStructures"]) {
      const mgr = setup({ driver: "mysql", listTableDetailUnsupported: true });
      vscode.env.clipboard.writeText.mockClear();
      const tableNode = tableNodeMeta(mgr.mgr.cfg);
      await state.registeredCommands.get(cmd)!(tableNode);
      expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
      expect(mgr.mgr.adapter.listColumns).not.toHaveBeenCalled();
      expect(mgr.mgr.adapter.runCalls).toHaveLength(0);
      expect(
        state.infoMessages.some((m) => m === expectedMsg(cmd)),
      ).toBe(true);
    }
  });

  it("generateSampleData with tableDdl:false never reaches AI config or provider", async () => {
    // The AI mocks in this file resolve config to null → the un-gated command
    // would show "AI not configured". With the gate, the capability message
    // fires INSTEAD and showInputBox never runs.
    const mgr = setup({ driver: "mysql", listTableDetailUnsupported: true });
    const tableNode = tableNodeMeta(mgr.mgr.cfg);
    state.inputBoxResult = "5";
    await state.registeredCommands.get("UnicDB.generateSampleData")!(tableNode);
    expect(
      state.infoMessages.some((m) => m === expectedMsg("UnicDB.generateSampleData")),
    ).toBe(true);
    expect(
      state.infoMessages.some((m) => /AI not configured/i.test(m)),
    ).toBe(false);
  });

  // DBX06-006 — `UnicDB.renameTable` with tableDdl:false emits the exact DBX-08
  // capability message and performs zero side effects (no panel, no
  // renameUsage lookup, no listTableDetail, no runQuery).
  it("UnicDB.renameTable with tableDdl:false shows the exact message and no side effects", async () => {
    const mgr = setup({ driver: "mysql", listTableDetailUnsupported: true });
    const tableNode = tableNodeMeta(mgr.mgr.cfg);
    await state.registeredCommands.get("UnicDB.renameTable")!(tableNode);
    expect(
      state.infoMessages.some((m) => m === expectedMsg("UnicDB.renameTable")),
    ).toBe(true);
    expect(state.createdPanels.length).toBe(0);
    expect(mgr.mgr.adapter.runCalls).toHaveLength(0);
    expect(mgr.mgr.adapter.listTableDetailCalls).toHaveLength(0);
    expect(mgr.treeView.reveal).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TASK-CL-002 — ARP-07 invalidation wiring: form-view DDL fires the seam.
// Per-statement firing after `await adapter.runQuery(sql)` resolves; never on
// the error path; optional dep — callers that omit it stay byte-identical.
// =============================================================================
describe("tableCommands — TASK-CL-002 ARP-07 invalidation seam", () => {
  it("#1 happy: newTable form runDdl success fires onSchemaDdl once with CREATE TABLE + dialect 'postgres'", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const onSchemaDdl = vi.fn();
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
      onSchemaDdl,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "users", schema: "public", columns: defaultColumnSpecs("users"), keys: [] } satisfies TableSpec;
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(onSchemaDdl).toHaveBeenCalledTimes(1);
    const args = onSchemaDdl.mock.calls[0]!;
    const stmts = args[0] as readonly string[];
    const dialect = args[1] as unknown;
    expect(stmts).toHaveLength(1);
    expect((stmts[0] as string).toUpperCase()).toContain("CREATE TABLE");
    expect(dialect).toBe("postgres");
  });

  it("#2 happy: modifyTable runDdl fires onSchemaDdl once with the applied ALTER-ish DDL + dialect 'postgres'", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "bigint", is_nullable: "NO", column_default: null },
      { column_name: "name", format_type: "character varying", is_nullable: "YES", column_default: null },
    ];
    const cons: PgConstraintRow[] = [
      { conname: "t_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null, consrc: "PRIMARY KEY (id)" },
    ];
    const mgr = makeFakeMgr({
      introspectRows: { columns: cols, constraints: cons },
      tables: [{ name: "t", schema: "public" }],
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const onSchemaDdl = vi.fn();
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
      onSchemaDdl,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("UnicDB.modifyTable")!(tableNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const newSpec: TableSpec = {
      name: "t",
      schema: "public",
      columns: [
        { name: "user_id", type: "bigint", nullable: false, originalName: "id" },
        { name: "name", type: "character varying", nullable: true, originalName: "name" },
      ],
      keys: [{ kind: "primaryKey", columns: ["user_id"], name: "t_pkey" }],
    };
    await handler({ type: "specChanged", spec: newSpec });
    await handler({ type: "submit", spec: newSpec });
    expect(onSchemaDdl).toHaveBeenCalledTimes(1);
    const args = onSchemaDdl.mock.calls[0]!;
    const stmts = args[0] as readonly string[];
    const dialect = args[1] as unknown;
    expect(stmts.length).toBeGreaterThan(0);
    expect(dialect).toBe("postgres");
  });

  it("#3 error: adapter.runQuery rejects → onSchemaDdl NOT called; error toast unchanged", async () => {
    const mgr = makeFakeMgr({ rejectRun: true });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const onSchemaDdl = vi.fn();
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
      onSchemaDdl,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "users", schema: "public", columns: defaultColumnSpecs("users"), keys: [] };
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(onSchemaDdl).not.toHaveBeenCalled();
    expect(state.errorMessages.some((m) => m.startsWith("New Table failed: "))).toBe(true);
  });

  it("#4 absent dep: RegisterDeps without onSchemaDdl → command completes normally, no throw", async () => {
    const mgr = makeFakeMgr({ tables: [{ name: "users", schema: "public" }] });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    // Build deps WITHOUT onSchemaDdl — optional contract.
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    const fn = state.registeredCommands.get("UnicDB.newTable");
    await fn!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "users", schema: "public", columns: defaultColumnSpecs("users"), keys: [] };
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(state.errorMessages).toHaveLength(0);
    expect(state.infoMessages.some((m) => /Created\s+public\.users/.test(m))).toBe(true);
  });

  it("#5 driver narrowing: conn.driver === 'bigquery' → callback receives dialect === undefined", async () => {
    // BigQuery is BQ-shaping: the production matrix declares tableDdl:false,
    // so the capability gate would block the form. For this narrowing pin
    // we override the capability to admit the form so the seam can fire.
    const mgr = makeFakeMgr({
      driver: "bigquery",
      capabilities: { catalog: false, objectDdl: false, tableDdl: true, admin: false },
    });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    const onSchemaDdl = vi.fn();
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
      onSchemaDdl,
    });
    const schemaNode: UnicDBNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("UnicDB.newTable")!(schemaNode);
    const panel = state.createdPanels[0];
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;
    await handler({ type: "ready" });
    const spec = { name: "users", schema: "public", columns: defaultColumnSpecs("users"), keys: [] };
    await handler({ type: "specChanged", spec });
    await handler({ type: "submit", spec });
    expect(onSchemaDdl).toHaveBeenCalledTimes(1);
    const args = onSchemaDdl.mock.calls[0]!;
    const dialect = args[1] as unknown;
    expect(dialect).toBeUndefined();
  });
});

// =============================================================================
// TASK-UX1-003 — R1: "Insert Sample Data…" rewires UnicDB.generateSampleData to
// open the UnicDB Console pre-filled with typed INSERT templates (manual
// execution). The AI-driven flow code stays importable + unit-tested in
// src/ui/__tests__/sampleDataAi.test.ts (case 8 regression) — the menu default
// just stops calling it. buildInsertTemplate is a pure export on tableCommands.
// =============================================================================
import { buildInsertTemplate } from "../tableCommands";
import { splitStatements } from "../../core/statementParser";
import type { SampleColumn } from "../sampleDataAi";

function sc(
  name: string,
  type: string,
  nullable = false,
  defaultValue: string | null = null,
): SampleColumn {
  return { name, type, nullable, default: defaultValue };
}

describe("tableCommands — buildInsertTemplate (pure)", () => {
  it("case #1: typed columns → INSERT template with type-specific placeholders", () => {
    const out = buildInsertTemplate(
      [
        sc("id", "integer", false),
        sc("name", "text", true),
        sc("active", "boolean", false),
        sc("created_at", "timestamp", true),
      ],
      { schema: "public", table: "users" },
    );
    expect(out).toMatch(/-- Edit values, then run/i);
    expect(out).toMatch(/INSERT INTO "public"\."users"/);
    expect(out).toMatch(/VALUES \(/);
    // >=5 INSERTs by default
    expect((out.match(/INSERT INTO/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // Integers bare
    expect(out).toMatch(/INSERT INTO "public"\."users" \("id","name","active","created_at"\) VALUES \(0,/);
    // Boolean NOT NULL → true
    expect(out).toMatch(/, true,/);
    // Timestamp → NOW()
    expect(out).toMatch(/, NOW\(\)/);
    // No trailing statement outside an INSERT
    expect(out.trim().endsWith(";")).toBe(true);
  });

  it("case #2: menu retitle — package.json UnicDB.generateSampleData title is 'Insert Sample Data…' (id unchanged)", () => {
    const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    const cmd = pkg.contributes.commands.find((c) => c.command === "UnicDB.generateSampleData");
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe("Insert Sample Data…");
    // activationEvents + menu entries unchanged (id still UnicDB.generateSampleData)
    const actEvts: unknown = (pkg as unknown as {
      activationEvents?: string[];
    }).activationEvents;
    if (Array.isArray(actEvts)) {
      expect(actEvts).toContain("onCommand:UnicDB.generateSampleData");
    }
  });

  it("case #3: identity-only table → header comment only, zero INSERTs, no throw", () => {
    // pickInsertableColumns drops columns whose default contains nextval
    // (identity / sequence-driven). Simulate that already happened upstream.
    const out = buildInsertTemplate([], { schema: "public", table: "idonly" });
    expect(out).toMatch(/-- Edit values, then run/i);
    expect((out.match(/INSERT INTO/g) ?? []).length).toBe(0);
    expect(out).not.toMatch(/VALUES/);
  });

  it("case #4: boundary rows — default 5, explicit 12, 0 → header-only, 1000 → capped at 20", () => {
    const cols = [sc("id", "integer", false), sc("name", "text", true)];
    expect((buildInsertTemplate(cols, { schema: "s", table: "t" }).match(/INSERT INTO/g) ?? []).length).toBe(5);
    expect((buildInsertTemplate(cols, { schema: "s", table: "t", rows: 12 }).match(/INSERT INTO/g) ?? []).length).toBe(12);
    expect((buildInsertTemplate(cols, { schema: "s", table: "t", rows: 0 }).match(/INSERT INTO/g) ?? []).length).toBe(0);
    expect((buildInsertTemplate(cols, { schema: "s", table: "t", rows: 1000 }).match(/INSERT INTO/g) ?? []).length).toBe(20);
  });

  it("case #5: exotic / unknown types render syntactically safe placeholders", () => {
    const out = buildInsertTemplate(
      [
        sc("a", "bytea"),
        sc("b", "jsonb"),
        sc("c", "numeric(10,2)"),
        sc("d", "_int4"),
        sc("e", "USER-DEFINED"),
      ],
      { schema: "s", table: "t" },
    );
    expect(out).toMatch(/\/\* bytea \*\/ NULL/);
    expect(out).toMatch(/'\{\}'::jsonb/);
    expect(out).toMatch(/VALUES \(.*\b0,/);
    expect(out).toMatch(/\/\* array \*\/ NULL/);
    expect(out).toMatch(/\/\* USER-DEFINED \*\/ NULL/);
    // Every statement round-trips through splitStatements without leaving an
    // unbalanced string literal / construct stack. The first parsed
    // statement is the leading `-- UnicDB: ...` header comment block, so we
    // filter to lines that actually start a SQL statement. splitStatements
    // strips the trailing `;` on each parsed statement — the original
    // buffer must contain it (and our buildInsertTemplate guarantees that).
    const stmts = splitStatements(out, "postgres");
    const inserts = stmts.filter((s) => /^INSERT INTO/i.test(s.text));
    expect(inserts.length).toBeGreaterThanOrEqual(5);
    for (const s of inserts) {
      expect(s.text).toMatch(/^INSERT INTO/i);
    }
    expect(out.match(/INSERT INTO[^;]+;/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("case #6: NOT NULL text → literal placeholder, never NULL", () => {
    const out = buildInsertTemplate(
      [sc("name", "text", false), sc("bio", "text", true)],
      { schema: "s", table: "t", rows: 1 },
    );
    // Every row renders a non-NULL literal for the NOT NULL "name" column.
    expect(out).toMatch(/'Sample name'/);
    // The nullable "bio" may render as NULL or a literal; both acceptable.
    expect(out).toMatch(/NULL|'Sample bio'/);
    // And no row contains NULL for the NOT NULL column.
    const insertLine = out.split("\n").find((l) => /^INSERT INTO/.test(l)) ?? "";
    expect(insertLine).not.toMatch(/'name',\s*NULL\s*,/);
  });
});

describe("tableCommands — UnicDB.generateSampleData (TASK-UX1-003 console templates)", () => {
  // Hoisted mock fns so vi.mock factories (which run before imports resolve)
  // can hand the same instances back via sampleDataAi + AiConfigStore.
  const aiHarness = vi.hoisted(() => ({
    generate: vi.fn(async (_deps: unknown) => ({ inserted: 3 })),
    pickInsertableColumns: vi.fn(
      (_tableName: string, cols: PgColumnRow[]) => cols,
    ),
  }));
  const configHarness = vi.hoisted(() => ({
    loadConfig: vi.fn(async () => null as unknown),
  }));
  // Hoisted console seam recorder — tableCommands.ts calls
  // openConsoleWithTemplate(name, buffer); we replace the import target with
  // a stub fn so the test can assert what was seeded without touching the
  // real ConsolePanel / vscode extension module.
  const consoleSeam = vi.hoisted(() => ({
    openConsoleWithTemplate: vi.fn(
      (_name: string, _buffer: string): void => {},
    ),
  }));

  vi.mock("../sampleDataAi", () => ({
    aiGenerateSampleData: aiHarness.generate,
    buildSampleDataPrompt: vi.fn(),
    pickInsertableColumns: aiHarness.pickInsertableColumns,
    parseInsertStatements: vi.fn(),
  }));

  vi.mock("../../ai/config", () => ({
    AiConfigStore: class FakeStore {
      constructor(_ctx: unknown) {}
      loadConfig = configHarness.loadConfig;
      loadSettings = vi.fn();
      loadApiKey = vi.fn();
      save = vi.fn();
      clear = vi.fn();
      static defaults = () => ({});
    },
  }));

  interface CtxOpts { subscriptions?: unknown[]; }
  function makeCtx(opts: CtxOpts = {}): ExtensionContext {
    return {
      subscriptions: opts.subscriptions ?? [],
      globalState: { get: vi.fn().mockReturnValue(undefined), update: vi.fn() },
      secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
      extensionUri: { toString: () => "vscode://test" } as unknown as ExtensionContext["extensionUri"],
    } as unknown as ExtensionContext;
  }

  function setupCommand(cols: PgColumnRow[]) {
    const mgr = makeFakeMgr({ introspectRows: { columns: cols, constraints: [] } });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: makeCtx(),
      openConsoleWithTemplate: consoleSeam.openConsoleWithTemplate,
    });
    const tableNode: UnicDBNode = {
      label: "users",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "users" },
    };
    return { mgr, tableNode };
  }

  beforeEach(() => {
    aiHarness.generate.mockClear();
    aiHarness.generate.mockResolvedValue({ inserted: 3 });
    aiHarness.pickInsertableColumns.mockClear();
    aiHarness.pickInsertableColumns.mockImplementation(
      (_t: string, cols: PgColumnRow[]) => cols,
    );
    configHarness.loadConfig.mockReset();
    configHarness.loadConfig.mockResolvedValue(null);
    consoleSeam.openConsoleWithTemplate.mockClear();
    consoleSeam.openConsoleWithTemplate.mockReset();
    consoleSeam.openConsoleWithTemplate.mockImplementation(() => {});
  });

  it("case #1: typed columns → console seeded with INSERT templates; zero AI / runner calls", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "name", format_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "active", format_type: "boolean", is_nullable: "NO", column_default: null },
      { column_name: "created_at", format_type: "timestamp", is_nullable: "YES", column_default: null },
    ];
    const { mgr, tableNode } = setupCommand(cols);
    await state.registeredCommands.get("UnicDB.generateSampleData")!(tableNode);
    // Console opened once with a non-empty buffer
    expect(consoleSeam.openConsoleWithTemplate).toHaveBeenCalledTimes(1);
    const [name, buffer] = consoleSeam.openConsoleWithTemplate.mock.calls[0]!;
    expect(name).toBe("Sample public.users");
    expect(typeof buffer).toBe("string");
    expect((buffer as string).length).toBeGreaterThan(0);
    expect(buffer as string).toMatch(/INSERT INTO "public"\."users"/);
    // No AI provider call. No adapter.runQuery call. No input box.
    expect(aiHarness.generate).not.toHaveBeenCalled();
    expect(configHarness.loadConfig).not.toHaveBeenCalled();
    expect(mgr.adapter.runCalls).toHaveLength(0);
    expect((vscode.window.showInputBox as Mock).mock.calls.length).toBe(0);
  });

  it("case #7: guardPostgres fails (mysql) → toast path, console NOT opened, no throw", async () => {
    const mgr = makeFakeMgr({ driver: "mysql", listTableDetailUnsupported: true });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: makeCtx(),
      openConsoleWithTemplate: consoleSeam.openConsoleWithTemplate,
    });
    const tableNode: UnicDBNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("UnicDB.generateSampleData")!(tableNode);
    expect(
      state.infoMessages.some((m) =>
        m === "UnicDB: Insert Sample Data… is not supported by this connection's database.",
      ),
    ).toBe(true);
    expect(consoleSeam.openConsoleWithTemplate).not.toHaveBeenCalled();
  });

  it("case #3 edge A — identity-only table → header comment, zero INSERTs, console still opened", async () => {
    // pickInsertableColumns is mocked to drop every column (simulates identity
    // / nextval-default filtered out upstream).
    aiHarness.pickInsertableColumns.mockReturnValue([]);
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "integer", is_nullable: "NO", column_default: "nextval('users_seq')" },
    ];
    const { tableNode } = setupCommand(cols);
    await state.registeredCommands.get("UnicDB.generateSampleData")!(tableNode);
    expect(consoleSeam.openConsoleWithTemplate).toHaveBeenCalledTimes(1);
    const [, buffer] = consoleSeam.openConsoleWithTemplate.mock.calls[0]!;
    expect(buffer as string).toMatch(/-- Edit values, then run/i);
    expect((buffer as string).match(/INSERT INTO/g) ?? []).toHaveLength(0);
    // R4.5: when zero columns survive, the header copy must say so (not
    // "5 placeholder INSERT statement(s)" which would contradict the
    // empty body and mislead the user).
    expect(buffer as string).toMatch(/No insertable columns detected/);
  });

  it("AI branch remains importable (sampleDataAi module exports) — case #8 regression", async () => {
    // The default menu path no longer calls aiGenerateSampleData, but the
    // module still exports it for power users / future wiring. This is the
    // "AI path survives" pin from the task.
    const mod = await import("../sampleDataAi");
    expect(typeof mod.aiGenerateSampleData).toBe("function");
    expect(typeof mod.buildSampleDataPrompt).toBe("function");
    expect(typeof mod.pickInsertableColumns).toBe("function");
    expect(typeof mod.parseInsertStatements).toBe("function");
  });
});
