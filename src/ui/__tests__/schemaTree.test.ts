// src/ui/__tests__/schemaTree.test.ts
// Unit tests cho SchemaTreeProvider + generateSelect utility (TDD — TASK-007).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ThemeIcon } from "vscode";
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter, ColumnInfo } from "../../adapters/types";

// ---- Mock vscode module ----------------------------------------------------

type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };
  fire(data: T): void {
    for (const l of this.listeners.slice()) l(data);
  }
  dispose = (): void => {
    this.listeners = [];
  };
}

// Module-scoped (mutable) state — bound before any test runs.
// vi.mock factory reads them via indirection (getter) after setup.
const state = {
  emitters: [] as FakeEventEmitter<unknown>[],
  workspaceFolders: undefined as unknown,
  hideSystemSchemas: true,
  showInfo: vi.fn().mockResolvedValue(undefined),
  showError: vi.fn().mockResolvedValue(undefined),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  treeItemCalls: [] as Array<{ label: string; collapsible: unknown }>,
};

vi.mock("vscode", () => {
  // Builder function accessed lazily (after state is assigned).
  const Item = function (this: unknown, label: string, collapsible: unknown) {
    state.treeItemCalls.push({ label, collapsible });
    (this as { label: string }).label = label;
    (this as { collapsible: unknown }).collapsible = collapsible;
    return this;
  } as unknown as { new (label: string, collapsible: unknown): unknown };
  return {
    EventEmitter: vi.fn(() => {
      const e = new FakeEventEmitter<unknown>();
      state.emitters.push(e);
      return e;
    }),
    TreeItem: Item,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: vi.fn(),
    ThemeColor: vi.fn(),
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    get window() {
      return {
        showInformationMessage: state.showInfo,
        showErrorMessage: state.showError,
        showInputBox: state.showInputBox,
        showQuickPick: state.showQuickPick,
      };
    },
    get workspace() {
      return {
        get workspaceFolders() {
          return state.workspaceFolders;
        },
        getConfiguration: (section?: string) => ({
          get: (key: string, fallback?: unknown) => {
            if (section === "vsdb" && key === "hideSystemSchemas") {
              return state.hideSystemSchemas;
            }
            return fallback;
          },
        }),
      };
    },
  };
});

// Import after vi.mock.
import {
  SchemaTreeProvider,
  generateSelectForTable,
  qualifiedName,
  formatRows,
  revealTableNode,
  revealSchemaNode,
  registerSchemaTreeProvider,
} from "../schemaTree";
import { ConnectionManager } from "../../core/connectionManager";

// ---- Fake helpers -----------------------------------------------------------

function makeCfg(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: overrides.id ?? "c1",
    name: overrides.name ?? "Test PG",
    driver: overrides.driver ?? "postgres",
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 5432,
    user: overrides.user ?? "vsdb",
    database: overrides.database ?? "vsdb",
    ...overrides,
  };
}
function makeFakeAdapter(opts: {
  schemas?: Array<{ name: string }>;
  tables?: Array<{ name: string; schema: string }>;
  views?: Array<{ name: string; schema: string }>;
  routines?: Array<{ name: string; kind: "function" | "procedure"; schema: string }>;
  columns?: ColumnInfo[];
  throw?: boolean;
  /** Optional override for estimateTableRows. Receives (schema, table) and
   * returns Promise<number | null>. Defaults to resolving null. */
  estimateTableRowsImpl?: (schema: string, table: string) => Promise<number | null>;
} = {}) {
  const listSchemas = vi.fn().mockImplementation(() => {
    if (opts.throw) throw new Error("connect failed");
    return Promise.resolve(opts.schemas ?? [{ name: "public" }]);
  });
  const listTables = vi.fn().mockImplementation((schema?: string) => {
    if (opts.throw) throw new Error("connect failed");
    const tables = opts.tables ?? [];
    return Promise.resolve(schema ? tables.filter((t) => t.schema === schema) : tables);
  });
  const listViews = vi.fn().mockImplementation((schema?: string) => {
    if (opts.throw) throw new Error("connect failed");
    const views = opts.views ?? [];
    return Promise.resolve(schema ? views.filter((v) => v.schema === schema) : views);
  });
  const listRoutines = vi.fn().mockImplementation((schema?: string) => {
    if (opts.throw) throw new Error("connect failed");
    const routines = opts.routines ?? [];
    return Promise.resolve(schema ? routines.filter((r) => r.schema === schema) : routines);
  });
  const listColumns = vi.fn().mockImplementation(() => {
    if (opts.throw) throw new Error("connect failed");
    return Promise.resolve(opts.columns ?? []);
  });
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    runQuery: vi.fn(),
    listSchemas,
    listTables,
    listViews,
    listRoutines,
    listColumns,
    estimateTableRows: vi.fn().mockImplementation((schema: string, table: string) =>
      opts.estimateTableRowsImpl
        ? opts.estimateTableRowsImpl(schema, table)
        : Promise.resolve<number | null>(null),
    ),
    testConnection: vi.fn().mockResolvedValue(undefined),
  };
}

class FakeSecretStorage {
  private data = new Map<string, string>();
  store = vi.fn(async (key: string, value: string) => {
    this.data.set(key, value);
  });
  get = vi.fn(async (key: string) => this.data.get(key));
  delete = vi.fn(async (key: string) => {
    this.data.delete(key);
  });
}
class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
    return Promise.resolve();
  }
}

interface Harness {
  mgr: ConnectionManager;
  adapter: ReturnType<typeof makeFakeAdapter>;
  factory: ReturnType<typeof vi.fn>;
  adapters: ReturnType<typeof makeFakeAdapter>[];
}

