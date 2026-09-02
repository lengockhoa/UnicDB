// src/adapters/factory.ts
// createAdapter — switch theo cfg.driver.
import type { ConnectionConfig } from "../config/types";
import { BigQueryAdapter } from "./bigquery";
import { MsSqlAdapter } from "./mssql";
import { MySqlAdapter } from "./mysql";
import { PostgresAdapter } from "./postgres";
import { NotImplementedError, type DbAdapter } from "./types";

/**
 * Tạo adapter cho driver chỉ định.
 * @param cfg     ConnectionConfig (TASK-002) — KHÔNG chứa password.
 * @param password Mật khẩu DB lấy từ SecretStorage (TASK-005 sẽ inject).
 *                 Ignored for `driver === "bigquery"` — BigQuery uses ADC,
 *                 not a per-connection password (BQ-01 contract).
 */
export function createAdapter(cfg: ConnectionConfig, password: string): DbAdapter {
  switch (cfg.driver) {
    case "postgres":
      return new PostgresAdapter(cfg, password);
    case "mysql":
      return new MySqlAdapter(cfg, password);
    case "mssql":
      return new MsSqlAdapter(cfg, password);
    case "bigquery":
      // TASK-BQ01-003 — BigQueryAdapter takes (cfg, factory) — no password.
      // The `password` arg is intentionally ignored; callers (ConnectionManager)
      // pass "" for bigquery connections.
      return new BigQueryAdapter(cfg);
    default: {
      const _exhaustive: never = cfg.driver;
      throw new NotImplementedError(String(_exhaustive));
    }
  }
}