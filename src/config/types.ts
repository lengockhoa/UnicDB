// src/config/types.ts
// Types dùng chung cho VSDB. TASK-002 định nghĩa, TASK-003..007 consume.

/**
 * Driver DB mà VSDB hỗ trợ.
 * - postgres: PostgreSQL (pg)
 * - mysql: MySQL / MariaDB (mysql2)
 * - mssql: SQL Server (tedious)
 */
export type DriverType = "postgres" | "mysql" | "mssql";

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
}

export type SslMode = "disable" | "require" | "verify-ca" | "verify-full";

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
