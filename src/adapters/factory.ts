// src/adapters/factory.ts
// createAdapter — switch theo cfg.driver.
import type { ConnectionConfig } from "../config/types";
import { MsSqlAdapter } from "./mssql";
import { MySqlAdapter } from "./mysql";
import { PostgresAdapter } from "./postgres";
import { NotImplementedError, type DbAdapter } from "./types";

/**
 * Tạo adapter cho driver chỉ định.
 * @param cfg     ConnectionConfig (TASK-002) — KHÔNG chứa password.
 * @param password Mật khẩu DB lấy từ SecretStorage (TASK-005 sẽ inject).
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
      // BQ01-001 keeps the `never` exhaustiveness arm valid by acknowledging
      // the new variant. The real adapter case (`return new BigQueryAdapter(cfg)`)
      // is owned by TASK-BQ01-003, which builds on TASK-BQ01-002's adapter.
      throw new NotImplementedError("bigquery");
    default: {
      const _exhaustive: never = cfg.driver;
      throw new NotImplementedError(String(_exhaustive));
    }
  }
}