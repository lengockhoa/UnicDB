// src/core/__tests__/sslOptions.test.ts
// Test hợp đồng resolveSslOptions / normalizeSslMode — SSL support DataGrip-style.
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

function tmpCert(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsdb-ssl-"));
  const p = path.join(dir, "c.pem");
  fs.writeFileSync(p, content);
  return p;
}

describe("normalizeSslMode — legacy mapping", () => {
  it("ssl:true cũ → require", () => {
    expect(normalizeSslMode(cfg({ ssl: true } as Partial<ConnectionConfig>))).toBe("require");
  });

  it("sslMode legacy 'prefer' → require, 'verify' → verify-ca", () => {
    expect(
      normalizeSslMode(cfg({ sslMode: "prefer" } as Partial<ConnectionConfig>)),
    ).toBe("require");
    expect(
      normalizeSslMode(cfg({ sslMode: "verify" } as Partial<ConnectionConfig>)),
    ).toBe("verify-ca");
  });

  it("mode mới giữ nguyên", () => {
    expect(normalizeSslMode(cfg({ sslMode: "verify-ca" }))).toBe("verify-ca");
    expect(normalizeSslMode(cfg({ sslMode: "verify-full" }))).toBe("verify-full");
  });

  it("không gì → disable", () => {
    expect(normalizeSslMode(cfg({}))).toBe("disable");
  });
});

describe("resolveSslOptions — mode semantics", () => {
  it("disable → undefined", () => {
    expect(resolveSslOptions(cfg({ sslMode: "disable" }))).toBeUndefined();
  });

  it("require → TLS, không verify, KHÔNG đọc CA dù có path", () => {
    const ssl = resolveSslOptions(cfg({ sslMode: "require", sslCaPath: "/nonexistent" }));
    expect(ssl!.rejectUnauthorized).toBe(false);
    expect(ssl!.checkHostname).toBe(false);
    expect(ssl!.ca).toBeUndefined();
  });

  it("require + client cert → cert vẫn nạp (Cloud SQL cần client cert)", () => {
    const cert = tmpCert("CERT");
    const key = tmpCert("KEY");
    const ssl = resolveSslOptions(cfg({ sslMode: "require", sslCertPath: cert, sslKeyPath: key }));
    expect(ssl!.cert).toBe("CERT");
    expect(ssl!.key).toBe("KEY");
    expect(ssl!.rejectUnauthorized).toBe(false);
    fs.rmSync(path.dirname(cert), { recursive: true, force: true });
    fs.rmSync(path.dirname(key), { recursive: true, force: true });
  });

  it("verify-ca → verify chain nhưng KHÔNG check hostname (proxy localhost)", () => {
    const ca = tmpCert("CA");
    const ssl = resolveSslOptions(cfg({ sslMode: "verify-ca", sslCaPath: ca }));
    expect(ssl!.rejectUnauthorized).toBe(true);
    expect(ssl!.checkHostname).toBe(false);
    expect(ssl!.ca).toBe("CA");
    fs.rmSync(path.dirname(ca), { recursive: true, force: true });
  });

  it("verify-full → verify chain + hostname", () => {
    const ssl = resolveSslOptions(cfg({ sslMode: "verify-full" }));
    expect(ssl!.rejectUnauthorized).toBe(true);
    expect(ssl!.checkHostname).toBe(true);
  });

  it("verify-ca với CA path không tồn tại → throw lỗi rõ ràng", () => {
    expect(() =>
      resolveSslOptions(cfg({ sslMode: "verify-ca", sslCaPath: "/nonexistent/ca.pem" })),
    ).toThrow(/không đọc được SSL CA file/);
  });
});

describe("wantsTls", () => {
  it("disable → false; require/verify-ca/verify-full → true", () => {
    expect(wantsTls(cfg({ sslMode: "disable" }))).toBe(false);
    expect(wantsTls(cfg({ sslMode: "require" }))).toBe(true);
    expect(wantsTls(cfg({ sslMode: "verify-ca" }))).toBe(true);
    expect(wantsTls(cfg({ sslMode: "verify-full" }))).toBe(true);
  });
});