function setupTree(opts: {
  schemas?: Array<{ name: string }>;
  tables?: Array<{ name: string; schema: string }>;
  views?: Array<{ name: string; schema: string }>;
  routines?: Array<{ name: string; kind: "function" | "procedure"; schema: string }>;
  columns?: ColumnInfo[];
  throw?: boolean;
  hideSystemSchemas?: boolean;
  /** When true, factory returns a NEW adapter instance on every call (so we can
   * detect socket-leak regressions: count distinct adapter creations). */
  factoryPerCall?: boolean;
} = {}): Harness {
  state.emitters = [];
  state.treeItemCalls = [];
  state.workspaceFolders = undefined;
  state.hideSystemSchemas = opts.hideSystemSchemas ?? true;
  const adapter = makeFakeAdapter(opts);
  const adapters: ReturnType<typeof makeFakeAdapter>[] = [adapter];
  const factory = opts.factoryPerCall
    ? vi.fn(() => {
        const a = makeFakeAdapter(opts);
        adapters.push(a);
        return a as unknown as DbAdapter;
      })
    : vi.fn(() => adapter as unknown as DbAdapter);
  const secret = new FakeSecretStorage();
  const ws = new FakeMemento();
  const g = new FakeMemento();
  const mgr = new ConnectionManager(
    {
      secrets: secret as never,
      workspaceState: ws as never,
      globalState: g as never,
    } as never,
    factory,
  );
  return { mgr, adapter, factory, adapters };
}

// ---- Tests ----------------------------------------------------------------

describe("SchemaTreeProvider — getChildren", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
  });

  it("connection expand → schema nodes with listSchemas(includeSystem=false)", async () => {
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "app" }, { name: "public" }],
    });
    await mgr.addConnection(makeCfg({ id: "a", name: "Local" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    expect(root).toHaveLength(1);
    expect(root[0].contextValue).toBe("connection");

    const schemas = await provider.getChildren(root[0]);
    expect(adapter.listSchemas).toHaveBeenCalledWith(false);
    expect(schemas.map((s) => s.label)).toEqual(["app", "public"]);
    expect(schemas.map((s) => s.contextValue)).toEqual(["schema", "schema"]);
    expect(schemas.every((s) => s.collapsible === 1)).toBe(true);
  });

  it("schema expand → 3 DataGrip-style category folders", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "app" }] });
    await mgr.addConnection(makeCfg({ id: "a", name: "Local" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);

    expect(cats.map((c) => c.label)).toEqual(["Tables", "Views", "Routines"]);
    expect(cats.map((c) => c.contextValue)).toEqual(["category", "category", "category"]);
    expect(cats.every((c) => c.meta?.schema === "app")).toBe(true);
  });

  it("category expand passes schema and updates count description", async () => {
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "app" }],
      tables: [
        { name: "users", schema: "app" },
        { name: "orders", schema: "app" },
        { name: "audit_log", schema: "audit" },
      ],
    });
    await mgr.addConnection(makeCfg({ id: "a", name: "Local" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats[0];
    const tables = await provider.getChildren(tablesNode);

    expect(adapter.listTables).toHaveBeenCalledWith("app");
    expect(tables.map((t) => t.label)).toEqual(["users", "orders"]);
    expect(tablesNode.description).toBe("2");
  });

  it("table node objectKey includes schema", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [{ name: "users", schema: "app" }],
    });
    await mgr.addConnection(makeCfg({ id: "connId", name: "Local" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);

    expect(tables[0].meta?.objectKey).toBe("connId.app.users");
  });

  it("listSchemas [] → no schemas node", async () => {
    const { mgr } = setupTree({ schemas: [] });
    await mgr.addConnection(makeCfg({ id: "empty", name: "Empty" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].label).toBe("No schemas");
    expect(schemas[0].collapsible).toBe(0);
  });

  it("schema/category cache keys distinguish schema and refresh clears entries", async () => {
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "app" }, { name: "audit" }],
      tables: [
        { name: "users", schema: "app" },
        { name: "events", schema: "audit" },
      ],
    });
    await mgr.addConnection(makeCfg({ id: "cache", name: "Cache" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const appCats = await provider.getChildren(schemas[0]);
    const auditCats = await provider.getChildren(schemas[1]);

    await provider.getChildren(appCats[0]);
    await provider.getChildren(auditCats[0]);
    await provider.getChildren(appCats[0]);
    expect(adapter.listTables).toHaveBeenCalledTimes(2);
    expect(adapter.listTables.mock.calls.map((c) => c[0])).toEqual(["app", "audit"]);

    provider.refresh();
    const refreshedRoot = await provider.getChildren(undefined);
    const refreshedSchemas = await provider.getChildren(refreshedRoot[0]);
    const refreshedCats = await provider.getChildren(refreshedSchemas[0]);
    await provider.getChildren(refreshedCats[0]);
    expect(adapter.listTables).toHaveBeenCalledTimes(3);
  });

  it("hideSystemSchemas=false passes includeSystem=true to listSchemas", async () => {
    const { mgr, adapter } = setupTree({
      hideSystemSchemas: false,
      schemas: [{ name: "pg_catalog" }],
    });
    await mgr.addConnection(makeCfg({ id: "sys", name: "System" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    await provider.getChildren(root[0]);

    expect(adapter.listSchemas).toHaveBeenCalledWith(true);
  });

  it("lazy + cache 60s: listTables 1 lần trong 60s; refresh → gọi lại", async () => {
    vi.useFakeTimers();
    try {
      const { mgr, adapter } = setupTree({
        schemas: [{ name: "public" }],
        tables: [{ name: "users", schema: "public" }],
      });
      await mgr.addConnection(makeCfg({ id: "x" }), "p");
      await mgr.setActive("x");
      const provider = new SchemaTreeProvider(mgr);

      const root = await provider.getChildren(undefined);
      const conn = root[0];
      const schemas = await provider.getChildren(conn);
      const cats = await provider.getChildren(schemas[0]);
      const tablesNode = cats[0];

      await provider.getChildren(tablesNode);
      expect(adapter.listTables).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30 * 1000);
      await provider.getChildren(tablesNode);
      expect(adapter.listTables).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31 * 1000);
      await provider.getChildren(tablesNode);
      expect(adapter.listTables).toHaveBeenCalledTimes(2);

      provider.refresh();
      await provider.getChildren(tablesNode);
      expect(adapter.listTables).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adapter throw → child node error 'Connect failed' (không crash)", async () => {
    const { mgr } = setupTree({ throw: true });
    await mgr.addConnection(makeCfg({ id: "z" }), "p");
    await mgr.setActive("z");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);

    const schemas = await provider.getChildren(root[0]);
    expect(schemas).toHaveLength(1);
    expect(schemas[0].contextValue).toBe("error");
    expect(schemas[0].label.toLowerCase()).toMatch(/connect failed|error/);

    // No throw above — assert tree provider is still usable.
    const second = await provider.getChildren(undefined);
    expect(second.length).toBeGreaterThanOrEqual(1);
  });

  it("Test #4 — Generate SELECT đúng template theo driver", () => {
    expect(
      generateSelectForTable({
        driver: "postgres",
        table: "users",
        schema: "public",
      }),
    ).toBe("SELECT * FROM public.users LIMIT 100;");
    expect(
      generateSelectForTable({
        driver: "postgres",
        table: "users",
        schema: "",
      }),
    ).toBe("SELECT * FROM users LIMIT 100;");
    expect(
      generateSelectForTable({
        driver: "mysql",
        table: "users",
        schema: "",
      }),
    ).toBe("SELECT * FROM `users` LIMIT 100;");
    expect(
      generateSelectForTable({
        driver: "mssql",
        table: "users",
        schema: "dbo",
      }),
    ).toBe("SELECT TOP 100 * FROM dbo.users;");
  });
  it("regression — MySQL Generate SELECT giữ schema cho object dưới schema non-default", () => {
    // Trước fix: MySQL bỏ schema → SELECT * FROM `api_log` LIMIT 100;
    // sai khi object thuộc schema khác default (vd db `qas`).
    expect(
      generateSelectForTable({
        driver: "mysql",
        table: "api_log",
        schema: "qas",
      }),
    ).toBe("SELECT * FROM `qas`.`api_log` LIMIT 100;");
    // Schema rỗng: giữ nguyên behavior cũ (không qualify).
    expect(
      generateSelectForTable({
        driver: "mysql",
        table: "users",
        schema: "",
      }),
    ).toBe("SELECT * FROM `users` LIMIT 100;");
  });


  it("qualifiedName() trả schema.name hoặc name nếu schema rỗng", () => {
    expect(qualifiedName({ table: "users", schema: "public" })).toBe("public.users");
    expect(qualifiedName({ table: "users", schema: "" })).toBe("users");
  });
});

