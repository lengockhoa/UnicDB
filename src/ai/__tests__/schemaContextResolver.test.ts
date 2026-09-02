// src/ai/__tests__/schemaContextResolver.test.ts
// Independent review findings — Issue #1 (cross-connection schema race) and
// Issue #2 (bounded schema context cache).
//
// The schema-context resolver is the AIC-002 `resolveSchema` factory in
// extension.ts. It must:
//   (a) Capture the active connection ID BEFORE awaiting adapter/listTables,
//       and re-verify it AFTER each await. If the active connection changed
//       mid-flight, the result is unsafe → return empty context.
//   (b) Be backed by a bounded cache keyed by active connection ID. Repeated
//       resolves for the SAME connection must NOT re-issue listTables /
//       listColumns. Connection change → invalidate → next resolve re-hydrates.
//   (c) Hydrate columns concurrently with a CONSERVATIVE cap (no row data).
//
// Pure vscode-free tests with stub adapters + a stub manager.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DbAdapter } from "../../adapters/types";
import type { ConnectionConfig } from "../../config/types";

import {
  createSchemaContextResolver,
  createSchemaContextCache,
  type ResolverDeps,
  type SchemaContextCacheOptions,
} from "../schemaContextCache";

function cfg(id: string, name = id): ConnectionConfig {
  return {
    id,
    name,
    driver: "postgres",
    host: "localhost",
    port: 5432,
    user: "u",
    database: "d",
  };
}

function adapterWith(opts: {
  listTables?: () => Promise<Array<{ name: string; schema: string }>>;
  listColumns?: (
    table: string,
    schema?: string,
  ) => Promise<Array<{ name: string; dataType: string; nullable: boolean }>>;
}): DbAdapter {
  return {
    listTables: opts.listTables ?? (async () => []),
    listColumns: opts.listColumns ?? (async () => []),
  } as unknown as DbAdapter;
}

describe("schemaContextResolver — cross-connection race (Issue #1)", () => {
  it("returns empty context if active connection changes while getAdapter() is pending", async () => {
    // Simulate: getAdapter() takes a while; during that time the user
    // switches to a different connection. The resolver must drop the result.
    let switchDuring!: () => void;
    const switched = new Promise<void>((r) => (switchDuring = r));

    const adapter = adapterWith({
      listTables: async () => [{ name: "users", schema: "public" }],
    });
    let current = cfg("db-A");
    const deps: ResolverDeps = {
      getActive: () => current,
      getAdapter: async () => {
        // Wait until the test flips the active connection.
        await switched;
        return adapter;
      },
    };
    const resolver = createSchemaContextResolver(deps);

    const p = resolver.resolve("scope-A");
    // Simulate the user switching connection BEFORE the adapter resolves.
    current = cfg("db-B");
    switchDuring();
    const ctx = await p;
    // Active changed mid-flight → empty context, never the stale listTables.
    expect(ctx.tables).toEqual([]);
    expect(ctx.connectionName).toBe("");
    expect(ctx.dialect).toBe("");
  });

  it("returns empty context if active connection changes while listTables() is pending", async () => {
    // Capture the resolver's first call attempt; flip active during
    // listTables, then resolve listTables with stale data.
    let releaseListTables!: () => void;
    const released = new Promise<void>((r) => (releaseListTables = r));

    const adapter = adapterWith({
      listTables: () => released.then(() => [{ name: "users", schema: "public" }]),
      listColumns: async () => [],
    });
    let current = cfg("db-A");
    const deps: ResolverDeps = {
      getActive: () => current,
      getAdapter: async () => adapter,
    };
    const resolver = createSchemaContextResolver(deps);

    const p = resolver.resolve("scope-A");
    // Yield so resolver captures active id and awaits listTables.
    await Promise.resolve();
    await Promise.resolve();
    // Active flips to db-B BEFORE listTables resolves.
    current = cfg("db-B");
    releaseListTables();
    const ctx = await p;
    expect(ctx.tables).toEqual([]);
    expect(ctx.connectionName).toBe("");
  });

  it("re-checks identity after getAdapter AND after listTables (race-safe)", async () => {
    // Both awaits pending — flip active once, then resolve both. The result
    // must still be empty.
    let releaseAdapter!: () => void;
    let releaseTables!: () => void;
    const adapterReady = new Promise<void>((r) => (releaseAdapter = r));
    const tablesReady = new Promise<void>((r) => (releaseTables = r));

    const adapter = adapterWith({
      listTables: () => tablesReady.then(() => [{ name: "users", schema: "public" }]),
      listColumns: async () => [],
    });
    let current = cfg("db-A");
    const getAdapterSpy = vi.fn(async () => {
      await adapterReady;
      return adapter;
    });
    const deps: ResolverDeps = {
      getActive: () => current,
      getAdapter: getAdapterSpy,
    };
    const resolver = createSchemaContextResolver(deps);

    const p = resolver.resolve("scope-A");
    await Promise.resolve();
    // Flip after both awaits have started but before either resolves.
    current = cfg("db-B");
    releaseAdapter();
    releaseTables();
    const ctx = await p;
    expect(ctx.tables).toEqual([]);
    expect(getAdapterSpy).toHaveBeenCalledTimes(1);
  });
});

