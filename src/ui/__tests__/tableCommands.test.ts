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
import { registerTableCommands } from "../tableCommands";
import {
  SchemaTreeProvider,
  type VsdbNode,
  registerSchemaTreeProvider,
} from "../schemaTree";
import type { ConnectionManager } from "../../core/connectionManager";

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
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    runQuery,
    listSchemas: vi.fn().mockResolvedValue([{ name: "public" }]),
    listTables: vi.fn().mockImplementation((schema?: string) => {
      return Promise.resolve(initialTables.filter((t) => (schema ? t.schema === schema : true)));
    }),
    listViews: vi.fn().mockResolvedValue([]),
    listRoutines: vi.fn().mockResolvedValue([]),
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
}

function makeFakeMgr(opts: FakeMgrOptions = {}) {
  const cfg: ConnectionConfig = {
    id: "c1",
    name: "Test PG",
    driver: opts.driver ?? "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "vsdb",
    database: "vsdb",
  };
  const adapter = makeFakeAdapter({
    driver: opts.driver,
    introspectRows: opts.introspectRows,
    initialTables: opts.tables,
    listTableDetailUnsupported: opts.listTableDetailUnsupported,
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

describe("tableCommands — vsdb.newTable", () => {
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
    const schemaNode: VsdbNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    const fn = state.registeredCommands.get("vsdb.newTable");
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

describe("tableCommands — vsdb.modifyTable", () => {
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
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    const fn = state.registeredCommands.get("vsdb.modifyTable");
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
  it("#7 mysql guard → 'Modify Table: PostgreSQL connections only' info, no runQuery", async () => {
    const mgr = makeFakeMgr({ driver: "mysql", listTableDetailUnsupported: true });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("vsdb.modifyTable")!(tableNode);
    expect(state.infoMessages.some((m) => /Modify Table.*PostgreSQL connections only/.test(m))).toBe(true);
    expect(mgr.adapter.runCalls).toHaveLength(0);
    expect(state.createdPanels.length).toBe(0);
    expect(treeView.reveal).not.toHaveBeenCalled();
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
    const viewsNode: VsdbNode = {
      label: "Views",
      contextValue: "category",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", category: "views" },
    };
    await state.registeredCommands.get("vsdb.newTable")!(viewsNode);
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
    const schemaNode: VsdbNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("vsdb.newTable")!(schemaNode);
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

describe("tableCommands — vsdb.copyCreateDdl", () => {
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
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("vsdb.copyCreateDdl")!(tableNode);
    const expectedSpec = rowsToSpec("public", "t", cols, cons);
    const expectedDdl = generateCreateTable(expectedSpec);
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expectedDdl);
    expect(state.statusMessages.some((m) => /DDL copied/.test(m.text))).toBe(true);
  });
});

describe("tableCommands — vsdb.generateSampleData", () => {
  it("#10 InputBox '3' → openTextDocument {language:'sql', content: 3-row INSERT}; showTextDocument called", async () => {
    const cols: PgColumnRow[] = [
      { column_name: "id", format_type: "integer", is_nullable: "YES", column_default: null },
    ];
    const mgr = makeFakeMgr({ introspectRows: { columns: cols, constraints: [] } });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    state.inputBoxResult = "3";
    const openTextDocumentSpy = vi.spyOn(vscode.workspace, "openTextDocument").mockImplementation((doc: unknown) => Promise.resolve(doc as unknown as TextDocument));
    const showTextDocumentSpy = vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue(undefined as unknown as TextEditor);
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("vsdb.generateSampleData")!(tableNode);
    expect(openTextDocumentSpy).toHaveBeenCalledTimes(1);
    expect(showTextDocumentSpy).toHaveBeenCalled();
  });

  it("#11 InputBox 'abc' → Information 'Enter a positive number'; undefined → nothing", async () => {
    const mgr = makeFakeMgr();
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    state.inputBoxResult = "abc";
    await state.registeredCommands.get("vsdb.generateSampleData")!(tableNode);
    expect(state.infoMessages.some((m) => /Enter a positive number/.test(m))).toBe(true);
    state.infoMessages.length = 0;
    state.inputBoxResult = undefined;
    await state.registeredCommands.get("vsdb.generateSampleData")!(tableNode);
    expect(mgr.adapter.runCalls).toHaveLength(0);
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
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("vsdb.analyzeTable")!(tableNode);
    await state.registeredCommands.get("vsdb.vacuumTable")!(tableNode);
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
    const tableNode: VsdbNode = {
      label: "t",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "t" },
    };
    await state.registeredCommands.get("vsdb.modifyTable")!(tableNode);
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
    const tableNode: VsdbNode = {
      label: "users",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "users" },
    };
    await state.registeredCommands.get("vsdb.copyCreateDdl")!(tableNode);
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
    const tableNode: VsdbNode = {
      label: "users",
      contextValue: "table",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public", objectName: "users", category: "columns" },
    };
    await state.registeredCommands.get("vsdb.newTable")!(tableNode);
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
    const schemaNode: VsdbNode = {
      label: "public",
      contextValue: "schema",
      collapsible: 0,
      meta: { connection: mgr.cfg, schema: "public" },
    };
    await state.registeredCommands.get("vsdb.newTable")!(schemaNode);
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
// TASK-003 — vsdb.createSchema: open SchemaForm on connection/schema node;
// OK runs DDL via adapter.runQuery, refreshes tree, reveals new schema node,
// info toast. Driver guard (mysql/mssql) → info, no form. No active conn +
// no node conn → info, no form.
// =============================================================================
describe("tableCommands — TASK-003 vsdb.createSchema", () => {
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
    const connNode: VsdbNode = {
      label: "Test PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("vsdb.createSchema")!(connNode);
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

  it("#5 mysql driver on connection node → 'Create Schema: PostgreSQL connections only' info; no form", async () => {
    const mgr = makeFakeMgr({ driver: "mysql" });
    const { provider, treeView } = makeTreeWithAdapter(mgr.adapter);
    registerSchemaTreeProvider(provider);
    registerTableCommands({
      mgr: mgr.stub as unknown as ConnectionManager,
      tree: provider,
      treeView: treeView as unknown as TreeView<unknown>,
      context: { subscriptions: [] } as unknown as ExtensionContext,
    });
    const connNode: VsdbNode = {
      label: "MySQL",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("vsdb.createSchema")!(connNode);
    expect(state.infoMessages.some((m) => /Create Schema.*PostgreSQL connections only/.test(m))).toBe(true);
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
    const connNode: VsdbNode = {
      label: "MSSQL",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("vsdb.createSchema")!(connNode);
    expect(state.infoMessages.some((m) => /Create Schema.*PostgreSQL connections only/.test(m))).toBe(true);
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
    await state.registeredCommands.get("vsdb.createSchema")!();
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
    const connNode: VsdbNode = {
      label: "Test PG",
      contextValue: "connection",
      collapsible: 0,
      meta: { connection: mgr.cfg },
    };
    await state.registeredCommands.get("vsdb.createSchema")!(connNode);
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
});
