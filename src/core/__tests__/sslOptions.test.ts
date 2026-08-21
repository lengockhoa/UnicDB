// src/core/__tests__/sslOptions.test.ts
// Test hợp đồng resolveSslOptions / normalizeSslMode — SSL support (1.1.0).
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeSslMode, resolveSslOptions, wantsTls } from "../sslOptions";
import type { ConnectionConfig } from "../../config/types";

function cfg(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: "test",
    name: "test",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "u",
    database: "db",
    ...overrides,
  };
}

describe("normalizeSslMode — legacy ssl:boolean mapping", () => {
  it("ssl:true cũ → prefer", () => {
    expect(normalizeSslMode(cfg({ ssl: true } as Partial<ConnectionConfig>))).toBe("prefer");
  });

  it("sslMode mới thắng legacy ssl", () => {
    expect(
      normalizeSslMode(cfg({ ssl: true, sslMode: "verify" } as Partial<ConnectionConfig>)),
    ).toBe("verify");
  });

  it("không gì → disable", () => {
    expect(normalizeSslMode(cfg({}))).toBe("disable");
  });
});

describe("resolveSslOptions", () => {
  it("disable → undefined (không TLS)", () => {
    expect(resolveSslOptions(cfg({ sslMode: "disable" }))).toBeUndefined();
  });

  it("prefer → TLS không verify, không đọc cert files", () => {
    const ssl = resolveSslOptions(cfg({ sslMode: "prefer", sslCaPath: "/nonexistent" }));
    expect(ssl).toBeDefined();
    expect(ssl!.rejectUnauthorized).toBe(false);
    // prefer không verify → path CA không cần đọc được.
    expect(ssl!.ca).toBeUndefined();
  });

  it("verify → rejectUnauthorized true, load CA file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsdb-ssl-"));
    const caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, "FAKE-CA-PEM");
    const ssl = resolveSslOptions(cfg({ sslMode: "verify", sslCaPath: caPath }));
    expect(ssl!.rejectUnauthorized).toBe(true);
    expect(ssl!.ca).toBe("FAKE-CA-PEM");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("verify-full → load cả client cert + key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsdb-ssl-"));
    const mk = (name: string, content: string) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      return p;
    };
    const ssl = resolveSslOptions(
      cfg({
        sslMode: "verify-full",
        sslCaPath: mk("ca.pem", "CA"),
        sslCertPath: mk("cert.pem", "CERT"),
        sslKeyPath: mk("key.pem", "KEY"),
      }),
    );
    expect(ssl).toEqual({ ca: "CA", cert: "CERT", key: "KEY", rejectUnauthorized: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("verify với CA path không tồn tại → throw lỗi rõ ràng", () => {
    expect(() =>
      resolveSslOptions(cfg({ sslMode: "verify", sslCaPath: "/nonexistent/ca.pem" })),
    ).toThrow(/không đọc được SSL CA file/);
  });
});

describe("wantsTls", () => {
  it("disable → false; mọi mode khác → true; legacy ssl:true → true", () => {
    expect(wantsTls(cfg({ sslMode: "disable" }))).toBe(false);
    expect(wantsTls(cfg({ sslMode: "verify" }))).toBe(true);
    expect(wantsTls(cfg({ ssl: true } as Partial<ConnectionConfig>))).toBe(true);
  });
});
