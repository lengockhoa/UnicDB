// src/ui/__tests__/schemaCache.test.ts
// TASK-008 §Test Cases #7-#9 — SchemaCache TTL unit tests.
// SchemaCache is vscode-free (pure adapter wrapper) → no vscode mock needed.
import { describe, it, expect, vi } from "vitest";
import type {
  CatalogApi,
  ColumnInfo,
  DbAdapter,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableConstraintInfo,
  TableInfo,
  ViewInfo,
} from "../../adapters/types";
import { hasAdapterCapability } from "../../adapters/types";
import { SchemaCache } from "../schemaCache";

function adapterWith(listTables: ReturnType<typeof vi.fn>): DbAdapter {
  return { listTables } as unknown as DbAdapter;
}

/** Deferred promise — lets the test hold an adapter response in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain pending microtasks so a just-started getTables call has actually
 * reached adapter.listTables before the test counts calls.
 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("SchemaCache — TASK-008 §Test Cases", () => {
  it("#7 SchemaCache returns cached data within TTL", async () => {
    const data: TableInfo[] = [{ name: "users", schema: "public" }];
    const listTables = vi.fn(async () => data);
    // Default TTL 60s — both calls happen well within it. Identity is
    // load-bearing (TASK-RLX03-003): hold ONE adapter across calls.
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter);
    const first = await cache.getTables();
    const second = await cache.getTables();
    // Same reference + adapter hit exactly once → served from cache.
    expect(second).toBe(first);
    expect(listTables).toHaveBeenCalledTimes(1);
  });

  it("#8 SchemaCache invalidate clears cache", async () => {
    const data1: TableInfo[] = [{ name: "users", schema: "public" }];
    const data2: TableInfo[] = [{ name: "invoices", schema: "public" }];
    const listTables = vi.fn(async () => data1);
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter);
    expect(await cache.getTables()).toBe(data1);
    cache.invalidate();
    listTables.mockImplementation(async () => data2);
    // Post-invalidate: next call fetches FRESH data from the adapter.
    expect(await cache.getTables()).toBe(data2);
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("#9 SchemaCache adapter failure preserves previous cache", async () => {
    const stale: TableInfo[] = [{ name: "users", schema: "public" }];
    const listTables = vi.fn(async () => stale);
    // ttlMs 0 → entry always considered expired → refresh attempted on
    // every call, so the second call exercises the failure path.
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter, { ttlMs: 0 });
    expect(await cache.getTables()).toBe(stale);
    listTables.mockRejectedValue(new Error("connection lost"));
    await expect(cache.getTables()).resolves.toBe(stale);
  });
});

describe("SchemaCache — DBX-02 catalog capability", () => {
  it("hasCatalog returns false on adapter without catalog", async () => {
    const listTables = vi.fn(async () => []);
    const cache = new SchemaCache(() => adapterWith(listTables));
    expect(await cache.hasCatalog()).toBe(false);
  });

  it("getViews returns cached list (adapter called once within TTL)", async () => {
    const views: ViewInfo[] = [
      { name: "user_summary", schema: "public" },
      { name: "active_orders", schema: "public" },
    ];
    const listViews = vi.fn(async () => views);
    const adapter: DbAdapter = {
      listTables: vi.fn(async () => []),
      listViews,
    } as unknown as DbAdapter;
    const cache = new SchemaCache(() => adapter);
    const first = await cache.getViews("public");
    const second = await cache.getViews("public");
    expect(second).toBe(first);
    expect(first).toEqual(views);
    expect(listViews).toHaveBeenCalledTimes(1);
  });

  it("getConstraints for public.orders calls constraints only once across repeats", async () => {
    const constraints: TableConstraintInfo[] = [
      {
        name: "orders_user_id_fkey",
        type: "fk",
        columns: ["user_id"],
        fkTarget: { schema: "public", table: "users", columns: ["id"] },
      },
    ];
    const listConstraints = vi.fn(async () => constraints);
    const catalog: CatalogApi = {
      listIndexes: vi.fn(async () => []),
      listConstraints,
      listTriggers: vi.fn(async () => []),
      listSequences: vi.fn(async () => []),
      rowCount: vi.fn(async () => 0),
      objectDdl: vi.fn(async () => ""),
    };
    const adapter: DbAdapter = {
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      catalog,
      // DBX-08 — the declared capability matrix is the admission decision.
      capabilities: {
        catalog: true,
        objectDdl: true,
        tableDdl: true,
        admin: true,
      },
    } as unknown as DbAdapter;
    const cache = new SchemaCache(() => adapter);
    const first = await cache.getConstraints("public", "orders");
    const second = await cache.getConstraints("public", "orders");
    expect(second).toBe(first);
    expect(first).toEqual(constraints);
    expect(listConstraints).toHaveBeenCalledTimes(1);
    expect(listConstraints).toHaveBeenCalledWith("public", "orders");
  });
});

describe("SchemaCache — TASK-RLX-002 single-flight coalescing", () => {
  it("#1 concurrent stale getTables(schema) coalesce into one adapter call", async () => {
    const refreshed: TableInfo[] = [{ name: "orders", schema: "public" }];
    const first = deferred<TableInfo[]>();
    const listTables = vi.fn(() => first.promise);
    // ttlMs 0 → entry always expired → every call attempts a refresh.
    const cache = new SchemaCache(() => adapterWith(listTables), { ttlMs: 0 });

    const p1 = cache.getTables("public");
    const p2 = cache.getTables("public");
    await flushMicrotasks();
    // Both callers must be sharing ONE in-flight adapter introspection.
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalledWith("public");
    first.resolve(refreshed);

    await expect(p1).resolves.toBe(refreshed);
    await expect(p2).resolves.toBe(refreshed);
    expect(listTables).toHaveBeenCalledTimes(1);
  });

  it("#2 shared refresh rejection returns stale value to every caller", async () => {
    const stale: TableInfo[] = [{ name: "users", schema: "public" }];
    const listTables = vi.fn(async () => stale);
    // ttlMs 0 → entry always expired → every call attempts a refresh.
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter, { ttlMs: 0 });
    await expect(cache.getTables("public")).resolves.toBe(stale);
    expect(listTables).toHaveBeenCalledTimes(1);

    const failure = deferred<TableInfo[]>();
    listTables.mockImplementation(() => failure.promise);
    const p1 = cache.getTables("public");
    const p2 = cache.getTables("public");
    await flushMicrotasks();
    // Both concurrent callers must share ONE refresh attempt.
    expect(listTables).toHaveBeenCalledTimes(2);
    failure.reject(new Error("connection lost"));

    // Neither caller rejects — both receive the prior cached value.
    await expect(p1).resolves.toBe(stale);
    await expect(p2).resolves.toBe(stale);
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("#3 invalidate defeats a refresh that started before it", async () => {
    const oldData: TableInfo[] = [{ name: "orders", schema: "public" }];
    const newData: TableInfo[] = [{ name: "invoices", schema: "public" }];
    let clock = 1_000;
    const first = deferred<TableInfo[]>();
    const listTables = vi.fn(() => first.promise);
    // Fixed clock + default TTL → a successful commit must keep entries fresh.
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter, {
      now: () => clock,
    });

    const inflight = cache.getTables("public");
    await flushMicrotasks();
    cache.invalidate(); // response was already started → must not repopulate
    first.resolve(oldData);
    await expect(inflight).resolves.toBe(oldData);

    // Cache stayed empty → the next read must fetch and return the NEW data.
    clock = 2_000;
    const second = deferred<TableInfo[]>();
    listTables.mockImplementation(() => second.promise);
    const next = cache.getTables("public");
    await flushMicrotasks();
    expect(listTables).toHaveBeenCalledTimes(2);
    second.resolve(newData);
    await expect(next).resolves.toBe(newData);

    // Third read within TTL is served from the cache holding newData —
    // proof that the pre-invalidate response never became cache state.
    const third = await cache.getTables("public");
    expect(third).toBe(newData);
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("sync-throwing provider leaves no stuck in-flight entry", async () => {
    // Regression (review round 1): a provider that THROWS synchronously —
    // before/outside promise construction — must not leave a permanently
    // settled entry in the in-flight registry. Stale-on-error contract still
    // applies to the first caller: no prior cache → [] fallback, never a hang.
    const listTables = vi.fn((_schema?: string) => {
      throw new Error("boom");
    });
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter, { ttlMs: 0 });

    // (a) First caller settles with the error-handled fallback.
    await expect(cache.getTables("public")).resolves.toEqual([]);
    expect(listTables).toHaveBeenCalledTimes(1);

    // (b) Provider recovers → the NEXT load must be a FRESH provider call.
    const fresh: TableInfo[] = [{ name: "orders", schema: "public" }];
    listTables.mockImplementation(async () => fresh);
    await expect(cache.getTables("public")).resolves.toBe(fresh);
    expect(listTables).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// TASK-ARP07-002 — successful-DDL cache invalidation seam: the exact race the
// DDL wiring will drive is `invalidate()` landing while a completion lookup is
// in flight. Expected outcome against CURRENT code: the pre-invalidate response
// still settles its own caller but NEVER becomes cache state; the next lookup
// refetches fresh. VERIFY-FIRST — these pins are expected GREEN without any
// schemaCache.ts change (generation guard at schemaCache.ts:74, 288-308, 374).
// =============================================================================
describe("SchemaCache — TASK-ARP07-002 DDL invalidation race", () => {
  it("#1 DDL-shaped: invalidate lands while a completion lookup is in flight → stale response never commits; next getTables refetches fresh", async () => {
    const oldData: TableInfo[] = [{ name: "orders", schema: "public" }];
    const newData: TableInfo[] = [{ name: "invoices", schema: "public" }];
    let clock = 1_000;
    const first = deferred<TableInfo[]>();
    const listTables = vi.fn(() => first.promise);
    // Fixed clock + default TTL → a successful commit must keep entries fresh,
    // so any post-invalidate cache hit could only come from a stale commit.
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter, {
      now: () => clock,
    });

    // A completion provider lookup starts and hangs on the adapter response…
    const inflight = cache.getTables("public");
    await flushMicrotasks();
    // …then a successful DDL fires invalidate() mid-flight.
    cache.invalidate();
    // The pre-invalidate response still resolves — to its OWN caller only.
    first.resolve(oldData);
    await expect(inflight).resolves.toBe(oldData);

    // Cache slot stayed empty → the next completion lookup refetches fresh.
    clock = 2_000;
    const second = deferred<TableInfo[]>();
    listTables.mockImplementation(() => second.promise);
    const next = cache.getTables("public");
    await flushMicrotasks();
    expect(listTables).toHaveBeenCalledTimes(2);
    second.resolve(newData);
    await expect(next).resolves.toBe(newData);

    // Third read within TTL serves newData from cache with NO extra adapter
    // call — proof the pre-invalidate response never became cache state.
    const third = await cache.getTables("public");
    expect(third).toBe(newData);
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("#2 invalidate BEFORE a fetch starts → plain fresh fetch, cached entry is the fresh adapter data", async () => {
    const fresh: TableInfo[] = [{ name: "invoices", schema: "public" }];
    const listTables = vi.fn(async () => fresh);
    let clock = 1_000;
    const adapter = adapterWith(listTables);
    const cache = new SchemaCache(() => adapter, { now: () => clock });

    // DDL lands on a cold cache — nothing stale exists yet, invalidation is a
    // no-op on entries; the subsequent lookup is an ordinary fresh fetch.
    cache.invalidate();
    const tables = await cache.getTables("public");
    expect(tables).toBe(fresh);
    expect(listTables).toHaveBeenCalledTimes(1);

    // The committed entry is the fresh adapter data (same reference within
    // TTL) — no phantom stale window opened by the pre-fetch invalidate.
    clock = 2_000;
    expect(await cache.getTables("public")).toBe(fresh);
    expect(listTables).toHaveBeenCalledTimes(1);
  });

  it("#3 invalidate during CONCURRENT tables + columns fetches → neither family commits stale data; both keys refetch", async () => {
    const oldTables: TableInfo[] = [{ name: "orders", schema: "public" }];
    const oldColumns: ColumnInfo[] = [
      { name: "id", dataType: "integer", nullable: false },
    ];
    const newTables: TableInfo[] = [{ name: "invoices", schema: "public" }];
    const newColumns: ColumnInfo[] = [
      { name: "id", dataType: "integer", nullable: false },
      { name: "total", dataType: "numeric", nullable: true },
    ];
    let clock = 1_000;
    const tablesDef = deferred<TableInfo[]>();
    const columnsDef = deferred<ColumnInfo[]>();
    const listTables = vi.fn(() => tablesDef.promise);
    const listColumns = vi.fn(() => columnsDef.promise);
    const adapter = {
      listTables,
      listColumns,
    } as unknown as DbAdapter;
    const cache = new SchemaCache(() => adapter, { now: () => clock });

    // Two DIFFERENT cache families are in flight when the DDL invalidates.
    const pendingTables = cache.getTables("public");
    const pendingColumns = cache.getColumns("users", "public");
    await flushMicrotasks();
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listColumns).toHaveBeenCalledTimes(1);
    cache.invalidate();

    // Each pre-invalidate response settles its own caller…
    tablesDef.resolve(oldTables);
    columnsDef.resolve(oldColumns);
    await expect(pendingTables).resolves.toBe(oldTables);
    await expect(pendingColumns).resolves.toBe(oldColumns);

    // …but BOTH cache slots stayed empty → both families refetch fresh.
    clock = 2_000;
    const secondTables = deferred<TableInfo[]>();
    const secondColumns = deferred<ColumnInfo[]>();
    listTables.mockImplementation(() => secondTables.promise);
    listColumns.mockImplementation(() => secondColumns.promise);
    const nextTables = cache.getTables("public");
    const nextColumns = cache.getColumns("users", "public");
    await flushMicrotasks();
    expect(listTables).toHaveBeenCalledTimes(2);
    expect(listColumns).toHaveBeenCalledTimes(2);
    secondTables.resolve(newTables);
    secondColumns.resolve(newColumns);
    await expect(nextTables).resolves.toBe(newTables);
    await expect(nextColumns).resolves.toBe(newColumns);

    // Within-TTL reads are served from the fresh commits — neither stale
    // family ever became cache state.
    expect(await cache.getTables("public")).toBe(newTables);
    expect(await cache.getColumns("users", "public")).toBe(newColumns);
    expect(listTables).toHaveBeenCalledTimes(2);
    expect(listColumns).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// TASK-DBX08-002 — catalog/cache admission by declared capability.
// =============================================================================

function makeCatalog(viFns = true): CatalogApi {
  const fns = {
    listIndexes: vi.fn(async () => []),
    listConstraints: vi.fn(async () => []),
    listTriggers: vi.fn(async () => []),
    listSequences: vi.fn(async () => []),
    rowCount: vi.fn(async () => 0),
    objectDdl: vi.fn(async () => "CREATE OBJECT ..."),
  };
  if (!viFns) {
    // Non-tracked structural shape (plain async fns) to prove the gate is
    // not merely absence of the methods.
    for (const key of Object.keys(fns) as Array<keyof CatalogApi>) {
      (fns as Record<string, unknown>)[key] = async () => [];
    }
  }
  return fns;
}

describe("SchemaCache — TASK-DBX08-002 declared-capability admission", () => {
  it("declared catalog capability keeps cache catalog results", async () => {
    const sequences = [{ name: "orders_id_seq", schema: "public", dataType: "bigint" }];
    const constraints: TableConstraintInfo[] = [
      {
        name: "orders_user_id_fkey",
        type: "fk",
        columns: ["user_id"],
        fkTarget: { schema: "public", table: "users", columns: ["id"] },
      },
    ];
    const catalog = makeCatalog();
    catalog.listSequences = vi.fn(async () => sequences);
    catalog.listConstraints = vi.fn(async () => constraints);
    catalog.objectDdl = vi.fn(async () => "CREATE VIEW public.v AS SELECT 1;");
    const adapter: DbAdapter = {
      catalog,
      capabilities: {
        catalog: true,
        objectDdl: true,
        tableDdl: true,
        admin: true,
      },
    } as unknown as DbAdapter;
    const cache = new SchemaCache(() => adapter);

    expect(await cache.hasCatalog()).toBe(true);
    expect(await cache.getSequences("public")).toEqual(sequences);
    expect(await cache.getConstraints("public", "orders")).toEqual(constraints);
    expect(
      await cache.getObjectDdl("view", "public", "v_active"),
    ).toBe("CREATE VIEW public.v AS SELECT 1;");
    expect(catalog.listSequences).toHaveBeenCalledWith("public");
    expect(catalog.listConstraints).toHaveBeenCalledWith("public", "orders");
    expect(catalog.objectDdl).toHaveBeenCalledWith("view", "v_active", "public");
  });

  it("false/absent declaration admits nothing and makes no catalog calls", async () => {
    // (a) Explicit false declarations with a structurally present catalog.
    const catalogFalse = makeCatalog();
    const adapterFalse: DbAdapter = {
      catalog: catalogFalse,
      capabilities: {
        catalog: false,
        objectDdl: false,
        tableDdl: false,
        admin: false,
      },
    } as unknown as DbAdapter;
    const cacheFalse = new SchemaCache(() => adapterFalse);

    // (b) Structural catalog object with NO capabilities at all (legacy).
    const catalogLegacy = makeCatalog();
    const adapterLegacy = { catalog: catalogLegacy } as unknown as DbAdapter;
    const cacheLegacy = new SchemaCache(() => adapterLegacy);

    for (const cache of [cacheFalse, cacheLegacy]) {
      expect(await cache.hasCatalog()).toBe(false);
      expect(await cache.getConstraints("public", "orders")).toEqual([]);
      expect(await cache.getSequences("public")).toEqual([]);
      expect(await cache.getObjectDdl("view", "public", "v")).toBeUndefined();
    }
    for (const catalog of [catalogFalse, catalogLegacy]) {
      expect(catalog.listIndexes).not.toHaveBeenCalled();
      expect(catalog.listConstraints).not.toHaveBeenCalled();
      expect(catalog.listTriggers).not.toHaveBeenCalled();
      expect(catalog.listSequences).not.toHaveBeenCalled();
      expect(catalog.rowCount).not.toHaveBeenCalled();
      expect(catalog.objectDdl).not.toHaveBeenCalled();
    }
    expect(hasAdapterCapability(adapterLegacy, "catalog")).toBe(false);
  });

  it("objectDdl declaration false skips catalog.objectDdl even when catalog is declared", async () => {
    // Catalog capability true but objectDdl false: constraints/sequences still
    // work, but DDL retrieval is gated by its OWN declaration.
    const catalog = makeCatalog();
    const adapter: DbAdapter = {
      catalog,
      capabilities: {
        catalog: true,
        objectDdl: false,
        tableDdl: false,
        admin: false,
      },
    } as unknown as DbAdapter;
    const cache = new SchemaCache(() => adapter);
    expect(await cache.getObjectDdl("routine", "public", "do_thing")).toBeUndefined();
    expect(catalog.objectDdl).not.toHaveBeenCalled();
  });

  it("declared objectDdl with missing callable API returns undefined defensively", async () => {
    // Malformed adapter: declares objectDdl true but has no catalog at all —
    // a contract violation in production, but the cache must not throw.
    const adapter = {
      capabilities: {
        catalog: true,
        objectDdl: true,
        tableDdl: false,
        admin: false,
      },
    } as unknown as DbAdapter;
    const cache = new SchemaCache(() => adapter);
    expect(await cache.getObjectDdl("view", "public", "v")).toBeUndefined();
  });
});

// =============================================================================
// TASK-RLX03-003 — invalidate SchemaCache on resolved adapter identity change.
// =============================================================================

/** Inspectable fake adapter: every introspection surface records its calls. */
function makeInspectableAdapter(
  tag: string,
  options: { capabilities?: Partial<DbAdapter["capabilities"]> } = {},
): {
  adapter: DbAdapter;
  calls: {
    listSchemas: ReturnType<typeof vi.fn>;
    listTables: ReturnType<typeof vi.fn>;
    listColumns: ReturnType<typeof vi.fn>;
    listViews: ReturnType<typeof vi.fn>;
    listRoutines: ReturnType<typeof vi.fn>;
    listConstraints: ReturnType<typeof vi.fn>;
    listSequences: ReturnType<typeof vi.fn>;
    objectDdl: ReturnType<typeof vi.fn>;
  };
} {
  const caps = {
    catalog: true,
    objectDdl: true,
    tableDdl: true,
    admin: true,
    ...options.capabilities,
  };
  const calls = {
    listSchemas: vi.fn(async (): Promise<SchemaInfo[]> => [
      { name: `${tag}_schema` },
    ]),
    listTables: vi.fn(async (): Promise<TableInfo[]> => [
      { name: `${tag}_table`, schema: "public" },
    ]),
    listColumns: vi.fn(async () => [{ name: `${tag}_col`, dataType: "text", nullable: true }]),
    listViews: vi.fn(async (): Promise<ViewInfo[]> => [
      { name: `${tag}_view`, schema: "public" },
    ]),
    listRoutines: vi.fn(async (): Promise<RoutineInfo[]> => [
      { name: `${tag}_routine`, kind: "function" as const, schema: "public" },
    ]),
    listConstraints: vi.fn(async (): Promise<TableConstraintInfo[]> => [
      {
        name: `${tag}_constraint`,
        type: "pk" as const,
        columns: ["id"],
      },
    ]),
    listSequences: vi.fn(async (): Promise<SequenceInfo[]> => [
      { name: `${tag}_seq`, schema: "public", dataType: "bigint" },
    ]),
    objectDdl: vi.fn(async () => `DDL ${tag}`),
  };
  const adapter = {
    listSchemas: calls.listSchemas,
    listTables: calls.listTables,
    listColumns: calls.listColumns,
    listViews: calls.listViews,
    listRoutines: calls.listRoutines,
    catalog: {
      listIndexes: vi.fn(async () => []),
      listConstraints: calls.listConstraints,
      listTriggers: vi.fn(async () => []),
      listSequences: calls.listSequences,
      rowCount: vi.fn(async () => 0),
      objectDdl: calls.objectDdl,
    },
    capabilities: caps,
  } as unknown as DbAdapter;
  return { adapter, calls };
}

