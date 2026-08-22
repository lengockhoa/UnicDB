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
