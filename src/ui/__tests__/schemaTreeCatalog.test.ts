// src/ui/__tests__/schemaTreeCatalog.test.ts
// TASK-AF-002 — Schema tree catalog nodes + real DDL viewer.
// Tests 1-6, 10 from TASK-AF-002 §Test Cases.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import type {
  DbAdapter,
  ColumnInfo,
  IndexInfo,
  TableConstraintInfo,
  TriggerInfo,
  SequenceInfo,
  CatalogApi,
} from "../../adapters/types";

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

const state = {
  emitters: [] as FakeEventEmitter<unknown>[],
  treeItemCalls: [] as Array<{ label: string; collapsible: unknown }>,
  hideSystemSchemas: true,
  errorMessages: [] as string[],
};

vi.mock("vscode", () => {
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
        showInformationMessage: vi.fn().mockResolvedValue(undefined),
        showErrorMessage: vi.fn((msg: string) => {
          state.errorMessages.push(msg);
          return Promise.resolve(undefined);
        }),
        showInputBox: vi.fn().mockResolvedValue(undefined),
        showQuickPick: vi.fn().mockResolvedValue(undefined),
      };
    },
    get workspace() {
      return {
        getConfiguration: () => ({
          get: (key: string, fallback?: unknown) => {
            if (key === "hideSystemSchemas") return state.hideSystemSchemas;
            return fallback;
          },
        }),
      };
    },
  };
});

import {
  SchemaTreeProvider,
  formatRows,
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

interface FakeCatalogOpts {
  indexes?: IndexInfo[];
  constraints?: TableConstraintInfo[];
  triggers?: TriggerInfo[];
  sequences?: SequenceInfo[];
  rowCount?: number;
  rowCountReject?: boolean;
}

/** Full DBX-08 capability matrix literal — matches AdapterCapabilities. */
interface FakeCapabilities {
  catalog: boolean;
  objectDdl: boolean;
  tableDdl: boolean;
  admin: boolean;
}

function makeFakeAdapter(opts: {
  schemas?: Array<{ name: string }>;
  tables?: Array<{ name: string; schema: string }>;
  views?: Array<{ name: string; schema: string }>;
  routines?: Array<{ name: string; kind: "function" | "procedure"; schema: string }>;
  columns?: ColumnInfo[];
  catalog?: FakeCatalogOpts;
  /** DBX-08 — explicit capability declaration; undefined = legacy adapter. */
  capabilities?: FakeCapabilities;
  estimateTableRowsBatchImpl?: (
    schema: string,
    tables: readonly string[],
  ) => Promise<Map<string, number | null>>;
  throw?: boolean;
}) {
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

  const adapter: DbAdapter & { catalog?: CatalogApi } = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    runQuery: vi.fn(),
    listSchemas,
    listTables,
    listViews,
    listRoutines,
    listColumns,
    estimateTableRows: vi.fn().mockResolvedValue(null),
    estimateTableRowsBatch: vi.fn().mockImplementation(
      (schema: string, tables: readonly string[]) =>
        opts.estimateTableRowsBatchImpl
          ? opts.estimateTableRowsBatchImpl(schema, tables)
          : Promise.resolve(new Map<string, number | null>()),
    ),
    testConnection: vi.fn().mockResolvedValue(undefined),
  };
  if (opts.catalog) {
    const c = opts.catalog;
    adapter.catalog = {
      listIndexes: vi.fn().mockResolvedValue(c.indexes ?? []),
      listConstraints: vi.fn().mockResolvedValue(c.constraints ?? []),
      listTriggers: vi.fn().mockResolvedValue(c.triggers ?? []),
      listSequences: vi.fn().mockResolvedValue(c.sequences ?? []),
      rowCount: vi.fn().mockImplementation(() => {
        if (c.rowCountReject) {
          return Promise.reject(new Error("rowCount failed"));
        }
        return Promise.resolve(c.rowCount ?? 0);
      }),
      objectDdl: vi.fn().mockResolvedValue("CREATE VIEW ..."),
    };
  }
  if (opts.capabilities) {
    adapter.capabilities = opts.capabilities;
  }
  return adapter;
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
  get<T>(): T | undefined {
    return undefined;
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
}

function setupTree(opts: {
  schemas?: Array<{ name: string }>;
  tables?: Array<{ name: string; schema: string }>;
  views?: Array<{ name: string; schema: string }>;
  routines?: Array<{ name: string; kind: "function" | "procedure"; schema: string }>;
  columns?: ColumnInfo[];
  catalog?: FakeCatalogOpts;
  capabilities?: FakeCapabilities;
  estimateTableRowsBatchImpl?: (
    schema: string,
    tables: readonly string[],
  ) => Promise<Map<string, number | null>>;
  throw?: boolean;
}) {
  state.emitters = [];
  state.treeItemCalls = [];
  state.errorMessages = [];
  state.hideSystemSchemas = true;
  const adapter = makeFakeAdapter(opts);
  const factory = vi.fn(() => adapter as unknown as DbAdapter);
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
  return { mgr, adapter, factory };
}

const waitMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
};

