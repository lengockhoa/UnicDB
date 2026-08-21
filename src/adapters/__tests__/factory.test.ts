// src/adapters/__tests__/factory.test.ts
// Unit tests cho createAdapter — TASK-003 §Test Files.
// Factory must return the concrete adapter for all three drivers.
import { describe, it, expect } from "vitest";
import { createAdapter } from "../factory";
import { MsSqlAdapter } from "../mssql";
import { MySqlAdapter } from "../mysql";
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

  it("mysql → trả về MySqlAdapter", () => {
    const a = createAdapter(cfg("mysql"), "vsdb");
    expect(a).toBeInstanceOf(MySqlAdapter);
  });

  it("mssql → trả về MsSqlAdapter", () => {
    const a = createAdapter(cfg("mssql"), "VsdbPass123!");
    expect(a).toBeInstanceOf(MsSqlAdapter);
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
