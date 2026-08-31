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
});
