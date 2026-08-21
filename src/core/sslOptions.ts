// src/core/sslOptions.ts
// Resolve SSL options từ ConnectionConfig cho 3 driver (pg / mysql2 / tedious).
//
// Các driver nhận TLS options khác nhau:
//   - pg:        ssl: false | { ca, cert, key, rejectUnauthorized, servername }
//   - mysql2:    ssl: { ca, cert, key, rejectUnauthorized }  (bỏ ssl = plaintext)
//   - tedious:   cryptoCredentialsDetails: { ca, cert, key } + trustServerCertificate
//
// sslMode semantics:
//   disable       → không TLS (undefined — caller bỏ option).
//   prefer        → TLS, không verify (self-signed OK). Có CA file thì vẫn load (dùng cho SNI pool).
//   verify        → TLS, verify server cert với CA file (nếu có), ngược lại system CA store.
//   verify-full   → verify + client cert/key (mutual TLS) nếu các path được khai báo.
//
// File đọc bằng fs.readFileSync tại thời điểm connect (không cache) — user sửa
// file cert thì lần connect kế tiếp nhận bản mới. Path không tồn tại → throw
// lỗi rõ ràng để form hiển thị thay vì TLS handshake fail mơ hồ.
import * as fs from "fs";
import type { ConnectionConfig, SslMode } from "../config/types";

/** Options TLS đã resolve, driver-agnostic. */
export interface ResolvedSsl {
  /** Nội dung CA pem (nếu sslCaPath khai báo và file đọc được). */
  ca?: string;
  /** Nội dung client cert pem. */
  cert?: string;
  /** Nội dung client key pem. */
  key?: string;
  /** Verify server cert chain. false cho "prefer", true cho verify/verify-full. */
  rejectUnauthorized: boolean;
}

function readFileOptional(label: string, path: string | undefined): string | undefined {
  if (!path || path.trim() === "") return undefined;
  try {
    return fs.readFileSync(path.trim(), "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(
      `VSDB: không đọc được SSL ${label} file "${path}": ${reason}. ` +
        `Kiểm tra đường dẫn trong connection settings.`,
    );
  }
}

/** True nếu cfg yêu cầu TLS (sslMode legacy `ssl:true` map sang prefer). */
export function wantsTls(cfg: ConnectionConfig): boolean {
  return normalizeSslMode(cfg) !== "disable";
}

/**
 * Normalize: config cũ lưu `ssl: boolean` (không có sslMode) → map
 * true → "prefer", false/undefined → "disable". Config mới ưu tiên sslMode.
 */
export function normalizeSslMode(cfg: ConnectionConfig): SslMode {
  if (cfg.sslMode) return cfg.sslMode;
  return (cfg as { ssl?: boolean }).ssl === true ? "prefer" : "disable";
}

/**
 * Resolve TLS options. Trả về undefined khi không TLS.
 * Throw Error khi cert file path không đọc được.
 */
export function resolveSslOptions(cfg: ConnectionConfig): ResolvedSsl | undefined {
  const mode = normalizeSslMode(cfg);
  if (mode === "disable") return undefined;

  // CA chỉ có nghĩa khi verify (prefer không check chain — bỏ qua, không đọc file).
  const ca =
    mode === "verify" || mode === "verify-full"
      ? readFileOptional("CA", cfg.sslCaPath)
      : undefined;
  const cert =
    mode === "verify-full" ? readFileOptional("client cert", cfg.sslCertPath) : undefined;
  const key =
    mode === "verify-full" ? readFileOptional("client key", cfg.sslKeyPath) : undefined;

  return {
    ...(ca !== undefined ? { ca } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
    rejectUnauthorized: mode === "verify" || mode === "verify-full",
  };
}