describe("SchemaTreeProvider — column children", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.treeItemCalls = [];
  });

  it("expand table → column nodes", async () => {
    const cols: ColumnInfo[] = [
      { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "text", nullable: true },
    ];
    const { mgr } = setupTree({
      tables: [{ name: "users", schema: "public" }],
      columns: cols,
    });
    await mgr.addConnection(makeCfg({ id: "p" }), "p");
    await mgr.setActive("p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats[0];
    const tables = await provider.getChildren(tablesNode);
    const tableNode = tables[0];

    const columns = await provider.getChildren(tableNode);
    expect(columns).toHaveLength(2);
    expect(columns[0].label).toBe("id");
    expect(columns[0].contextValue).toBe("column");
    expect(columns[0].description).toContain("int");
  });
});

describe("SchemaTreeProvider — getTreeItem", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getTreeItem trả vscode.TreeItem cho node", async () => {
    const { mgr } = setupTree();
    await mgr.addConnection(makeCfg({ id: "t", name: "ConnT" }), "p");
    const provider = new SchemaTreeProvider(mgr);
    const root = await provider.getChildren(undefined);
    const item = provider.getTreeItem(root[0]);
    expect(item).toBeDefined();
    expect((item as { label?: string }).label).toContain("ConnT");
  });
});

describe("SchemaTreeProvider — exports / sanity", () => {
  it("SchemaTreeProvider is constructible with a minimal stub mgr", () => {
    const stubMgr = {
      listConnections: () => [] as ConnectionConfig[],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
    };
    const provider = new SchemaTreeProvider(stubMgr as never);
    expect(typeof provider.getChildren).toBe("function");
    expect(typeof provider.getTreeItem).toBe("function");
    expect(typeof provider.refresh).toBe("function");
  });

  it("root với 0 connections → [] (empty state do viewsWelcome render, không còn placeholder node)", async () => {
    const stubMgr = {
      listConnections: () => [] as ConnectionConfig[],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
    };
    const provider = new SchemaTreeProvider(stubMgr as never);
    const root = await provider.getChildren(undefined);
    expect(root).toHaveLength(0);
  });
});

