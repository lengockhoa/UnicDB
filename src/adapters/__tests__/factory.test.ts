// src/adapters/__tests__/factory.test.ts
// Unit tests cho createAdapter — TASK-003 §Test Files.
// Factory must return the concrete adapter for all three drivers.
import { describe, it, expect } from "vitest";
import { createAdapter } from "../factory";
import { BigQueryAdapter } from "../bigquery";
import { MsSqlAdapter } from "../mssql";
import { MySqlAdapter } from "../mysql";
import { PostgresAdapter } from "../postgres";
import type { ConnectionConfig } from "../../config/types";
import type { BigQueryConnectionFields } from "../../config/types";

function cfg(driver: ConnectionConfig["driver"]): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver,
    host: "127.0.0.1",
    port: 5433,
    user: "UnicDB",
    database: "UnicDB",
  };
}

/** Valid BigQuery cfg per TASK-BQ01-001 (validator passes). */
function bqCfg(overrides: {
  billingProject?: string;
  location?: string;
} = {}): ConnectionConfig {
  const bigquery: BigQueryConnectionFields = {
    billingProject: overrides.billingProject ?? "proj-billing",
  };
  if (overrides.location !== undefined) {
    bigquery.location = overrides.location;
  }
  return {
    id: "c1",
    name: "bq-test",
    driver: "bigquery",
    host: "",
    port: 0,
    user: "",
    database: "",
    bigquery,
  };
}

describe("createAdapter — factory", () => {
  it("postgres → trả về PostgresAdapter", () => {
    const a = createAdapter(cfg("postgres"), "UnicDB");
    expect(a).toBeInstanceOf(PostgresAdapter);
  });

  it("mysql → trả về MySqlAdapter", () => {
    const a = createAdapter(cfg("mysql"), "UnicDB");
    expect(a).toBeInstanceOf(MySqlAdapter);
  });

  it("mssql → trả về MsSqlAdapter", () => {
    const a = createAdapter(cfg("mssql"), "UnicDBPass123!");
    expect(a).toBeInstanceOf(MsSqlAdapter);
  });

  it("factory export trả về object implement DbAdapter interface", () => {
    const a = createAdapter(cfg("postgres"), "UnicDB");
    // Duck-type: phải có các method đặc trưng.
    expect(typeof a.connect).toBe("function");
    expect(typeof a.close).toBe("function");
    expect(typeof a.listSchemas).toBe("function");
    expect(typeof a.listTables).toBe("function");
    expect(typeof a.listViews).toBe("function");
    expect(typeof a.listRoutines).toBe("function");
    expect(typeof a.listColumns).toBe("function");
    expect(typeof a.testConnection).toBe("function");
  });
});

// ---- TASK-BQ01-003 — bigquery admission through the factory ------------------
// The factory must admit `driver: "bigquery"` and return a `BigQueryAdapter`,
// preserving the `never` exhaustiveness arm. BigQuery must NOT have a
// host/port/password path through the factory.
describe("createAdapter — TASK-BQ01-003 bigquery admission", () => {
  it("bigquery → trả về BigQueryAdapter (ignores password argument)", () => {
    const a = createAdapter(bqCfg({}), "");
    expect(a).toBeInstanceOf(BigQueryAdapter);
    // The factory MUST NOT throw / refuse even when an empty password is passed
    // (BCP: callers — including ConnectionManager — pass "" for bigquery).
  });

  it("bigquery → duck-type DbAdapter surface (connect/close/runQuery/testConnection/listSchemas)", () => {
    const a = createAdapter(bqCfg({}), "");
    expect(typeof a.connect).toBe("function");
    expect(typeof a.close).toBe("function");
    expect(typeof a.runQuery).toBe("function");
    expect(typeof a.testConnection).toBe("function");
    expect(typeof a.listSchemas).toBe("function");
  });
});
