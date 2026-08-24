// src/ui/__tests__/permissionDetail.test.ts — TASK-001 sanitizer unit tests.
//
// Pure unit tests over `buildPermissionToolInfo`. No vscode imports — these run
// in node (vitest default environment).
//
// Cases cover: SQL preview, pretty-JSON fallback, 2000-char cap with marker,
// malformed/missing inputs returning empty fields, and secret-like key
// redaction. The sanitizer MUST be total over `unknown` — never throws.
import { describe, it, expect } from "vitest";
import {
  buildPermissionToolInfo,
  PERMISSION_DETAIL_CAP,
} from "../permissionDetail";

describe("buildPermissionToolInfo — TASK-001 sanitizer", () => {
  it("#1 SQL preview for run_sql: detail === 'SQL:\\nSELECT 1 FROM t'", () => {
    const info = buildPermissionToolInfo({
      id: "t1",
      name: "run_sql",
      arguments: { sql: "SELECT 1 FROM t" },
    });
    expect(info.id).toBe("t1");
    expect(info.name).toBe("run_sql");
    expect(info.detail).toBe("SQL:\nSELECT 1 FROM t");
  });

  it("#2 pretty JSON fallback for non-DB tools (full args stringify)", () => {
    const info = buildPermissionToolInfo({
      name: "describe_table",
      args: { schema: "public", table: "users" },
    });
    // Expected asserts FULL args stringify — not just schema.
    expect(info.detail).toBe(
      JSON.stringify({ schema: "public", table: "users" }, null, 2),
    );
  });

  it("#3 >2000-char detail is capped with '… (truncated)' marker", () => {
    const huge = "SELECT '" + "x".repeat(5000) + "' AS v";
    const info = buildPermissionToolInfo({
      name: "run_sql",
      arguments: { sql: huge },
    });
    expect(info.detail.length).toBeLessThanOrEqual(
      PERMISSION_DETAIL_CAP + "… (truncated)".length,
    );
    expect(info.detail.endsWith("… (truncated)")).toBe(true);
    // The cap leaves room for the marker; original payload prefix preserved.
    expect(info.detail).toContain("SELECT '");
  });

  it("#4 malformed inputs never throw; empty fields when no usable data", () => {
    expect(buildPermissionToolInfo(null)).toEqual({
      id: "",
      name: "",
      detail: "",
    });
    expect(buildPermissionToolInfo(42)).toEqual({
      id: "",
      name: "",
      detail: "",
    });
    expect(buildPermissionToolInfo({ detail: 42 })).toEqual({
      id: "",
      name: "",
      detail: "",
    });
    expect(buildPermissionToolInfo({ name: "x" })).toEqual({
      id: "",
      name: "x",
      detail: "",
    });
  });

  it("#5 secret-like keys are redacted to '[redacted]' in output", () => {
    const info = buildPermissionToolInfo({
      name: "describe_table",
      arguments: { sql: "SELECT 1", api_key: "sk-1" },
    });
    expect(info.detail).toContain("[redacted]");
    expect(info.detail).not.toContain("sk-1");
    // Non-secret values preserved.
    expect(info.detail).toContain("SELECT 1");
  });
});