// =============================================================================
// Regression: socket leak khi expand NON-active connection trong SchemaTree.
// Trước fix: mỗi expand → factory() tạo adapter mới → adapter.close() KHÔNG
// được gọi → socket leak vĩnh viễn. Sau fix: ConnectionManager cache adapter
// theo connection id → chỉ tạo 1 adapter dù expand N lần, và adapter.close()
// được gọi khi manager.dispose() (extension deactivate / reload).
// =============================================================================
describe("SchemaTreeProvider — non-active connection socket leak regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.workspaceFolders = undefined;
  });

  it("expand NON-active connection N lần → factory chỉ tạo 1 adapter (cached)", async () => {
    const { mgr, factory } = setupTree({
      tables: [{ name: "users", schema: "public" }],
      factoryPerCall: true,
    });
    await mgr.addConnection(makeCfg({ id: "nonactive", name: "Side" }), "p");
    // Không setActive → connection này là non-active.

    const provider = new SchemaTreeProvider(mgr);
    const factoryCallsBefore = factory.mock.calls.length;
    // addConnection đã gọi factory 1 lần cho test-connect probe. Đếm delta
    // từ sau đó để loại probe noise ra khỏi assertion.
    const expansionCount = 5;
    for (let i = 0; i < expansionCount; i++) {
      provider.refresh();
      const r = await provider.getChildren(undefined);
      const c = r[0];
      const schemas2 = await provider.getChildren(c);
      const cats2 = await provider.getChildren(schemas2[0]);
      await provider.getChildren(cats2[0]);
    }
    // Expected: chỉ +1 factory call (cache hit cho mọi expansion sau lần đầu).
    // Trước fix: +expansionCount = 5 factory calls (mỗi expansion tạo adapter mới).
    const delta = factory.mock.calls.length - factoryCallsBefore;
    expect(delta).toBe(1);
  });

  it("manager.dispose() đóng tất cả passive adapters (không leak socket)", async () => {
    const { mgr, factory, adapters } = setupTree({
      tables: [{ name: "users", schema: "public" }],
      factoryPerCall: true,
    });
    await mgr.addConnection(makeCfg({ id: "a", name: "A" }), "p");
    await mgr.addConnection(makeCfg({ id: "b", name: "B" }), "p");

    // Trigger getAdapterFor cho cả 2 non-active connections.
    const cfgA = mgr.listConnections().find((c) => c.id === "a")!;
    const cfgB = mgr.listConnections().find((c) => c.id === "b")!;
    await mgr.getAdapterFor(cfgA);
    await mgr.getAdapterFor(cfgB);
    await mgr.getAdapterFor(cfgA); // cache hit — không tạo mới

    // Sau 2 addConnection + 3 getAdapterFor (2 unique passive + 1 cache hit):
    // 1 (initial) + 2 (probes) + 2 (passive) = 5 adapter instances.
    expect(adapters.length).toBe(5);
    // Chỉ kiểm tra các passive adapters (probe đã close trong addConnection finally).
    const passiveAdapters = adapters.slice(-2);
    expect(passiveAdapters).toHaveLength(2);
    for (const a of passiveAdapters) {
      expect(a.close).not.toHaveBeenCalled();
    }

    // Dispose manager.
    await mgr.dispose();

    // Passive adapters phải được close.
    for (const a of passiveAdapters) {
      expect(a.close).toHaveBeenCalled();
    }
    // Probes (adapters[1], adapters[2]) cũng đã close trong addConnection finally.
    expect(adapters[1].close).toHaveBeenCalled();
    expect(adapters[2].close).toHaveBeenCalled();
    // Sanity: factory được gọi 4 lần (2 probes + 2 passive). Initial adapter
    // trong adapters[0] KHÔNG đếm vì nó được tạo trước factory hook.
    expect(factory.mock.calls.length).toBe(4);
  });

  it("editConnection / deleteConnection drop cached passive adapter", async () => {
    const { mgr, factory, adapters } = setupTree({
      factoryPerCall: true,
    });
    await mgr.addConnection(makeCfg({ id: "a", name: "A" }), "p");
    const cfgA = mgr.listConnections().find((c) => c.id === "a")!;

    // Trigger getAdapterFor → +1 factory call (passive cached).
    await mgr.getAdapterFor(cfgA);
    const passiveAdapter = adapters[adapters.length - 1];
    expect(passiveAdapter.close).not.toHaveBeenCalled();

    // editConnection → drop cached passive adapter.
    await mgr.editConnection("a", { name: "A-renamed" });
    expect(passiveAdapter.close).toHaveBeenCalled();

    // Next getAdapterFor → tạo adapter MỚI.
    const cfgARenamed = mgr.listConnections().find((c) => c.id === "a")!;
    await mgr.getAdapterFor(cfgARenamed);
    expect(adapters.length).toBeGreaterThan(2);

    // deleteConnection → close passive mới.
    const newestAdapter = adapters[adapters.length - 1];
    await mgr.deleteConnection("a");
    expect(newestAdapter.close).toHaveBeenCalled();
  });
});

