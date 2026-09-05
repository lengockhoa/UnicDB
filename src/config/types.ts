// src/config/types.ts
// Types dùng chung cho UnicDB. TASK-002 định nghĩa, TASK-003..007 consume.

/**
 * Driver DB mà UnicDB hỗ trợ.
 * - postgres: PostgreSQL (pg)
 * - mysql: MySQL / MariaDB (mysql2)
 * - mssql: SQL Server (tedious)
 * - bigquery: Google BigQuery (BQ-00 boundary; config-only — NO credentials).
 */
export type DriverType = "postgres" | "mysql" | "mssql" | "bigquery";

/**
 * Cấu hình kết nối DB do user tạo qua SecretStorage / WorkspaceState.
 * Password KHÔNG lưu ở đây — lưu riêng trong SecretStorage (TASK-005).
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverType;
  host: string;
  port: number;
  user: string;
  database: string;
  /**
   * SSL mode (semantics giống DataGrip / libpq):
   * - "disable"     — plaintext (mặc định, như ssl:false cũ).
   * - "require"     — TLS, KHÔNG verify cert (chấp nhận self-signed — như DataGrip "Require").
   * - "verify-ca"   — TLS, verify cert chain với CA (file hoặc system store),
   *                    KHÔNG kiểm tra hostname — cho Cloud SQL proxy/AWS RDS proxy qua localhost.
   * - "verify-full" — verify chain + hostname + client cert nếu có.
   *
   * Client cert/key (sslCertPath/sslKeyPath) NẠP ĐỘC LẬP với mode — Cloud SQL
   * cần client cert kể cả khi không verify hostname.
   * Legacy: "prefer" (map require), "verify" (map verify-ca).
   */
  sslMode?: SslMode;
  /** Đường dẫn file CA (.pem) để verify server cert. */
  sslCaPath?: string;
  /** Đường dẫn client certificate (.pem) cho mutual TLS. */
  sslCertPath?: string;
  /** Đường dẫn client private key cho mutual TLS. */
  sslKeyPath?: string;
  /** Keep saves in an explicit transaction until the user commits or rolls back. */
  manualCommit?: boolean;
  /** DBX-05: folder name for tree grouping (absent = ungrouped, shown at root). */
  folder?: string;
  /** DBX-05: palette color override for the folder/connection icon (hex). */
  color?: string;
  /** DBX-05: read-only intent — client-side mutation block BEFORE any network I/O. */
  readOnly?: boolean;
  /** DBX-05: SSH tunnel settings — when set, the adapter connects via 127.0.0.1:<localPort>. */
  tunnel?: {
    host: string;
    port?: number;
    user?: string;
    identityFile?: string;
  };
  /**
   * BQ-01 — BigQuery-only safe metadata. ONLY present when `driver === "bigquery"`.
   * Carries NO credential-shaped field by construction (no `credentials`, no
   * `keyFilename`, no `token`, no `password`) — ADC is external to this module
   * (BQ-00 boundary in `src/adapters/bigqueryAdc.ts`).
   */
  bigquery?: BigQueryConnectionFields;
}

/**
 * BQ-01 — safe metadata sub-object for a BigQuery connection. By design,
 * every field here is either a project identifier or a cost control —
 * NEVER a credential. ADC is fetched externally (`createBigQueryClient` in
 * BQ-00) and never enters this config layer.
 */
export interface BigQueryConnectionFields {
  /** GCP project ID that owns the billing for query jobs. REQUIRED. */
  billingProject: string;
  /** BigQuery location / region (e.g. "US", "EU", "us-central1"). */
  location?: string;
  /**
   * Cost control — maximum bytes billed per query. Canonical digit-string
   * (NOT a JS `number`) because byte counts can exceed
   * `Number.MAX_SAFE_INTEGER` and this matches BQ-00's string-bytes
   * discipline (`totalBytesBilled: string` in `bigqueryTypes.ts`).
   */
  maxBytesBilled?: string;
  /** Dataset-project override when it differs from `billingProject`. */
  datasetProject?: string;
}