// =============================================================================
// Tests
// =============================================================================

describe("SchemaTreeProvider — TASK-AF-002 catalog nodes + row count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.errorMessages = [];
  });

  // ---------------------------------------------------------------------------
  // Test 1: table node gets indexes/constraints/triggers children when catalog
  // present; expanding indexes yields IndexInfo names.
  // ---------------------------------------------------------------------------
  it("Test #1 — table node lists indexes/constraints/triggers children via catalog", async () => {
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      columns: [],
      catalog: {
        indexes: [
          { name: "idx_a", schema: "public", table: "users", isUnique: false, method: "btree", columns: ["a"] },
          { name: "idx_b", schema: "public", table: "users", isUnique: true, method: "btree", columns: ["b"] },
        ],
        constraints: [
          { name: "users_pkey", type: "pk", columns: ["id"] },
        ],
        triggers: [
          { name: "trg_u", event: "INSERT", timing: "BEFORE", statement: "RAISE EXCEPTION" },
        ],
      },
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
    });
    await mgr.addConnection(makeCfg({ id: "af2t1" }), "p");
    await mgr.setActive("af2t1");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats[0];
    const tables = await provider.getChildren(tablesNode);

    // Expand table node → category nodes (not just columns).
    const tableChildren = await provider.getChildren(tables[0]);
    const labels = tableChildren.map((c) => c.label);
    expect(labels).toContain("Indexes");
    expect(labels).toContain("Constraints");
    expect(labels).toContain("Triggers");

    const indexesCat = tableChildren.find((c) => c.label === "Indexes")!;
    const indexes = await provider.getChildren(indexesCat);
    expect(indexes.map((n) => n.label)).toEqual(["idx_a", "idx_b"]);

    expect(adapter.catalog?.listIndexes).toHaveBeenCalledWith("public", "users");
    expect(adapter.catalog?.listConstraints).toHaveBeenCalledWith("public", "users");
    expect(adapter.catalog?.listTriggers).toHaveBeenCalledWith("public", "users");
  });

  // ---------------------------------------------------------------------------
  // Test 2: table node description shows row count (formatRows).
  // ---------------------------------------------------------------------------
  it("Test #2 — table node description shows row count from catalog.rowCount", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      catalog: { rowCount: 1234 },
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
    });
    await mgr.addConnection(makeCfg({ id: "af2t2" }), "p");
    await mgr.setActive("af2t2");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);
    const users = tables[0];
    expect(users.label).toBe("users");
    expect(users.description).toBe("public"); // initial

    await waitMicrotasks();
    expect(users.description).toBe(formatRows(1234));
  });

  // ---------------------------------------------------------------------------
  // Test 3: catalog undefined → new categories absent, no throw.
  // ---------------------------------------------------------------------------
  it("Test #3 — adapter without catalog renders table children with no catalog categories", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      columns: [
        { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
      ],
    });
    await mgr.addConnection(makeCfg({ id: "af2t3" }), "p");
    await mgr.setActive("af2t3");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);

    const tableChildren = await provider.getChildren(tables[0]);
    const labels = tableChildren.map((c) => c.label);
    // Only columns (id) should be present; no Indexes/Constraints/Triggers.
    expect(labels).toEqual(["id"]);
  });

  // ---------------------------------------------------------------------------
  // Test 4: rowCount rejects → count omitted, tree still renders.
  // ---------------------------------------------------------------------------
  it("Test #4 — catalog.rowCount rejects → description stays as schema fallback, error logged", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      catalog: { rowCountReject: true },
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
    });
    await mgr.addConnection(makeCfg({ id: "af2t4" }), "p");
    await mgr.setActive("af2t4");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const tables = await provider.getChildren(cats[0]);

    await waitMicrotasks();
    await waitMicrotasks();

    // Description retains schema fallback ('public'), no number appended.
    expect(tables[0].description).toBe("public");
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Test 5: empty schema → sequences category absent (no empty category nodes).
  // ---------------------------------------------------------------------------
  it("Test #5 — empty listSequences → Sequences category not present", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      catalog: {
        // explicit: no sequences, no indexes/constraints/triggers either
      },
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
    });
    await mgr.addConnection(makeCfg({ id: "af2t5" }), "p");
    await mgr.setActive("af2t5");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    const labels = cats.map((c) => c.label);
    // Tables/Views/Routines standard. Sequences absent (empty).
    expect(labels).not.toContain("Sequences");
    expect(labels).toContain("Tables");
    expect(labels).toContain("Views");
    expect(labels).toContain("Routines");

    // Sequences present when there are sequences.
    const { mgr: mgr2, adapter: adapter2 } = setupTree({
      schemas: [{ name: "public" }],
      tables: [],
      catalog: {
        sequences: [
          { name: "seq_users", schema: "public", dataType: "bigint", lastValue: "1" },
        ],
      },
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
    });
    void adapter2;
    await mgr2.addConnection(makeCfg({ id: "af2t5b" }), "p");
    await mgr2.setActive("af2t5b");
    const provider2 = new SchemaTreeProvider(mgr2);
    const root2 = await provider2.getChildren(undefined);
    const schemas2 = await provider2.getChildren(root2[0]);
    const cats2 = await provider2.getChildren(schemas2[0]);
    const labels2 = cats2.map((c) => c.label);
    expect(labels2).toContain("Sequences");

    // Expand Sequences → seq_users child
    const seqCat = cats2.find((c) => c.label === "Sequences")!;
    const seqs = await provider2.getChildren(seqCat);
    expect(seqs.map((s) => s.label)).toEqual(["seq_users"]);
  });

  // ---------------------------------------------------------------------------
  // Test 6: filter matches new node kinds.
  // ---------------------------------------------------------------------------
  it("Test #6 — filter applies at the catalog leaf level (indexes/constraints)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      columns: [],
      catalog: {
        indexes: [
          { name: "idx_a", schema: "public", table: "users", isUnique: false, method: "btree", columns: ["a"] },
          { name: "idx_b", schema: "public", table: "users", isUnique: false, method: "btree", columns: ["b"] },
        ],
        constraints: [
          { name: "cns_x", type: "check", columns: ["a"] },
          { name: "cns_y", type: "check", columns: ["b"] },
        ],
        triggers: [],
      },
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
    });
    await mgr.addConnection(makeCfg({ id: "af2t6" }), "p");
    await mgr.setActive("af2t6");
    const provider = new SchemaTreeProvider(mgr);

    // Filter active → schemas + categories stay expanded (existing semantics).
    provider.setFilter("idx");
    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    expect(schemas[0].collapsible).toBe(2);
    const cats = await provider.getChildren(schemas[0]);
    const tablesNode = cats.find((c) => c.label === "Tables")!;
    expect(tablesNode.collapsible).toBe(2);

    // Tables list: shallow filter — "users" doesn't contain "idx", so empty match.
    const tables = await provider.getChildren(tablesNode);
    expect(tables).toHaveLength(1);
    expect(tables[0].contextValue).toBe("empty-add");
    expect(tables[0].label).toMatch(/No matches/);

    // Now switch to a filter that matches the table NAME itself so we can
    // exercise the leaf filter through the full expand chain.
    provider.setFilter("users");
    const tables2 = await provider.getChildren(tablesNode);
    expect(tables2.map((t) => t.label)).toEqual(["users"]);

    const tableChildren = await provider.getChildren(tables2[0]);
    // Indexes + Constraints present (triggers empty → omit).
    const indexesCat = tableChildren.find((c) => c.label === "Indexes")!;
    const constraintsCat = tableChildren.find((c) => c.label === "Constraints")!;
    expect(indexesCat).toBeTruthy();
    expect(constraintsCat).toBeTruthy();

    // Filter 'users' doesn't match any index/constraint name → empty match.
    const idxChildren = await provider.getChildren(indexesCat);
    expect(idxChildren).toHaveLength(1);
    expect(idxChildren[0].contextValue).toBe("empty-add");

    // Now filter for an index NAME: 'idx_a' goes through the schema/table
    // (table doesn't match → no tables), but direct leaf access still filters
    // correctly when the table IS reached. Verify leaf-level filter behavior
    // by clearing filter first, getting the indexes, then re-filtering.
    provider.setFilter("");
    const idxAll = await provider.getChildren(indexesCat);
    expect(idxAll.map((n) => n.label).sort()).toEqual(["idx_a", "idx_b"]);

    provider.setFilter("idx_a");
    const idxFiltered = await provider.getChildren(indexesCat);
    expect(idxFiltered.map((n) => n.label)).toEqual(["idx_a"]);
  });

  // ---------------------------------------------------------------------------
  // Test 10 (regression): existing schemaTree suite semantics untouched.
  // ---------------------------------------------------------------------------
  it("Test #10 — regression: existing tree behavior preserved (mysql-style, no catalog)", async () => {
    const { mgr } = setupTree({
      schemas: [{ name: "public" }],
      tables: [
        { name: "users", schema: "public" },
        { name: "orders", schema: "public" },
      ],
      views: [{ name: "v_active", schema: "public" }],
      routines: [{ name: "do_thing", kind: "function", schema: "public" }],
      columns: [
        // Empty for non-catalog path
      ],
      estimateTableRowsBatchImpl: async (_schema, tables) => {
        const m = new Map<string, number | null>();
        for (const t of tables) {
          m.set(t, 100);
        }
        return m;
      },
    });
    await mgr.addConnection(
      makeCfg({ id: "af2t10", driver: "mysql" }),
      "p",
    );
    await mgr.setActive("af2t10");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    expect(cats.map((c) => c.label)).toEqual(["Tables", "Views", "Routines"]);
    // No Sequences (catalog absent).
    expect(cats.map((c) => c.label)).not.toContain("Sequences");

    const tables = await provider.getChildren(cats[0]);
    expect(tables.map((t) => t.label)).toEqual(["users", "orders"]);

    // Expanding a table → only column children (none here).
    const cols = await provider.getChildren(tables[0]);
    expect(cols.map((c) => c.label)).toEqual([]);
  });
});

