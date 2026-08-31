// src/ui/__tests__/schemaCache.test.ts
// TASK-008 §Test Cases #7-#9 — SchemaCache TTL unit tests.
// SchemaCache is vscode-free (pure adapter wrapper) → no vscode mock needed.
import { describe, it, expect, vi } from "vitest";
import type {
  CatalogApi,
  DbAdapter,
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
    // Default TTL 60s — both calls happen well within it.
    const cache = new SchemaCache(() => adapterWith(listTables));
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
    const cache = new SchemaCache(() => adapterWith(listTables));
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
    const cache = new SchemaCache(() => adapterWith(listTables), { ttlMs: 0 });
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
    const cache = new SchemaCache(() => adapterWith(listTables), { ttlMs: 0 });
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
    const cache = new SchemaCache(() => adapterWith(listTables), {
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
    const cache = new SchemaCache(() => adapterWith(listTables), { ttlMs: 0 });

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
