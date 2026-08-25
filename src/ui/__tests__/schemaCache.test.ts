// src/ui/__tests__/schemaCache.test.ts
// TASK-008 §Test Cases #7-#9 — SchemaCache TTL unit tests.
// SchemaCache is vscode-free (pure adapter wrapper) → no vscode mock needed.
import { describe, it, expect, vi } from "vitest";
import type { DbAdapter, TableInfo } from "../../adapters/types";

import { SchemaCache } from "../schemaCache";

function adapterWith(listTables: ReturnType<typeof vi.fn>): DbAdapter {
  return { listTables } as unknown as DbAdapter;
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
    // Refresh fails → stale data returned, no error thrown.
    await expect(cache.getTables()).resolves.toBe(stale);
  });
});
