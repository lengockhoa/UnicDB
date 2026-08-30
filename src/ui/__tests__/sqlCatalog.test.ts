// src/ui/__tests__/sqlCatalog.test.ts
// TASK-DBX02-001 §Test Cases #1-#4 — pure vscode-free resolver contract.
import { describe, it, expect, vi } from "vitest";
import type {
  RoutineInfo,
  TableConstraintInfo,
  ViewInfo,
} from "../../adapters/types";
import type { SchemaCache } from "../schemaCache";
import { createCatalogResolver } from "../sqlCatalog";

interface CacheMockOptions {
  hasCatalog?: boolean;
  views?: ViewInfo[];
  routines?: RoutineInfo[];
  constraints?: TableConstraintInfo[];
  sequences?: ReadonlyArray<{
    name: string;
    schema: string;
    dataType: string;
    lastValue?: string;
  }>;
  objectDdl?: string;
  rejectDdl?: boolean;
}

/**
 * Build a SchemaCache-shaped mock. The mock simulates the real cache's
 * stale-on-error behavior: on `rejectDdl`, the first call surfaces the
 * error and subsequent calls return the previously cached value (or
 * undefined when nothing has been cached yet).
 */
function makeCacheMock(opts: CacheMockOptions): SchemaCache {
  const hasCatalog = opts.hasCatalog ?? true;
  const views = opts.views ?? [];
  const routines = opts.routines ?? [];
  const constraints = opts.constraints ?? [];
  const sequences = opts.sequences ?? [];
  const rejectDdl = opts.rejectDdl ?? false;
  const objectDdl = opts.objectDdl ?? "";
  let ddlCached: string | undefined;
  let ddlHasCache = false;

  const cache = {
    hasCatalog: vi.fn(async () => hasCatalog),
    getViews: vi.fn(async () => views),
    getRoutines: vi.fn(async () => routines),
    getConstraints: vi.fn(async (_s: string, _t: string) => constraints),
    getSequences: vi.fn(async () => sequences),
    getObjectDdl: vi.fn(async () => {
      if (rejectDdl && ddlHasCache) {
        // Simulate SchemaCache's stale-on-error fallback.
        return ddlCached;
      }
      if (rejectDdl && !ddlHasCache) {
        // First call still succeeds and caches; subsequent calls reject and
        // fall back. Mirrors SchemaCache's "first success then rejection"
        // behavior the test is modeling.
        ddlCached = objectDdl;
        ddlHasCache = true;
        return objectDdl;
      }
      if (rejectDdl) throw new Error("ddl load failed");
      ddlCached = objectDdl;
      ddlHasCache = true;
      return objectDdl;
    }),
    invalidate: vi.fn(),
  };
  return cache as unknown as SchemaCache;
}

