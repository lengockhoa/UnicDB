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
  ssl?: boolean;
}

/**
 * Một statement SQL đã được parser tách ra.
 * - `text`: nội dung statement (đã strip comment, đã trim nếu là whitespace ngoài).
 *   Trong task này ta GIỮ text nguyên vị trí (substring(start, end) === text),
 *   KHÔNG trim — để caller quyết định.
 * - `start` / `end`: character offset trong chuỗi SQL gốc (start inclusive, end exclusive).
 */
export interface ParsedStatement {
  text: string;
  start: number;
  end: number;
}