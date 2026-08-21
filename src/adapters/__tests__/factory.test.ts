// src/adapters/__tests__/factory.test.ts
// Unit tests cho createAdapter — TASK-003 §Test Files.
// Postgres case phải trả PostgresAdapter; mysql/mssql phải throw.
import { describe, it, expect } from "vitest";
import { createAdapter } from "../factory";
import { PostgresAdapter } from "../postgres";
import type { ConnectionConfig } from "../../config/types";

function cfg(driver: ConnectionConfig["driver"]): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver,
    host: "127.0.0.1",
    port: 5433,
    user: "vsdb",
    database: "vsdb",
  };
}

describe("createAdapter — factory", () => {
  it("postgres → trả về PostgresAdapter", () => {
    const a = createAdapter(cfg("postgres"), "vsdb");
    expect(a).toBeInstanceOf(PostgresAdapter);
  });

  it("mysql → throw NotImplementedError", () => {
    expect(() => createAdapter(cfg("mysql"), "vsdb")).toThrowError(
      /NotImplemented|not implemented/i,
    );
  });

  it("mssql → throw NotImplementedError", () => {
    expect(() => createAdapter(cfg("mssql"), "VsdbPass123!")).toThrowError(
      /NotImplemented|not implemented/i,
    );
  });

  it("factory export trả về object implement DbAdapter interface", () => {
    const a = createAdapter(cfg("postgres"), "vsdb");
    // Duck-type: phải có các method đặc trưng.
    expect(typeof a.connect).toBe("function");
    expect(typeof a.close).toBe("function");
    expect(typeof a.runQuery).toBe("function");
    expect(typeof a.listTables).toBe("function");
    expect(typeof a.listViews).toBe("function");
    expect(typeof a.listRoutines).toBe("function");
    expect(typeof a.listColumns).toBe("function");
    expect(typeof a.testConnection).toBe("function");
  });
});