describe("SchemaCache — TASK-RLX03-003 adapter identity transition", () => {
  it("#1 adapter B transition replaces fresh schema and table cache families", async () => {
    let current = makeInspectableAdapter("A");
    const provider = vi.fn(() => current.adapter);
    let clock = 1_000;
    // Default TTL (60s) + fixed clock → A entries stay FRESH the whole test;
    // only an adapter identity change may justify a refetch.
    const cache = new SchemaCache(provider, { now: () => clock });

    // Warm all three table/schema families from adapter A.
    const schemasA = await cache.getSchemas();
    const tablesAllA = await cache.getTables();
    const tablesPublicA = await cache.getTables("public");
    expect(schemasA).toEqual([{ name: "A_schema" }]);
    expect(tablesAllA).toEqual([{ name: "A_table", schema: "public" }]);
    expect(tablesPublicA).toEqual([{ name: "A_table", schema: "public" }]);
    const aCallsAfterWarm = current.calls;
    expect(aCallsAfterWarm.listSchemas).toHaveBeenCalledTimes(1);
    expect(aCallsAfterWarm.listTables).toHaveBeenCalledTimes(2);

    // Provider now resolves adapter B while every A entry is still fresh.
    const b = makeInspectableAdapter("B");
    current = { adapter: b.adapter, calls: b.calls };

    const schemasB = await cache.getSchemas();
    const tablesAllB = await cache.getTables();
    const tablesPublicB = await cache.getTables("public");

    // Each B method called exactly once and returned B's distinct value —
    // A's fresh-TTL cached value must never be served after the transition.
    expect(b.calls.listSchemas).toHaveBeenCalledTimes(1);
    expect(schemasB).toEqual([{ name: "B_schema" }]);
    expect(schemasB).not.toEqual(schemasA);
    expect(b.calls.listTables).toHaveBeenCalledTimes(2);
    expect(tablesAllB).toEqual([{ name: "B_table", schema: "public" }]);
    expect(tablesAllB).not.toBe(tablesAllA);
    expect(tablesPublicB).toEqual([{ name: "B_table", schema: "public" }]);
    expect(tablesPublicB).not.toBe(tablesPublicA);

    // Within TTL the new entries are cached under B's identity.
    clock = 2_000;
    expect(await cache.getSchemas()).toBe(schemasB);
    expect(await cache.getTables()).toBe(tablesAllB);
    expect(await cache.getTables("public")).toBe(tablesPublicB);
    expect(b.calls.listSchemas).toHaveBeenCalledTimes(1);
    expect(b.calls.listTables).toHaveBeenCalledTimes(2);
  });

  it("#2 adapter B transition replaces every pre-resolve column and catalog/DDL cache family", async () => {
    let current = makeInspectableAdapter("A");
    const provider = vi.fn(() => current.adapter);
    let clock = 1_000;
    const cache = new SchemaCache(provider, { now: () => clock });

    // Warm the column + catalog/DDL families from adapter A.
    const columnsA = await cache.getColumns("users", "public");
    const viewsA = await cache.getViews("public");
    const routinesA = await cache.getRoutines("public");
    const sequencesA = await cache.getSequences("public");
    const constraintsA = await cache.getConstraints("public", "users");
    const ddlA = await cache.getObjectDdl("view", "public", "v_users");
    expect(columnsA).toEqual([{ name: "A_col", dataType: "text", nullable: true }]);
    expect(viewsA).toEqual([{ name: "A_view", schema: "public" }]);
    expect(routinesA).toEqual([{ name: "A_routine", kind: "function", schema: "public" }]);
    expect(sequencesA).toEqual([{ name: "A_seq", schema: "public", dataType: "bigint" }]);
    expect(constraintsA).toEqual([{ name: "A_constraint", type: "pk", columns: ["id"] }]);
    expect(ddlA).toBe("DDL A");

    // Switch to catalog-and-objectDdl-capable B — all A entries still fresh.
    const b = makeInspectableAdapter("B");
    current = { adapter: b.adapter, calls: b.calls };

    const columnsB = await cache.getColumns("users", "public");
    const viewsB = await cache.getViews("public");
    const routinesB = await cache.getRoutines("public");
    const sequencesB = await cache.getSequences("public");
    const constraintsB = await cache.getConstraints("public", "users");
    const ddlB = await cache.getObjectDdl("view", "public", "v_users");

    // Every lookup hit B, never A's still-fresh cached value.
    expect(columnsB).toEqual([{ name: "B_col", dataType: "text", nullable: true }]);
    expect(columnsB).not.toBe(columnsA);
    expect(viewsB).toEqual([{ name: "B_view", schema: "public" }]);
    expect(viewsB).not.toBe(viewsA);
    expect(routinesB).toEqual([{ name: "B_routine", kind: "function", schema: "public" }]);
    expect(routinesB).not.toBe(routinesA);
    expect(sequencesB).toEqual([{ name: "B_seq", schema: "public", dataType: "bigint" }]);
    expect(sequencesB).not.toBe(sequencesA);
    expect(constraintsB).toEqual([{ name: "B_constraint", type: "pk", columns: ["id"] }]);
    expect(constraintsB).not.toBe(constraintsA);
    expect(ddlB).toBe("DDL B");
    expect(b.calls.listColumns).toHaveBeenCalledTimes(1);
    expect(b.calls.listViews).toHaveBeenCalledTimes(1);
    expect(b.calls.listRoutines).toHaveBeenCalledTimes(1);
    expect(b.calls.listSequences).toHaveBeenCalledTimes(1);
    expect(b.calls.listConstraints).toHaveBeenCalledTimes(1);
    expect(b.calls.objectDdl).toHaveBeenCalledTimes(1);

    // Fresh B entries persist within TTL (cached under the new generation).
    clock = 2_000;
    expect(await cache.getColumns("users", "public")).toBe(columnsB);
    expect(await cache.getViews("public")).toBe(viewsB);
    expect(await cache.getRoutines("public")).toBe(routinesB);
    expect(await cache.getSequences("public")).toBe(sequencesB);
    expect(await cache.getConstraints("public", "users")).toBe(constraintsB);
    expect(await cache.getObjectDdl("view", "public", "v_users")).toBe(ddlB);
    expect(b.calls.listColumns).toHaveBeenCalledTimes(1);
    expect(b.calls.objectDdl).toHaveBeenCalledTimes(1);
  });

  it("#3 A response begun before adapter B transition cannot commit after invalidation", async () => {
    let current = makeInspectableAdapter("A");
    const provider = vi.fn(() => current.adapter);
    let clock = 1_000;
    // Fixed clock keeps a committed entry fresh across the whole test.
    const cache = new SchemaCache(provider, { now: () => clock });

    // Hold adapter A's response in flight for getTables("public").
    const inFlight = deferred<TableInfo[]>();
    const aTables = current.calls.listTables as ReturnType<typeof vi.fn>;
    aTables.mockImplementation(() => inFlight.promise);
    const pending = cache.getTables("public");
    await flushMicrotasks();
    expect(aTables).toHaveBeenCalledTimes(1);

    // Provider switches to B while A's response is still unresolved.
    const b = makeInspectableAdapter("B");
    current = { adapter: b.adapter, calls: b.calls };

    // A's deferred result still resolves to its ORIGINAL caller...
    const oldData: TableInfo[] = [{ name: "old", schema: "public" }];
    inFlight.resolve(oldData);
    await expect(pending).resolves.toBe(oldData);

    // ...but the next read fetches from B (`new`), never A's old response.
    const newData: TableInfo[] = [{ name: "new", schema: "public" }];
    (b.calls.listTables as ReturnType<typeof vi.fn>).mockImplementation(
      async () => newData,
    );
    expect(await cache.getTables("public")).toBe(newData);

    // Later within-TTL read stays `new` — A's response never became cache.
    expect(await cache.getTables("public")).toBe(newData);
    expect(b.calls.listTables).toHaveBeenCalledTimes(1);
  });

  it("#3b B lookup during A's unresolved refresh starts B's own request instead of A's promise", async () => {
    let current = makeInspectableAdapter("A");
    const provider = vi.fn(() => current.adapter);
    let clock = 1_000;
    // Fixed clock keeps a committed entry fresh across the whole test.
    const cache = new SchemaCache(provider, { now: () => clock });

    // Adapter A's response is held in flight (deferred, unresolved).
    const aDeferred = deferred<TableInfo[]>();
    const aTables = current.calls.listTables as ReturnType<typeof vi.fn>;
    aTables.mockImplementation(() => aDeferred.promise);
    const pendingA = cache.getTables("public");
    await flushMicrotasks();
    expect(aTables).toHaveBeenCalledTimes(1);

    // Adapter transition WHILE A's response is still unresolved — this is
    // the boundary the single-flight registry must respect.
    const b = makeInspectableAdapter("B");
    current = { adapter: b.adapter, calls: b.calls };

    // B's same-key lookup must NOT coalesce onto A's in-flight promise.
    const bDeferred = deferred<TableInfo[]>();
    const bTables = b.calls.listTables as ReturnType<typeof vi.fn>;
    bTables.mockImplementation(() => bDeferred.promise);
    const pendingB = cache.getTables("public");
    await flushMicrotasks();

    // Settle A's deferred: in the buggy path this is the only data B's
    // caller can ever see, because B joined A's in-flight entry.
    const oldData: TableInfo[] = [{ name: "old", schema: "public" }];
    aDeferred.resolve(oldData);

    // B's caller must receive B-data from B's OWN request — never A's
    // pre-transition response coalesced through the shared key.
    const newData: TableInfo[] = [{ name: "new", schema: "public" }];
    bDeferred.resolve(newData);
    await expect(pendingB).resolves.toBe(newData);

    // A's original caller still settles normally on A's own promise.
    await expect(pendingA).resolves.toBe(oldData);

    // B started its OWN request exactly once; A served only its own caller.
    expect(bTables).toHaveBeenCalledTimes(1);
    expect(aTables).toHaveBeenCalledTimes(1);

    // A's pre-transition response never committed — the within-TTL read is
    // served from B's freshly committed entry, with no extra B call.
    expect(await cache.getTables("public")).toBe(newData);
    expect(bTables).toHaveBeenCalledTimes(1);
  });

  it("#4 null and throwing provider keep cached stale data without changing adapter identity", async () => {
    let current = makeInspectableAdapter("A");
    let mode: "adapter" | "null" | "throw" = "adapter";
    const provider = vi.fn(() => {
      if (mode === "null") return null;
      if (mode === "throw") throw new Error("no active connection");
      return current.adapter;
    });
    const cache = new SchemaCache(provider);

    // Warm the cache from adapter A.
    const cached: TableInfo[] = [{ name: "A_table", schema: "public" }];
    expect(await cache.getTables("public")).toEqual(cached);
    expect(current.calls.listTables).toHaveBeenCalledTimes(1);

    // (a) Provider resolves null → stale A data, no replacement adapter call.
    mode = "null";
    await expect(cache.getTables("public")).resolves.toEqual(cached);
    expect(current.calls.listTables).toHaveBeenCalledTimes(1);

    // (b) Provider throws → still stale A data, cache not erased.
    mode = "throw";
    await expect(cache.getTables("public")).resolves.toEqual(cached);
    expect(current.calls.listTables).toHaveBeenCalledTimes(1);

    // (c) Provider recovers to the SAME adapter A → stale contract intact;
    // the cached entry was never cleared by the unavailable-provider window.
    mode = "adapter";
    expect(await cache.getTables("public")).toEqual(cached);
    expect(current.calls.listTables).toHaveBeenCalledTimes(1);
  });

  it("#5 same adapter still coalesces concurrent expired reads", async () => {
    const refreshed: TableInfo[] = [{ name: "orders", schema: "public" }];
    const first = deferred<TableInfo[]>();
    const listTables = vi.fn(() => first.promise);
    const adapter = adapterWith(listTables);
    // ttlMs 0 → entry always expired → every call attempts a refresh.
    const cache = new SchemaCache(() => adapter, { ttlMs: 0 });

    const p1 = cache.getTables("public");
    const p2 = cache.getTables("public");
    await flushMicrotasks();
    // Same identity must not trigger invalidate() — RLX-01 single-flight
    // coalescing keeps exactly ONE adapter refresh.
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalledWith("public");
    first.resolve(refreshed);

    await expect(p1).resolves.toBe(refreshed);
    await expect(p2).resolves.toBe(refreshed);
    expect(listTables).toHaveBeenCalledTimes(1);
  });
});
