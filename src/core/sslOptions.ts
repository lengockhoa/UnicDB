// src/core/sslOptions.ts
// Resolve SSL options từ ConnectionConfig cho 3 driver (pg / mysql2 / tedious).
//
// Semantics theo DataGrip / libpq:
//   disable     — plaintext.
//   require     — TLS, không verify cert (DataGrip "Require").
//   verify-ca   — TLS, verify chain với CA file (hoặc system store), KHÔNG
//                 kiểm hostname. Cho Cloud SQL Auth Proxy / RDS proxy qua
//                 localhost — cert server mang DNS instance, không phải localhost.
//   verify-full — verify chain + hostname (+ client cert nếu có).
//
// Client cert/key nạp ĐỘC LẬP với mode — client authenticate với server bất
// kể user có verify server cert không (Cloud SQL yêu cầu client cert luôn).
//
// Legacy mapping: ssl:true → require; sslMode "prefer" → require, "verify" →
// verify-ca (dữ liệu cũ trong Memento).
//
// File đọc bằng fs.readFileSync tại connect (không cache). Path không đọc
// được → throw lỗi rõ ràng để hiển thị ở form thay vì TLS handshake mơ hồ.
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
  /** Verify server cert chain. false cho require, true cho verify-ca/full. */
  rejectUnauthorized: boolean;
  /**
   * Kiểm hostname trong SAN của server cert. true chỉ với verify-full.
   * verify-ca bỏ qua — driver-level: pg/mysql dùng checkServerIdentity noop.
   */
  checkHostname: boolean;
}

function readCertFile(label: string, path: string | undefined): string | undefined {
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

/**
 * Normalize: legacy ssl:boolean (true → require), sslMode cũ "prefer" →
 * require, "verify" → verify-ca. Config mới ưu tiên sslMode nguyên vẹn.
 */
export function normalizeSslMode(cfg: ConnectionConfig): SslMode {
  const raw: string =
    cfg.sslMode ?? ((cfg as { ssl?: boolean }).ssl === true ? "prefer" : "disable");
  switch (raw) {
    case "disable":
    case "require":
    case "verify-ca":
    case "verify-full":
      return raw;
    case "prefer":
      return "require";
    case "verify":
      return "verify-ca";
    default:
      return "disable";
  }
}

/** True nếu cfg yêu cầu TLS. */
export function wantsTls(cfg: ConnectionConfig): boolean {
  return normalizeSslMode(cfg) !== "disable";
}

/**
 * Resolve TLS options. Trả về undefined khi không TLS.
 * Throw Error khi cert file path không đọc được.
 */
export function resolveSslOptions(cfg: ConnectionConfig): ResolvedSsl | undefined {
  const mode = normalizeSslMode(cfg);
  if (mode === "disable") return undefined;

  // CA chỉ dùng khi verify (require không check chain — bỏ qua, không đọc file).
  const verify = mode === "verify-ca" || mode === "verify-full";
  const ca = verify ? readCertFile("CA", cfg.sslCaPath) : undefined;
  // Client cert/key độc lập với mode (Cloud SQL cần client cert cả khi require).
  const cert = readCertFile("client cert", cfg.sslCertPath);
  const key = readCertFile("client key", cfg.sslKeyPath);

  return {
    ...(ca !== undefined ? { ca } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
    rejectUnauthorized: verify,
    checkHostname: mode === "verify-full",
  };
}