describe("schemaContextResolver — happy path (Issue #2)", () => {
  it("returns connectionName + dialect on stable active", async () => {
    const adapter = adapterWith({
      listTables: async () => [{ name: "users", schema: "public" }],
      listColumns: async () => [{ name: "id", dataType: "int", nullable: false }],
    });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A", "alpha"),
      getAdapter: async () => adapter,
    };
    const resolver = createSchemaContextResolver(deps);
    const ctx = await resolver.resolve("scope-A");
    expect(ctx.dialect).toBe("postgres");
    expect(ctx.connectionName).toBe("alpha");
  });
});

describe("schemaContextCache — bounded cache (Issue #2)", () => {
  it("repeated resolve for the SAME connection avoids repeated listTables / listColumns", async () => {
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    const listColumns = vi.fn(async () => [
      { name: "id", dataType: "int", nullable: false },
    ]);
    const adapter = adapterWith({ listTables, listColumns });
    let current = cfg("db-A", "alpha");
    const deps: ResolverDeps = {
      getActive: () => current,
      getAdapter: async () => adapter,
    };
    const opts: SchemaContextCacheOptions = { ttlMs: 60_000 };
    const cache = createSchemaContextCache(deps, opts);
    const ctx1 = await cache.resolve("scope-A");
    const ctx2 = await cache.resolve("scope-A");
    expect(ctx1).toBe(ctx2);
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listColumns).toHaveBeenCalledTimes(1);
  });

  it("invalidate() refreshes the cache (next resolve re-hydrates)", async () => {
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    const listColumns = vi.fn(async () => [
      { name: "id", dataType: "int", nullable: false },
    ]);
    const adapter = adapterWith({ listTables, listColumns });
    let current = cfg("db-A", "alpha");
    const deps: ResolverDeps = {
      getActive: () => current,
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });
    await cache.resolve("scope-A");
    cache.invalidate();
    await cache.resolve("scope-A");
    expect(listTables).toHaveBeenCalledTimes(2);
    expect(listColumns).toHaveBeenCalledTimes(2);
  });

  it("connection change (different active id) refreshes the cache automatically", async () => {
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    const listColumns = vi.fn(async () => [
      { name: "id", dataType: "int", nullable: false },
    ]);
    const adapter = adapterWith({ listTables, listColumns });
    let current = cfg("db-A", "alpha");
    const deps: ResolverDeps = {
      getActive: () => current,
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });
    await cache.resolve("scope-A");
    // Switch active connection.
    current = cfg("db-B", "beta");
    const ctx2 = await cache.resolve("scope-A");
    expect(listTables).toHaveBeenCalledTimes(2);
    expect(listColumns).toHaveBeenCalledTimes(2);
    expect(ctx2.connectionName).toBe("beta");
  });

  it("hydrates columns concurrently with a conservative cap (no rows)", async () => {
    const tables = [
      { name: "t1", schema: "public" },
      { name: "t2", schema: "public" },
      { name: "t3", schema: "public" },
      { name: "t4", schema: "public" },
      { name: "t5", schema: "public" },
      { name: "t6", schema: "public" },
      { name: "t7", schema: "public" },
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const listColumns = vi.fn(async (_table: string, _schema?: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield once so concurrent calls actually overlap.
      await Promise.resolve();
      inFlight--;
      return [{ name: "id", dataType: "int", nullable: false }];
    });
    const adapter = adapterWith({
      listTables: async () => tables,
      listColumns,
    });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A", "alpha"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, {
      ttlMs: 60_000,
      columnConcurrency: 4,
    });
    const ctx = await cache.resolve("scope-A");
    expect(ctx.tables.length).toBe(7);
    // Concurrency bounded by cap (≤ 4). It must NOT exceed the configured cap.
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // prove it actually parallelized
  });

  it("never queries rows (only listTables / listColumns)", async () => {
    const runQuery = vi.fn(async () => {
      throw new Error("row access forbidden in cache hydration");
    });
    const adapter = {
      listTables: async () => [{ name: "users", schema: "public" }],
      listColumns: async () => [{ name: "id", dataType: "int", nullable: false }],
      runQuery,
    } as unknown as DbAdapter;
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });
    await cache.resolve("scope-A");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("adapter failure returns empty context, never throws", async () => {
    const adapter = adapterWith({
      listTables: async () => {
        throw new Error("connection lost");
      },
      listColumns: async () => [],
    });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });
    const ctx = await cache.resolve("scope-A");
    expect(ctx.tables).toEqual([]);
  });

  it("ttlMs=0 forces re-hydration on every resolve", async () => {
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    const listColumns = vi.fn(async () => [
      { name: "id", dataType: "int", nullable: false },
    ]);
    const adapter = adapterWith({ listTables, listColumns });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 0 });
    await cache.resolve("scope-A");
    await cache.resolve("scope-A");
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("invalidate clears the entire cache (different scopes re-hydrate)", async () => {
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    const listColumns = vi.fn(async () => []);
    const adapter = adapterWith({ listTables, listColumns });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });
    await cache.resolve("scope-A");
    await cache.resolve("scope-B");
    expect(listTables).toHaveBeenCalledTimes(1);
    cache.invalidate();
    await cache.resolve("scope-A");
    expect(listTables).toHaveBeenCalledTimes(2);
  });
});