// =============================================================================
// Regression: Generate SELECT theo node connection (không phải active).
// Trước fix: commandGenerateSelect dùng active.driver → MySQL table dưới
// Postgres active sinh ra SELECT * FROM `users` LIMIT 100; (sai). Sau fix:
// dùng meta.connection.driver khi có.
// =============================================================================
describe("SchemaTreeProvider — connection node command + dialect per node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.workspaceFolders = undefined;
  });

  it("connection node có command 'vsdb.selectConnectionFromTree' với arguments=[id]", async () => {
    const stubMgr = {
      listConnections: () => [makeCfg({ id: "x", name: "X" })],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
    };
    const provider = new SchemaTreeProvider(stubMgr as never);
    const root = await provider.getChildren(undefined);
    expect(root).toHaveLength(1);
    expect(root[0].command?.command).toBe("vsdb.selectConnectionFromTree");
    expect(root[0].command?.arguments).toEqual(["x"]);
  });
});
// =============================================================================
// TASK-002 (wave 2) — table/view tree nodes wire `vsdb.browseTableData`
// (double-click/Enter). Routines + connection nodes keep `vsdb.copyQualifiedName` /
// `vsdb.selectConnectionFromTree`. The whole VsdbNode (with .meta) is the
// command argument so resolveBrowseNode in browseCommands.ts can read .meta.
// =============================================================================
describe("SchemaTreeProvider — TASK-002 browse gesture wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.workspaceFolders = undefined;
  });

  it("table node command = vsdb.browseTableData 'Browse Data' với arguments[0]=node (case 1)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [{ name: "users", schema: "app" }],
    });
    await mgr.addConnection(makeCfg({ id: "a", name: "Local" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);

    expect(tables).toHaveLength(1);
    const node = tables[0];
    expect(node.contextValue).toBe("table");
    expect(node.collapsible).toBe(1); // Collapsed
    expect(node.command?.command).toBe("vsdb.browseTableData");
    expect(node.command?.title).toBe("Browse Data");
    expect(Array.isArray(node.command?.arguments)).toBe(true);
    expect(node.command?.arguments?.[0]).toBe(node);
    if (
      node.command?.arguments?.[0] &&
      typeof node.command.arguments[0] === "object" &&
      "meta" in node.command.arguments[0]
    ) {
      const arg = node.command.arguments[0] as { meta?: unknown };
      const meta = arg.meta as
        | { connection?: { id?: string }; schema?: string; objectName?: string }
        | undefined;
      expect(meta?.connection?.id).toBe("a");
      expect(meta?.schema).toBe("app");
      expect(meta?.objectName).toBe("users");
    } else {
      throw new Error("expected arguments[0] to be an object with meta");
    }
  });

  it("view node command = vsdb.browseTableData 'Browse Data' với arguments[0]=node (case 2)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      views: [{ name: "v_active_users", schema: "app" }],
      routines: [{ name: "do_thing", kind: "procedure", schema: "app" }],
    });
    await mgr.addConnection(makeCfg({ id: "v", name: "V" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const viewsNode = cats[1]; // ["Tables","Views","Routines"] — Views at index 1
    const views = await provider.getChildren(viewsNode);
    const routinesNode = cats[2];
    const routines = await provider.getChildren(routinesNode);

    expect(views).toHaveLength(1);
    expect(routines).toHaveLength(1);

    const view = views[0];
    expect(view.contextValue).toBe("view");
    expect(view.command?.command).toBe("vsdb.browseTableData");
    expect(view.command?.title).toBe("Browse Data");
    expect(view.command?.arguments?.[0]).toBe(view);
    if (
      view.command?.arguments?.[0] &&
      typeof view.command.arguments[0] === "object" &&
      "meta" in view.command.arguments[0]
    ) {
      const viewArg = view.command.arguments[0] as { meta?: unknown };
      const meta = viewArg.meta as
        | { connection?: { id?: string }; schema?: string; objectName?: string }
        | undefined;
      expect(meta?.connection?.id).toBe("v");
      expect(meta?.schema).toBe("app");
      expect(meta?.objectName).toBe("v_active_users");
    } else {
      throw new Error("expected view arguments[0] to be an object with meta");
    }

    // Routines node giữ command copyQualifiedName cũ (không đổi).
    expect(routines[0].command?.command).toBe("vsdb.copyQualifiedName");
    expect(routines[0].command?.title).toBe("Copy qualified name");
  });

  it("connection node giữ command vsdb.selectConnectionFromTree với arguments=[id] (case 5)", async () => {
    const stubMgr = {
      listConnections: () => [makeCfg({ id: "conn-x", name: "X" })],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
    };
    const provider = new SchemaTreeProvider(stubMgr as never);
    const root = await provider.getChildren(undefined);
    expect(root[0].command?.command).toBe("vsdb.selectConnectionFromTree");
    expect(root[0].command?.arguments).toEqual(["conn-x"]);
  });
});

// =============================================================================
// DataGrip-style UX: connection root nodes xuất hiện sẵn (expanded), icon theo
// driver, active tint xanh qua ThemeColor. ViewsWelcome thay cho empty-add node.
// =============================================================================
describe("SchemaTreeProvider — DataGrip-style root behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.workspaceFolders = undefined;
  });

  it("connection node collapsible=Expanded (danh sách connected hiện sẵn)", async () => {
    const { mgr } = setupTree();
    await mgr.addConnection(makeCfg({ id: "a", name: "Local" }), "p");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    expect(root[0].collapsible).toBe(2); // TreeItemCollapsibleState.Expanded
  });

  it("connection node có icon theo driver (postgres=mysql=mssql khác nhau, no codicon prefix trong label)", async () => {
    const stubMgr = {
      listConnections: () => [
        makeCfg({ id: "p", name: "PG", driver: "postgres" }),
        makeCfg({ id: "m", name: "MY", driver: "mysql" }),
        makeCfg({ id: "s", name: "MS", driver: "mssql" }),
      ],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
    };
    const provider = new SchemaTreeProvider(stubMgr as never);
    const root = await provider.getChildren(undefined);

    expect(root.map((n) => n.icon)).toEqual(["database", "server", "azure"]);
    // Label sạch — không còn "$(pass-filled)" prefix codicon hack.
    expect(root.every((n) => !n.label.includes("$("))).toBe(true);
  });

  it("getTreeItem: active connection icon tint xanh, non-active icon thường", async () => {
    const { mgr } = setupTree();
    await mgr.addConnection(makeCfg({ id: "a", name: "A" }), "p");
    await mgr.addConnection(makeCfg({ id: "b", name: "B" }), "p");
    await mgr.setActive("a");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const itemA = provider.getTreeItem(root[0]) as { iconPath?: unknown };
    const itemB = provider.getTreeItem(root[1]) as { iconPath?: unknown };

    // Active: ThemeIcon(icon, ThemeColor) — 2 args.
    expect(vi.mocked(ThemeIcon).mock.calls.at(-2)?.[1]).toBeDefined();
    // Non-active: ThemeIcon(icon) — 1 arg, không color.
    expect(vi.mocked(ThemeIcon).mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(itemA.iconPath).toBeDefined();
    expect(itemB.iconPath).toBeDefined();
  });
});

// =============================================================================
// TASK-302 — row-count badges + filter engine.
// 10 cases từ task file.
// =============================================================================