export type SslMode = "disable" | "require" | "verify-ca" | "verify-full";

/**
 * BQ-01 — pure validation result envelope.
 * Discriminated by `ok`; `reason` is only meaningful when `ok === false`.
 */
export type BigQueryValidation = { ok: true } | { ok: false; reason: string };

/**
 * BQ-01 — pure validator for `driver === "bigquery"` connections.
 *
 * Rules enforced (per task §Test Cases):
 *  - R1  `driver === "bigquery"` requires `bigquery` sub-object.
 *  - R2  `bigquery.billingProject` MUST be a non-empty, non-whitespace string.
 *  - R3  `bigquery.maxBytesBilled` (when present) MUST be a canonical
 *       digit-string of a positive integer (rejects "", "abc", "-5", "0",
 *       "1.5", "1e9", etc.).
 *  - R4  For BQ connections, `host`, `port`, `user`, `database` MUST be empty
 *       / zero — BQ has no notion of these and a non-empty value indicates
 *       a mis-pasted legacy config.
 *  - C0  Non-bigquery drivers pass through `{ok:true}` untouched.
 *
 * The function is PURE: no imports from `vscode` or `@google-cloud/bigquery`,
 * no I/O, no exceptions thrown. ADC remains external (BQ-00 seam).
 */
export function validateBigQueryConnection(
  cfg: ConnectionConfig,
): BigQueryValidation {
  // C0 — legacy 3-driver configs: the BQ validator is OPT-IN; non-bq drivers
  //      are not the validator's concern and pass through.
  if (cfg.driver !== "bigquery") {
    return { ok: true };
  }

  // R1 — must carry the sub-object.
  const bq = cfg.bigquery;
  if (!bq) {
    return { ok: false, reason: "BigQuery connection must carry a `bigquery` sub-object with `billingProject`." };
  }

  // R2 — billingProject non-empty / non-whitespace.
  if (typeof bq.billingProject !== "string" || bq.billingProject.trim().length === 0) {
    return { ok: false, reason: "BigQuery billing project is required and must be non-empty." };
  }

  // R3 — maxBytesBilled, when present, is a canonical digit-string > 0.
  if (bq.maxBytesBilled !== undefined) {
    const s = bq.maxBytesBilled;
    if (typeof s !== "string" || !/^[1-9]\d*$/.test(s)) {
      return {
        ok: false,
        reason:
          "BigQuery `maxBytesBilled` must be a canonical positive digit-string (no sign, no decimals, no exponent, not zero).",
      };
    }
  }

  // R4 — host/port/user/database MUST be empty for BQ.
  if (cfg.host !== "") {
    return {
      ok: false,
      reason: "BigQuery connections must leave `host` empty; set `bigquery.location` instead.",
    };
  }
  if (cfg.port !== 0) {
    return {
      ok: false,
      reason: "BigQuery connections must leave `port` at 0; BigQuery has no port.",
    };
  }
  if (cfg.user !== "") {
    return {
      ok: false,
      reason: "BigQuery connections must leave `user` empty; authentication is via Application Default Credentials.",
    };
  }
  if (cfg.database !== "") {
    return {
      ok: false,
      reason: "BigQuery connections must leave `database` empty; set `bigquery.datasetProject` if it differs from `billingProject`.",
    };
  }

  return { ok: true };
}

/**
 * Một statement SQL đã được parser tách ra.
 * - `text`: nội dung statement NHƯ TRONG SQL GỐC (giữ nguyên vị trí,
 *   KHÔNG trim, KHÔNG strip comment — caller tự quyết định xử lý tiếp).
 *   Đảm bảo `sql.substring(start, end) === text` (zero-copy substring).
 * - `start` / `end`: character offset trong chuỗi SQL gốc (start inclusive, end exclusive).
 *   Statement rỗng (chỉ whitespace + comment) sẽ KHÔNG xuất hiện trong output.
 */
export interface ParsedStatement {
  text: string;
  start: number;
  end: number;
}