describe("schemaContextCache — invalidate during in-flight hydration (ARP-07)", () => {
  it("does NOT commit an entry for a hydration invalidated mid-flight (next resolve re-hydrates)", async () => {
    // Hydration: listTables resolves immediately, listColumns is gated —
    // the test releases the gate AFTER invalidate(), so the hydration
    // resolves with stale (pre-DDL) data post-invalidation. A successful
    // DDL is simulated by the caller calling invalidate() at that moment.
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    let releaseColumns!: () => void;
    const columnsSettled = new Promise<
      Array<{ name: string; dataType: string; nullable: boolean }>
    >((resolve) => {
      releaseColumns = () =>
        resolve([{ name: "stale_col", dataType: "text", nullable: true }]);
    });
    // Call 1 (pre-DDL hydration) parks on the gate and yields stale data;
    // call 2 (post-invalidate re-hydration) resolves immediately with fresh data.
    const listColumns = vi.fn(() =>
      listColumns.mock.calls.length <= 1
        ? columnsSettled
        : Promise.resolve([{ name: "id", dataType: "int", nullable: false }]),
    );
    const adapter = adapterWith({ listTables, listColumns });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A", "alpha"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });

    const p1 = cache.resolve("scope-A");
    // Wait until hydration is parked on the gated listColumns call.
    await vi.waitFor(() => expect(listColumns).toHaveBeenCalledTimes(1));
    // Invalidate while the hydration is still in flight.
    cache.invalidate();
    // Let the stale hydration finish.
    releaseColumns();
    await p1;

    // The stale entry must NOT have been committed → the next resolve
    // re-issues listTables/listColumns.
    const ctx2 = await cache.resolve("scope-A");
    expect(listTables).toHaveBeenCalledTimes(2);
    expect(listColumns).toHaveBeenCalledTimes(2);
    expect(ctx2.tables[0]?.columns[0]?.name).toBe("id");
  });

  it("resolve() AFTER invalidate() starts a FRESH hydration instead of returning the stale in-flight one", async () => {
    // First listTables call is gated; later calls settle immediately, so a
    // fresh hydration can complete while the stale one is still parked.
    let releaseFirstTables!: () => void;
    const firstTablesReady = new Promise<void>((r) => (releaseFirstTables = r));
    const listTables = vi.fn(async () => {
      if (listTables.mock.calls.length <= 1) await firstTablesReady;
      return [{ name: "users", schema: "public" }];
    });
    const listColumns = vi.fn(async () => [
      { name: "id", dataType: "int", nullable: false },
    ]);
    const adapter = adapterWith({ listTables, listColumns });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A", "alpha"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });

    const stale = cache.resolve("scope-A");
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(1));
    // Invalidate while the pre-invalidate hydration is still pending.
    cache.invalidate();
    // Post-invalidate resolve must NOT coalesce onto the stale hydration.
    const freshP = cache.resolve("scope-A");
    expect(freshP).not.toBe(stale);
    // A NEW listTables invocation must have begun before the old one settled.
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(2));
    const freshCtx = await freshP;
    releaseFirstTables();
    await stale;

    expect(freshCtx.connectionName).toBe("alpha");
    expect(freshCtx.tables).toHaveLength(1);
  });

  it("invalidate() is idempotent on an empty cache (no throw; next resolve hydrates exactly once)", async () => {
    const listTables = vi.fn(async () => [{ name: "users", schema: "public" }]);
    const listColumns = vi.fn(async () => [
      { name: "id", dataType: "int", nullable: false },
    ]);
    const adapter = adapterWith({ listTables, listColumns });
    const deps: ResolverDeps = {
      getActive: () => cfg("db-A", "alpha"),
      getAdapter: async () => adapter,
    };
    const cache = createSchemaContextCache(deps, { ttlMs: 60_000 });

    expect(() => cache.invalidate()).not.toThrow();
    expect(() => cache.invalidate()).not.toThrow();

    const ctx = await cache.resolve("scope-A");
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listColumns).toHaveBeenCalledTimes(1);
    expect(ctx.tables).toHaveLength(1);
  });
});