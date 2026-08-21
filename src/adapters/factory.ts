// src/adapters/factory.ts
// createAdapter — switch theo cfg.driver. TASK-003 chỉ có postgres case;
// mysql/mssql ném NotImplementedError (TASK-004 sẽ extend).
import type { ConnectionConfig } from "../config/types";
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
    case "mssql":
      throw new NotImplementedError(cfg.driver);
    default: {
      const _exhaustive: never = cfg.driver;
      throw new NotImplementedError(String(_exhaustive));
    }
  }
}