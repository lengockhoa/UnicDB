// src/adapters/__tests__/capabilities.test.ts
//
// TASK-DBX08-001 — declared adapter capability matrix:
//  - production adapters declare the all-supported (postgres) vs all-unsupported
//    (mysql/mssql) DBX-08 matrix, and PostgreSQL's declarations agree with its
//    existing readonly `catalog`/`admin` API members while mysql/mssql expose
//    neither.
//  - hasAdapterCapability() fails closed: missing, partial, or false
//    declarations are NEVER admitted, and structural presence of
//    `catalog`/`admin` alone grants nothing.
//  - production declarations are immutable: an attempted write cannot turn a
//    false capability into advertised support.
//
// Pattern: adapters are instantiated WITHOUT connect() — every constructor only
// stores (cfg, password) and opens its pool/connection lazily, so no
// pg/mysql2/tedious module mock is required (same fixtures as postgres.test.ts
// / mysql.integration.test.ts / mssql.parameterized.test.ts).

import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import { MySqlAdapter } from "../mysql";
import { MsSqlAdapter } from "../mssql";
import { PostgresAdapter } from "../postgres";
import {
  hasAdapterCapability,
  type AdapterCapabilities,
  type AdapterCapability,
  type DbAdapter,
} from "../types";

const ALL_CAPABILITIES: readonly AdapterCapability[] = [
  "catalog",
  "objectDdl",
  "tableDdl",
  "admin",
];

function cfg(driver: ConnectionConfig["driver"]): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver,
    host: "127.0.0.1",
    port: 5432,
    user: "vsdb",
    database: "vsdb",
  };
}

describe("TASK-DBX08-001 — adapter capability matrix", () => {
  it("production adapters declare the DBX-08 advanced capability matrix", () => {
    const postgres = new PostgresAdapter(cfg("postgres"), "pw");
    const mysql = new MySqlAdapter(cfg("mysql"), "pw");
    const mssql = new MsSqlAdapter(cfg("mssql"), "pw");

    for (const capability of ALL_CAPABILITIES) {
      expect(hasAdapterCapability(postgres, capability)).toBe(true);
      expect(hasAdapterCapability(mysql, capability)).toBe(false);
      expect(hasAdapterCapability(mssql, capability)).toBe(false);
    }

    // Declaration ↔ API agreement: PostgreSQL still exposes its existing
    // catalog/admin objects; mysql/mssql expose neither (and no backend is
    // invented here).
    expect(postgres.catalog).toBeDefined();
    expect(postgres.admin).toBeDefined();
    expect((mysql as DbAdapter).catalog).toBeUndefined();
    expect((mysql as DbAdapter).admin).toBeUndefined();
    expect((mssql as DbAdapter).catalog).toBeUndefined();
    expect((mssql as DbAdapter).admin).toBeUndefined();
  });

  it("hasAdapterCapability fails closed for legacy and partial adapters", () => {
    // Legacy adapter shape with NO capabilities declaration at all.
    const legacy = {} as Pick<DbAdapter, "capabilities">;
    // Partial declaration — only one key present.
    const partial = {
      capabilities: { catalog: true },
    } as Pick<DbAdapter, "capabilities">;
    // Explicit false everywhere.
    const explicitFalse = {
      capabilities: {
        catalog: false,
        objectDdl: false,
        tableDdl: false,
        admin: false,
      },
    } as Pick<DbAdapter, "capabilities">;
    // Structural catalog/admin API presence WITHOUT any declaration — must
    // never be read as support.
    const structuralOnly = {
      catalog: {},
      admin: {},
    } as unknown as Pick<DbAdapter, "capabilities">;
    // Truthy non-boolean junk (e.g. 1) is not an explicit `true`.
    const truthyJunk = {
      capabilities: { catalog: 1 as unknown as boolean },
    } as Pick<DbAdapter, "capabilities">;

    for (const capability of ALL_CAPABILITIES) {
      expect(hasAdapterCapability(null, capability)).toBe(false);
      expect(hasAdapterCapability(undefined, capability)).toBe(false);
      expect(hasAdapterCapability(legacy, capability)).toBe(false);
      expect(hasAdapterCapability(structuralOnly, capability)).toBe(false);
      expect(hasAdapterCapability(explicitFalse, capability)).toBe(false);
    }
    expect(hasAdapterCapability(partial, "catalog")).toBe(true);
    expect(hasAdapterCapability(partial, "objectDdl")).toBe(false);
    expect(hasAdapterCapability(partial, "tableDdl")).toBe(false);
    expect(hasAdapterCapability(partial, "admin")).toBe(false);
    expect(hasAdapterCapability(truthyJunk, "catalog")).toBe(false);
  });

  it("production declarations cannot be mutated into advertised support", () => {
    const unsupported = [
      new MySqlAdapter(cfg("mysql"), "pw"),
      new MsSqlAdapter(cfg("mssql"), "pw"),
    ];

    for (const adapter of unsupported) {
      // Test-only cast to strip readonly — simulates the strongest mutation
      // attempt a consumer could make against the declared matrix.
      const writable = adapter.capabilities as {
        -readonly [K in keyof AdapterCapabilities]: AdapterCapabilities[K];
      };
      let mutationRejected = false;
      try {
        writable.catalog = true;
        writable.admin = true;
      } catch {
        // Strict-mode write to a frozen declaration throws TypeError —
        // an acceptable outcome; the invariant is that support is NOT
        // advertised afterwards either way.
        mutationRejected = true;
      }

      expect(hasAdapterCapability(adapter, "catalog")).toBe(false);
      expect(hasAdapterCapability(adapter, "admin")).toBe(false);
      expect(adapter.capabilities.catalog).toBe(false);
      expect(adapter.capabilities.admin).toBe(false);
      expect(mutationRejected || writable.catalog === false).toBe(true);
    }
  });
});
