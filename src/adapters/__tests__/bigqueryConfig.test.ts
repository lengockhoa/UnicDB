// src/adapters/__tests__/bigqueryConfig.test.ts
//
// TASK-BQ01-001 — pure BigQuery connection-config validator tests.
//
// The source under test (`src/config/types.ts`) is a PURE module: no vscode
// import, no @google-cloud/bigquery import. These tests exercise only the
// shape + validator surface.
//
// Test matrix (TASK §Test Cases, TDD-mandatory):
//   1. happy      — valid bigquery config with billingProject + location validates
//   2. edge-empty — empty / whitespace billingProject rejected
//   3. edge-type  — maxBytesBilled wrong-type / negative / zero rejected
//   4. edge-security — serialization redaction (no credentials / keyFilename / token / password)
//   5. edge-compat   — legacy 3-driver configs untouched by the BQ validator
//   6. edge-rule  — bigquery with non-empty host or non-zero port rejected
import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import {
  validateBigQueryConnection,
  type BigQueryConnectionFields,
  type BigQueryValidation,
} from "../../config/types";

// ---------------------------------------------------------------------------
// Helpers — minimal fixtures (one field per test, no extras).
// ---------------------------------------------------------------------------

/** Build a complete `ConnectionConfig` for a bigquery connection. */
function bqCfg(overrides: {
  id?: string;
  name?: string;
  bigquery?: BigQueryConnectionFields;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
}): ConnectionConfig {
  return {
    id: overrides.id ?? "c1",
    name: overrides.name ?? "test",
    driver: "bigquery",
    host: overrides.host ?? "",
    port: overrides.port ?? 0,
    user: overrides.user ?? "",
    database: overrides.database ?? "",
    bigquery: overrides.bigquery ?? { billingProject: "proj-billing" },
  };
}

// ---------------------------------------------------------------------------
// Test #1 — happy: valid bigquery config with billingProject + location.
// ---------------------------------------------------------------------------

describe("validateBigQueryConnection — happy path", () => {
  it("valid bigquery config with billingProject + location validates", () => {
    const cfg: ConnectionConfig = bqCfg({
      bigquery: { billingProject: "proj-billing", location: "EU" },
    });
    const result: BigQueryValidation = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test #2 — edge-empty: empty / whitespace billingProject rejected.
// ---------------------------------------------------------------------------

describe("validateBigQueryConnection — empty/whitespace billingProject", () => {
  it("rejects empty billingProject", () => {
    const cfg = bqCfg({ bigquery: { billingProject: "" } });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // reason mentions the billing project (case-insensitive substring).
      expect(result.reason.toLowerCase()).toContain("billing project");
    }
  });

  it("rejects whitespace-only billingProject", () => {
    const cfg = bqCfg({ bigquery: { billingProject: "   " } });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("billing project");
    }
  });
});

// ---------------------------------------------------------------------------
// Test #3 — edge-type: maxBytesBilled wrong-type / negative / zero rejected;
//           "1000000" passes.
// ---------------------------------------------------------------------------

describe("validateBigQueryConnection — maxBytesBilled shape", () => {
  it("rejects non-digit maxBytesBilled ('abc')", () => {
    const cfg = bqCfg({
      bigquery: { billingProject: "p", maxBytesBilled: "abc" },
    });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("maxbytesbilled");
    }
  });

  it("rejects negative maxBytesBilled ('-5')", () => {
    const cfg = bqCfg({
      bigquery: { billingProject: "p", maxBytesBilled: "-5" },
    });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("maxbytesbilled");
    }
  });

  it("rejects zero maxBytesBilled ('0')", () => {
    const cfg = bqCfg({
      bigquery: { billingProject: "p", maxBytesBilled: "0" },
    });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("maxbytesbilled");
    }
  });

  it("accepts canonical positive maxBytesBilled ('1000000')", () => {
    const cfg = bqCfg({
      bigquery: { billingProject: "p", maxBytesBilled: "1000000" },
    });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test #4 — edge-security: serialization redaction.
//   JSON.stringify of a valid BQ config MUST contain none of
//   "credentials" / "keyFilename" / "token" / "password" (case-insensitive).
// ---------------------------------------------------------------------------

describe("validateBigQueryConnection — serialization redaction", () => {
  it("JSON.stringify output never contains credentials-shaped fields", () => {
    const cfg: ConnectionConfig = bqCfg({
      bigquery: { billingProject: "proj-billing", location: "EU" },
    });
    const json = JSON.stringify(cfg).toLowerCase();
    // Forbidden substrings — any of these slipping in would leak credentials.
    expect(json.includes("credentials")).toBe(false);
    expect(json.includes("keyfilename")).toBe(false);
    expect(json.includes("token")).toBe(false);
    expect(json.includes("password")).toBe(false);
  });

  it("BigQueryConnectionFields type does not admit credential-shaped keys", () => {
    // Pure type-level probe: the field set is exactly the safe metadata fields.
    const bq: BigQueryConnectionFields = {
      billingProject: "p",
      location: "EU",
      maxBytesBilled: "1000",
      datasetProject: "dp",
    };
    // JSON of these fields alone must also be free of credential substrings.
    const json = JSON.stringify(bq).toLowerCase();
    expect(json.includes("credentials")).toBe(false);
    expect(json.includes("keyfilename")).toBe(false);
    expect(json.includes("token")).toBe(false);
    expect(json.includes("password")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test #5 — edge-compat: legacy 3-driver configs untouched by the BQ validator.
//   A pg fixture mirrors `factory.test.ts` `cfg()`.
// ---------------------------------------------------------------------------

describe("validateBigQueryConnection — legacy 3-driver configs untouched", () => {
  it("postgres config passes validateBigQueryConnection", () => {
    const cfg: ConnectionConfig = {
      id: "c1",
      name: "test",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5433,
      user: "vsdb",
      database: "vsdb",
    };
    const result = validateBigQueryConnection(cfg);
    // The validator is OPT-IN for bigquery; non-bq drivers fall through
    // with `{ok:true}` (validator doesn't reject non-bq configs).
    expect(result.ok).toBe(true);
  });

  it("postgres config typechecks unchanged (host/port/user/database still required)", () => {
    // The assertion is a TYPE-level test: omitting any of host/port/user/database
    // would be a compile error. The runtime side verifies the value passes
    // through the validator without surprise.
    const cfg: ConnectionConfig = {
      id: "c1",
      name: "test",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5433,
      user: "vsdb",
      database: "vsdb",
    };
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(5433);
    expect(cfg.user).toBe("vsdb");
    expect(cfg.database).toBe("vsdb");
    expect(validateBigQueryConnection(cfg).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test #6 — edge-rule: bigquery with non-empty host or non-zero port rejected.
//   Reason mentions host / port.
// ---------------------------------------------------------------------------

describe("validateBigQueryConnection — empty host/port/user/database for bigquery", () => {
  it("rejects non-empty host", () => {
    const cfg = bqCfg({
      host: "bigquery.googleapis.com",
    });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("host");
    }
  });

  it("rejects non-zero port", () => {
    const cfg = bqCfg({
      port: 443,
    });
    const result = validateBigQueryConnection(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("port");
    }
  });
});