describe("SchemaTreeProvider — TASK-302 row-count badges + filter engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.workspaceFolders = undefined;
  });

  it("formatRows(176) === '176' (happy)", () => {
    expect(formatRows(176)).toBe("176");
  });

  it("formatRows(1234567) === '1.2M' locale pinned 'en' (happy)", () => {
    expect(formatRows(1234567)).toBe("1.2M");
  });

  it("getCategoryChildren tables → sau microtask table node description = '176', label giữ nguyên (happy)", async () => {
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "app" }],
      tables: [
        { name: "users", schema: "app" },
        { name: "orders", schema: "app" },
      ],
      estimateTableRowsImpl: async (schema, table) => {
        if (table === "users") return 176;
        if (table === "orders") return 42;
        return null;
      },
    });
    await mgr.addConnection(makeCfg({ id: "rc1", name: "RC1" }), "p");
    await mgr.setActive("rc1");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats[0];
    const tables = await provider.getChildren(tablesNode);

    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.label)).toEqual(["users", "orders"]);
    // Wait for async fetch + onDidChangeTreeData.
    const waitImmediate = () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise;
    };
    await waitImmediate();
    await waitImmediate();

    const users = tables.find((t) => t.label === "users")!;
    expect(users.label).toBe("users"); // label không đổi
    expect(users.description).toBe("176");
    // estimateTableRows được gọi với đúng (schema, table).
    expect(adapter.estimateTableRows).toHaveBeenCalled();
  });

  it("setFilter('po_log') tables gồm api_po_log + users → chỉ api_po_log được trả về (happy, ancestors expanded)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [
        { name: "api_po_log", schema: "app" },
        { name: "users", schema: "app" },
      ],
    });
    await mgr.addConnection(makeCfg({ id: "f1", name: "F1" }), "p");
    await mgr.setActive("f1");
    const provider = new SchemaTreeProvider(mgr);

    provider.setFilter("po_log");
    expect(provider.getFilter()).toBe("po_log");

    const root = await provider.getChildren(undefined);
    // Root: connections LUÔN giữ khi filter active.
    expect(root).toHaveLength(1);
    expect(root[0].contextValue).toBe("connection");

    const schemas = await provider.getChildren(root[0]);
    // Schemas luôn giữ (children cần query mới biết match).
    expect(schemas).toHaveLength(1);
    expect(schemas[0].contextValue).toBe("schema");
    expect(schemas[0].collapsible).toBe(2); // Expanded

    const cats = await provider.getChildren(schemas[0]);
    // Categories: luôn hiển thị, expanded.
    const tablesNode = cats.find((c) => c.label === "Tables")!;
    expect(tablesNode.collapsible).toBe(2); // Expanded

    const tables = await provider.getChildren(tablesNode);
    expect(tables.map((t) => t.label)).toEqual(["api_po_log"]);
  });

  it("estimateTableRows resolves null → description giữ schema fallback 'qas' (edge)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "qas" }],
      tables: [{ name: "api_log", schema: "qas" }],
      estimateTableRowsImpl: async () => null,
    });
    await mgr.addConnection(makeCfg({ id: "nullr", name: "NullR" }), "p");
    await mgr.setActive("nullr");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);

    expect(tables).toHaveLength(1);
    const apiLog = tables[0];
    expect(apiLog.label).toBe("api_log");
    expect(apiLog.description).toBe("qas"); // fallback

    // Wait for async fetch + onDidChangeTreeData.
    const waitImmediate = () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise;
    };
    await waitImmediate();
    await waitImmediate();

    // Description KHÔNG đổi → vẫn 'qas'.
    expect(apiLog.description).toBe("qas");
  });

  it("filter 'ZZZ' → 'No matches for \"ZZZ\"' node (edge)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [{ name: "users", schema: "app" }],
    });
    await mgr.addConnection(makeCfg({ id: "n1", name: "N1" }), "p");
    await mgr.setActive("n1");
    const provider = new SchemaTreeProvider(mgr);

    provider.setFilter("ZZZ");
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats.find((c) => c.label === "Tables")!;
    const tables = await provider.getChildren(tablesNode);

    expect(tables).toHaveLength(1);
    expect(tables[0].label).toBe("No matches for 'ZZZ'");
    expect(tables[0].contextValue).toBe("empty-add");
    expect(tables[0].collapsible).toBe(0); // None
  });

  it("setFilter('') xóa filter → full list trả về (edge)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [
        { name: "api_po_log", schema: "app" },
        { name: "users", schema: "app" },
      ],
    });
    await mgr.addConnection(makeCfg({ id: "cl1", name: "CL1" }), "p");
    await mgr.setActive("cl1");
    const provider = new SchemaTreeProvider(mgr);

    const fetchTables = async () => {
      const root = await provider.getChildren(undefined);
      const schemas = await provider.getChildren(root[0]);
      const cats = await provider.getChildren(schemas[0]);
      const tablesNode = cats.find((c) => c.label === "Tables")!;
      return provider.getChildren(tablesNode);
    };

    provider.setFilter("po_log");
    let tables = await fetchTables();
    expect(tables.map((t) => t.label)).toEqual(["api_po_log"]);

    provider.setFilter("");
    expect(provider.getFilter()).toBe("");
    tables = await fetchTables();
    expect(tables.map((t) => t.label)).toEqual(["api_po_log", "users"]);
  });

  it("filter 'PO_LOG' uppercase match api_po_log (edge, case-insensitive)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [{ name: "api_po_log", schema: "app" }],
    });
    await mgr.addConnection(makeCfg({ id: "ci1", name: "CI1" }), "p");
    await mgr.setActive("ci1");
    const provider = new SchemaTreeProvider(mgr);

    provider.setFilter("PO_LOG");
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats.find((c) => c.label === "Tables")!;
    const tables = await provider.getChildren(tablesNode);

    expect(tables.map((t) => t.label)).toEqual(["api_po_log"]);
  });

  it("root connections luôn giữ khi filter active (không bị drop theo tên) (edge)", async () => {
    const stubMgr = {
      listConnections: () => [
        makeCfg({ id: "x", name: "X" }),
        makeCfg({ id: "y", name: "Y" }),
      ],
      getActive: () => null,
      onDidChangeActive: () => ({ dispose: () => {} }),
    };
    const provider = new SchemaTreeProvider(stubMgr as never);

    provider.setFilter("zzzzz_no_match");
    const root = await provider.getChildren(undefined);
    expect(root).toHaveLength(2); // Cả 2 connections giữ, không bị filter.
    expect(root.map((n) => n.contextValue)).toEqual(["connection", "connection"]);
  });

  it("category badge vẫn = tổng objects unfiltered khi filter active lọc bớt output (regression)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }],
      tables: [
        { name: "api_po_log", schema: "app" },
        { name: "users", schema: "app" },
        { name: "orders", schema: "app" },
      ],
    });
    await mgr.addConnection(makeCfg({ id: "bg1", name: "BG1" }), "p");
    await mgr.setActive("bg1");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats.find((c) => c.label === "Tables")!;

    // First fetch: badge = '3' từ list unfiltered.
    await provider.getChildren(tablesNode);
    expect(tablesNode.description).toBe("3");

    // Apply filter → chỉ api_po_log match.
    provider.setFilter("po_log");
    const filtered = await provider.getChildren(tablesNode);
    expect(filtered.map((t) => t.label)).toEqual(["api_po_log"]);
    // Badge KHÔNG đổi — vẫn tổng unfiltered.
    expect(tablesNode.description).toBe("3");
  });

  it("cached schema nodes become Expanded after setFilter (regression)", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "app" }] });
    await mgr.addConnection(makeCfg({ id: "cache1", name: "Cache" }), "p");
    await mgr.setActive("cache1");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const firstSchemas = await provider.getChildren(root[0]);
    expect(firstSchemas[0].collapsible).toBe(1); // cached canonical: Collapsed

    provider.setFilter("po_log");
    const filteredSchemas = await provider.getChildren(root[0]);
    expect(filteredSchemas[0].collapsible).toBe(2); // transient filter view: Expanded
  });
});