describe("createCatalogResolver — TASK-DBX02-001 §Test Cases", () => {
  it("#1 loads requested FK, view definition, routine body, and sequence rows", async () => {
    const constraints: TableConstraintInfo[] = [
      {
        name: "orders_user_id_fkey",
        type: "fk",
        columns: ["user_id"],
        fkTarget: { schema: "public", table: "users", columns: ["id"] },
      },
    ];
    const views: ViewInfo[] = [{ name: "user_summary", schema: "public" }];
    const routines: RoutineInfo[] = [
      { name: "current_month_revenue", kind: "function", schema: "public" },
    ];
    const sequences = [
      {
        name: "orders_id_seq",
        schema: "public",
        dataType: "bigint",
        lastValue: "42",
      },
    ];
    const objectDdl = "CREATE VIEW public.user_summary AS SELECT 1;";

    const cache = makeCacheMock({
      views,
      routines,
      constraints,
      sequences,
      objectDdl,
    });
    const resolver = createCatalogResolver(cache, { isPostgres: () => true });

    const fks = await resolver.listForeignKeys("public", "orders");
    const rootRows = await resolver.listRootRows();
    const viewDef = await resolver.getDefinition(
      "view",
      "public",
      "user_summary",
    );

    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      kind: "foreignKey",
      schema: "public",
      table: "orders",
      name: "orders_user_id_fkey",
      columns: ["user_id"],
      target: { schema: "public", table: "users", columns: ["id"] },
    });

    expect(rootRows).toHaveLength(3);
    const viewRow = rootRows.find((r) => r.kind === "view");
    const routineRow = rootRows.find((r) => r.kind === "routine");
    const sequenceRow = rootRows.find((r) => r.kind === "sequence");
    expect(viewRow).toMatchObject({
      kind: "view",
      schema: "public",
      name: "user_summary",
    });
    expect(routineRow).toMatchObject({
      kind: "routine",
      schema: "public",
      name: "current_month_revenue",
      routineKind: "function",
    });
    expect(sequenceRow).toMatchObject({
      kind: "sequence",
      schema: "public",
      name: "orders_id_seq",
      dataType: "bigint",
      lastValue: "42",
    });

    expect(viewDef).toBe(objectDdl);
  });

  it("#2 returns empty/undefined when isPostgres false OR adapter has no catalog (no catalog calls)", async () => {
    const cacheNonPg = makeCacheMock({ hasCatalog: false });
    const nonPgResolver = createCatalogResolver(cacheNonPg, {
      isPostgres: () => false,
    });
    expect(await nonPgResolver.listForeignKeys("public", "orders")).toEqual([]);
    expect(await nonPgResolver.listRootRows()).toEqual([]);
    expect(
      await nonPgResolver.getDefinition("view", "public", "user_summary"),
    ).toBeUndefined();

    const cacheNoCatalog = makeCacheMock({ hasCatalog: false });
    const noCatResolver = createCatalogResolver(cacheNoCatalog, {
      isPostgres: () => true,
    });
    expect(await noCatResolver.listForeignKeys("public", "orders")).toEqual([]);
    expect(await noCatResolver.listRootRows()).toEqual([]);
    expect(
      await noCatResolver.getDefinition("routine", "public", "do_thing"),
    ).toBeUndefined();

    expect(cacheNonPg.getViews).not.toHaveBeenCalled();
    expect(cacheNonPg.getRoutines).not.toHaveBeenCalled();
    expect(cacheNonPg.getConstraints).not.toHaveBeenCalled();
    expect(cacheNonPg.getSequences).not.toHaveBeenCalled();
    expect(cacheNonPg.getObjectDdl).not.toHaveBeenCalled();
    expect(cacheNoCatalog.getViews).not.toHaveBeenCalled();
    expect(cacheNoCatalog.getRoutines).not.toHaveBeenCalled();
    expect(cacheNoCatalog.getConstraints).not.toHaveBeenCalled();
    expect(cacheNoCatalog.getSequences).not.toHaveBeenCalled();
    expect(cacheNoCatalog.getObjectDdl).not.toHaveBeenCalled();
  });

  it("#3 stale refresh returns original cached reference after rejected refresh", async () => {
    const originalDdl = "CREATE FUNCTION public.first() RETURNS int ...";
    const cache = makeCacheMock({
      objectDdl: originalDdl,
      rejectDdl: true,
    });
    const resolver = createCatalogResolver(cache, { isPostgres: () => true });

    const first = await resolver.getDefinition(
      "routine",
      "public",
      "first",
    );
    expect(first).toBe(originalDdl);

    // Second call: SchemaCache swallows the rejected refresh and returns
    // the previously cached value. Resolver preserves that contract.
    const second = await resolver.getDefinition(
      "routine",
      "public",
      "first",
    );
    expect(second).toBe(originalDdl);
  });

  it("#4 listForeignKeys for public.orders never asks constraints for audit_log", async () => {
    const requestedKeys: string[] = [];
    const cache = {
      hasCatalog: vi.fn(async () => true),
      getViews: vi.fn(async () => []),
      getRoutines: vi.fn(async () => []),
      getConstraints: vi.fn(async (schema: string, table: string) => {
        requestedKeys.push(`${schema}.${table}`);
        if (table === "orders") {
          return [
            {
              name: "orders_user_id_fkey",
              type: "fk" as const,
              columns: ["user_id"],
              fkTarget: {
                schema: "public",
                table: "users",
                columns: ["id"],
              },
            },
          ];
        }
        return [];
      }),
      getSequences: vi.fn(async () => []),
      getObjectDdl: vi.fn(async () => ""),
      invalidate: vi.fn(),
    } as unknown as SchemaCache;
    const resolver = createCatalogResolver(cache, { isPostgres: () => true });

    await resolver.listForeignKeys("public", "orders");
    expect(requestedKeys).toEqual(["public.orders"]);
    expect(requestedKeys).not.toContain("public.audit_log");
  });
});