// =============================================================================
// TASK-DBX08-002 — catalog tree admission by declared capability.
// =============================================================================

const PG_CAPS = { catalog: true, objectDdl: true, tableDdl: true, admin: true };
const NO_CAPS = { catalog: false, objectDdl: false, tableDdl: false, admin: false };

describe("SchemaTreeProvider — TASK-DBX08-002 declared catalog capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.emitters = [];
    state.treeItemCalls = [];
    state.errorMessages = [];
  });

  it("declared PostgreSQL catalog support preserves tree rows", async () => {
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      columns: [{ name: "id", dataType: "int", nullable: false, isPrimaryKey: true }],
      catalog: {
        indexes: [
          { name: "idx_a", schema: "public", table: "users", isUnique: false, method: "btree", columns: ["a"] },
        ],
        constraints: [
          { name: "users_pkey", type: "pk", columns: ["id"] },
        ],
        triggers: [
          { name: "trg_u", event: "INSERT", timing: "BEFORE", statement: "RAISE" },
        ],
        sequences: [
          { name: "users_id_seq", schema: "public", dataType: "integer", lastValue: "7" },
        ],
      },
      capabilities: PG_CAPS,
    });
    await mgr.addConnection(makeCfg({ id: "dbx08t1" }), "p");
    await mgr.setActive("dbx08t1");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    // Declared catalog → Sequences category appears alongside the generic 3.
    expect(cats.map((c) => c.label)).toContain("Sequences");

    const tables = await provider.getChildren(cats[0]);
    const tableChildren = await provider.getChildren(tables[0]);
    const labels = tableChildren.map((c) => c.label);
    expect(labels).toContain("Indexes");
    expect(labels).toContain("Constraints");
    expect(labels).toContain("Triggers");
    expect(labels).toContain("id");

    const indexesCat = tableChildren.find((c) => c.label === "Indexes")!;
    const indexes = await provider.getChildren(indexesCat);
    expect(indexes.map((n) => n.label)).toEqual(["idx_a"]);

    expect(adapter.catalog?.listIndexes).toHaveBeenCalledWith("public", "users");
    expect(adapter.catalog?.listConstraints).toHaveBeenCalledWith("public", "users");
    expect(adapter.catalog?.listTriggers).toHaveBeenCalledWith("public", "users");
    expect(adapter.catalog?.listSequences).toHaveBeenCalledWith("public");
  });

  it("catalog consumers fail closed without catalog calls (false/missing declaration)", async () => {
    // (a) Catalog structurally present but DECLARED false — mysql-shaped.
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      columns: [{ name: "id", dataType: "int", nullable: false }],
      catalog: {},
      capabilities: NO_CAPS,
    });
    await mgr.addConnection(
      makeCfg({ id: "dbx08t2a", driver: "mysql" }),
      "p",
    );
    await mgr.setActive("dbx08t2a");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    expect(cats.map((c) => c.label)).toEqual(["Tables", "Views", "Routines"]);

    const tables = await provider.getChildren(cats[0]);
    const tableChildren = await provider.getChildren(tables[0]);
    expect(tableChildren.map((c) => c.label)).toEqual(["id"]);

    expect(adapter.catalog?.listIndexes).not.toHaveBeenCalled();
    expect(adapter.catalog?.listConstraints).not.toHaveBeenCalled();
    expect(adapter.catalog?.listTriggers).not.toHaveBeenCalled();
    expect(adapter.catalog?.listSequences).not.toHaveBeenCalled();
    expect(adapter.catalog?.rowCount).not.toHaveBeenCalled();

    // (b) Catalog structurally present with NO declaration at all.
    const legacy = setupTree({
      schemas: [{ name: "public" }],
      tables: [{ name: "users", schema: "public" }],
      catalog: {},
    });
    await legacy.mgr.addConnection(makeCfg({ id: "dbx08t2b" }), "p");
    await legacy.mgr.setActive("dbx08t2b");
    const providerB = new SchemaTreeProvider(legacy.mgr);

    const rootB = await providerB.getChildren(undefined);
    const schemasB = await providerB.getChildren(rootB[0]);
    const catsB = await providerB.getChildren(schemasB[0]);
    expect(catsB.map((c) => c.label)).toEqual(["Tables", "Views", "Routines"]);

    const tablesB = await providerB.getChildren(catsB[0]);
    const childrenB = await providerB.getChildren(tablesB[0]);
    expect(childrenB.map((c) => c.label)).toEqual([]);
    expect(legacy.adapter.catalog?.listIndexes).not.toHaveBeenCalled();
    expect(legacy.adapter.catalog?.listSequences).not.toHaveBeenCalled();
  });

  it("generic navigation and estimate batching remain available without catalog", async () => {
    const estimateTableRowsBatchImpl = vi.fn(
      async (schema: string, tables: readonly string[]) => {
        const m = new Map<string, number | null>();
        for (const t of tables) m.set(t, 250);
        void schema;
        return m;
      },
    );
    const { mgr, adapter } = setupTree({
      schemas: [{ name: "public" }],
      tables: [
        { name: "users", schema: "public" },
        { name: "orders", schema: "public" },
      ],
      views: [{ name: "v_active", schema: "public" }],
      routines: [{ name: "do_thing", kind: "procedure", schema: "public" }],
      columns: [{ name: "id", dataType: "int", nullable: false }],
      capabilities: NO_CAPS,
      estimateTableRowsBatchImpl: estimateTableRowsBatchImpl as unknown as (
        schema: string,
        tables: readonly string[],
      ) => Promise<Map<string, number | null>>,
    });
    await mgr.addConnection(
      makeCfg({ id: "dbx08t3", driver: "mysql" }),
      "p",
    );
    await mgr.setActive("dbx08t3");
    const provider = new SchemaTreeProvider(mgr);

    const root = await provider.getChildren(undefined);
    const schemas = await provider.getChildren(root[0]);
    const cats = await provider.getChildren(schemas[0]);
    expect(cats.map((c) => c.label)).toEqual(["Tables", "Views", "Routines"]);

    const tables = await provider.getChildren(cats[0]);
    expect(tables.map((t) => t.label)).toEqual(["users", "orders"]);

    // Views and routines keep generic navigation.
    const views = await provider.getChildren(cats[1]);
    expect(views.map((v) => v.label)).toEqual(["v_active"]);
    const routines = await provider.getChildren(cats[2]);
    expect(routines.map((r) => r.label)).toEqual(["do_thing"]);

    // Table columns render.
    const tableChildren = await provider.getChildren(tables[0]);
    expect(tableChildren.map((c) => c.label)).toEqual(["id"]);

    await waitMicrotasks();
    await waitMicrotasks();
    // Estimate batching fired for the schema's tables; exact rowCount never.
    expect(adapter.estimateTableRowsBatch).toHaveBeenCalledWith(
      "public",
      expect.arrayContaining(["users", "orders"]),
    );
    expect(tables[0].description).toBe(formatRows(250));
  });
});