// =============================================================================
// TASK-005 — findTableNode + revealTableNode. findTableNode locates a VsdbNode
// (contextValue === "table", meta.objectName) by (conn, schema, table); returns
// null nếu absent. revealTableNode wraps treeView.reveal(node, {select:true,
// expand:false}) và nuốt throw (node có thể đã bị dispose / tree đang refresh).
// =============================================================================
describe("SchemaTreeProvider — TASK-005 findTableNode + revealTableNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
  });

  it("findTableNode trả table node từ fake adapter listing (contextValue 'table', meta.objectName)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
    });
    await mgr.addConnection(makeCfg({ id: "c1", name: "Local" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);

    const cfg = mgr.listConnections()[0];
    const found = await provider.findTableNode(cfg, "public", "users");
    expect(found).not.toBeNull();
    if (!found) throw new Error("expected table node");
    expect(found.contextValue).toBe("table");
    expect(found.meta?.objectName).toBe("users");
    expect(found.meta?.schema).toBe("public");
  });

  it("findTableNode trả null khi table absent (chưa được list)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [],
    });
    await mgr.addConnection(makeCfg({ id: "c1", name: "Local" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);

    const cfg = mgr.listConnections()[0];
    const found = await provider.findTableNode(cfg, "public", "missing");
    expect(found).toBeNull();
  });

  it("revealTableNode gọi treeView.reveal({select:true, expand:false})", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
    });
    await mgr.addConnection(makeCfg({ id: "c1", name: "Local" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);
    registerSchemaTreeProvider(provider);

    const cfg = mgr.listConnections()[0];
    const treeView = {
      reveal: vi.fn(),
      dispose: vi.fn(),
    };
    await revealTableNode(
      treeView as unknown as TreeView<unknown>,
      cfg,
      "public",
      "users",
    );
    expect(treeView.reveal).toHaveBeenCalledTimes(1);
    const [revealedNode, opts] = treeView.reveal.mock.calls[0];
    expect(revealedNode).toBeDefined();
    let contextValue: string | undefined;
    if (
      revealedNode !== undefined &&
      revealedNode !== null &&
      typeof revealedNode === "object" &&
      "contextValue" in revealedNode
    ) {
      const cv = (revealedNode as { contextValue: unknown }).contextValue;
      if (typeof cv === "string") contextValue = cv;
    }
    expect(contextValue).toBe("table");
    expect(opts).toEqual({ select: true, expand: false });
  });

  it("revealTableNode nuốt throw (tree đã dispose)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
    });
    await mgr.addConnection(makeCfg({ id: "c1", name: "Local" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);
    registerSchemaTreeProvider(provider);

    const cfg = mgr.listConnections()[0];
    const treeView = {
      reveal: vi.fn(() => {
        throw new Error("disposed");
      }),
      dispose: vi.fn(),
    };
    await expect(
      revealTableNode(
        treeView as unknown as TreeView<unknown>,
        cfg,
        "public",
        "users",
      ),
    ).resolves.toBeUndefined();
  });

  it("revealTableNode với table absent → KHÔNG gọi reveal", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [],
    });
    await mgr.addConnection(makeCfg({ id: "c1", name: "Local" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);
    registerSchemaTreeProvider(provider);

    const cfg = mgr.listConnections()[0];
    const treeView = {
      reveal: vi.fn(),
      dispose: vi.fn(),
    };
    await revealTableNode(
      treeView as unknown as TreeView<unknown>,
      cfg,
      "public",
      "missing",
    );
    expect(treeView.reveal).not.toHaveBeenCalled();
  });
});

// =============================================================================
// R1 regression: TreeView.reveal() throws "Tree item not found" khi
// SchemaTreeProvider chưa implement getParent() (vscode.d.ts: "This method
// should be implemented in order to access TreeView.reveal API"). Trước fix:
// reveal được nuốt bởi try/catch → command thành công nhưng UI không reveal.
// Sau fix: getParent trả về ancestor phù hợp (connection→null, schema→conn,
// category→schema, table→category, column→table) → reveal hoạt động.
// =============================================================================
describe("SchemaTreeProvider — R1 regression: getParent cho TreeView.reveal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
  });

  it("connection node → getParent() = null (root)", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "public" }] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    const provider = new SchemaTreeProvider(mgr);
    const root = await provider.getChildren(undefined);
    expect(provider.getParent(root[0])).toBeNull();
  });

  it("schema node → getParent() = connection", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "public" }] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    const provider = new SchemaTreeProvider(mgr);
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const parent = provider.getParent(schemas[0]);
    expect(parent).not.toBeNull();
    expect(parent?.contextValue).toBe("connection");
  });

  it("category node → getParent() = schema", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "public" }] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    const provider = new SchemaTreeProvider(mgr);
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const parent = provider.getParent(cats[0]);
    expect(parent?.contextValue).toBe("schema");
  });

  it("table node → getParent() = category (Tables)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
    });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    const provider = new SchemaTreeProvider(mgr);
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);
    const parent = provider.getParent(tables[0]);
    expect(parent?.contextValue).toBe("category");
    expect(parent?.label).toBe("Tables");
  });

  it("column node → getParent() = table", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      columns: [{ name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true }],
    });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    const provider = new SchemaTreeProvider(mgr);
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);
    const cols = await provider.getChildren(tables[0]);
    const parent = provider.getParent(cols[0]);
    expect(parent?.contextValue).toBe("table");
  });
});

// =============================================================================
// TASK-003 — findSchemaNode + revealSchemaNode. findSchemaNode locates a
// VsdbNode (contextValue === "schema", meta.connection + meta.schema) by
// (conn, schema); returns null when absent or adapter throw. revealSchemaNode
// wraps treeView.reveal(node, {select:true, expand:false}) and swallows throw.
// =============================================================================
describe("SchemaTreeProvider — TASK-003 findSchemaNode + revealSchemaNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
  });

  it("findSchemaNode returns schema node from fake adapter (contextValue 'schema', meta.schema)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "app" }, { name: "public" }],
    });
    await mgr.addConnection(makeCfg({ id: "c1", name: "Local" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);

    const cfg = mgr.listConnections()[0];
    const found = await provider.findSchemaNode(cfg, "app");
    expect(found).not.toBeNull();
    if (!found) throw new Error("expected schema node");
    expect(found.contextValue).toBe("schema");
    expect(found.label).toBe("app");
    expect(found.meta?.schema).toBe("app");
    expect(found.meta?.connection?.id).toBe(cfg.id);
  });

  it("findSchemaNode returns null when schema absent", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "public" }] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);

    const cfg = mgr.listConnections()[0];
    const found = await provider.findSchemaNode(cfg, "missing");
    expect(found).toBeNull();
  });

  it("findSchemaNode returns null when adapter throws", async () => {
    const { mgr } = setupTree({ throw: true });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);

    const cfg = mgr.listConnections()[0];
    const found = await provider.findSchemaNode(cfg, "public");
    expect(found).toBeNull();
  });

  it("revealSchemaNode calls treeView.reveal({select:true, expand:false})", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "public" }] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);
    registerSchemaTreeProvider(provider);

    const cfg = mgr.listConnections()[0];
    const treeView = { reveal: vi.fn(), dispose: vi.fn() };
    await revealSchemaNode(
      treeView as unknown as TreeView<unknown>,
      cfg,
      "public",
    );
    expect(treeView.reveal).toHaveBeenCalledTimes(1);
    const [revealedNode, opts] = treeView.reveal.mock.calls[0];
    let contextValue: string | undefined;
    if (
      revealedNode !== undefined &&
      revealedNode !== null &&
      typeof revealedNode === "object" &&
      "contextValue" in revealedNode
    ) {
      const cv = (revealedNode as { contextValue: unknown }).contextValue;
      if (typeof cv === "string") contextValue = cv;
    }
    expect(contextValue).toBe("schema");
    expect(opts).toEqual({ select: true, expand: false });
  });

  it("revealSchemaNode swallows throw (tree disposed)", async () => {
    const { mgr } = setupTree({ schemas: [{ name: "public" }] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);
    registerSchemaTreeProvider(provider);

    const cfg = mgr.listConnections()[0];
    const treeView = {
      reveal: vi.fn(() => {
        throw new Error("disposed");
      }),
      dispose: vi.fn(),
    };
    await expect(
      revealSchemaNode(
        treeView as unknown as TreeView<unknown>,
        cfg,
        "public",
      ),
    ).resolves.toBeUndefined();
  });

  it("revealSchemaNode with schema absent → does NOT call reveal", async () => {
    const { mgr } = setupTree({ schemas: [] });
    await mgr.addConnection(makeCfg({ id: "c1" }), "p");
    await mgr.setActive("c1");
    const provider = new SchemaTreeProvider(mgr);
    registerSchemaTreeProvider(provider);

    const cfg = mgr.listConnections()[0];
    const treeView = { reveal: vi.fn(), dispose: vi.fn() };
    await revealSchemaNode(
      treeView as unknown as TreeView<unknown>,
      cfg,
      "missing",
    );
    expect(treeView.reveal).not.toHaveBeenCalled();
  });
});
