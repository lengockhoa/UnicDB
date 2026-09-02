// src/adapters/__tests__/bigqueryAdc.test.ts
//
// TASK-BQ00-003 — ADC diagnostic classifier + client seam.
//
// Test matrix (REQUIRED, TDD):
//   1. happy  — fake client smoke resolves "ok"; impl = vi.fn() returning a fake,
//      asserted toHaveBeenCalledTimes(1); projectId propagated to options.
//   2. edge   — missing ADC classified with gcloud remediation.
//   3. edge   — denied API (403) vs bad billing project (404) → DISTINCT categories.
//   4. edge   — location_mismatch classified; unrecognized → unknown fallback.
//   5. edge   — redaction: returned diagnostic never echoes the token or any raw substring.
//   6. edge   — null / number / plain object / empty Error never throw.
import { describe, it, expect, vi } from "vitest";
import {
  classifyAdcDiagnostic,
  createBigQueryClient,
  runAdcSmoke,
  type AdcDiagnostic,
  type BigQueryClientLike,
} from "../bigqueryAdc";

describe("TASK-BQ00-003 bigqueryAdc — classifier + seam", () => {
  it("1. fake client smoke resolves ok; injectable impl is observed; projectId propagates", async () => {
    // The injectable impl parameter IS the spy (per task discussion, plan-review
    // Minor 1). No extra mocking library needed.
    const fakeClient: BigQueryClientLike = {
      listDatasets: vi.fn(async () => [{ id: "ds1" }]),
    };
    const impl = vi.fn((opts: { projectId?: string }) => fakeClient);

    const client = createBigQueryClient("proj-abc", impl);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith({ projectId: "proj-abc" });

    const result = await runAdcSmoke(client);
    expect(result).toBe("ok");
    // The fake's listDatasets was awaited exactly once by runAdcSmoke.
    expect(fakeClient.listDatasets).toHaveBeenCalledTimes(1);
  });

  it("2. missing ADC classified with gcloud remediation", () => {
    const synthetic = new Error("Could not load the default credentials.");
    const diag: AdcDiagnostic = classifyAdcDiagnostic(synthetic);
    expect(diag.category).toBe("missing_adc");
    expect(diag.remediation).toMatch(/gcloud auth application-default login/);
  });

  it("3. denied API vs bad billing project — two distinct categories", () => {
    // 403 / Access Denied → api_denied.
    const denied = new Error("Access Denied: Project proj-abc is denied API access.");
    const deniedDiag = classifyAdcDiagnostic(denied);
    expect(deniedDiag.category).toBe("api_denied");

    // 404 / project not found → bad_billing_project.
    const notFound = new Error("Project not found: proj-abc");
    const notFoundDiag = classifyAdcDiagnostic(notFound);
    expect(notFoundDiag.category).toBe("bad_billing_project");

    // The two categories must DIFFER — that's the whole point of the classifier.
    expect(deniedDiag.category).not.toBe(notFoundDiag.category);
  });

  it("4. wrong location classified; unknown falls back", () => {
    const loc = new Error("Dataset ds1 is not found in region EU");
    const locDiag = classifyAdcDiagnostic(loc);
    expect(locDiag.category).toBe("location_mismatch");

    const weird = new Error("something completely unrelated happened");
    const weirdDiag = classifyAdcDiagnostic(weird);
    expect(weirdDiag.category).toBe("unknown");
    expect(typeof weirdDiag.remediation).toBe("string");
    expect(weirdDiag.remediation.length).toBeGreaterThan(0);
  });

  it("5. classifier never echoes raw error text (redaction by construction)", () => {
    // Poison the raw error with a Bearer credential + a unique marker.
    const token = "Bearer abc123";
    const marker = "ZZZ-MARKER-9981";
    const poisoned = new Error(`Request failed: ${token} — context=${marker}`);

    const diag = classifyAdcDiagnostic(poisoned);

    // The token must not appear in either field.
    expect(diag.category).not.toMatch(/abc123/);
    expect(diag.remediation).not.toMatch(/abc123/);
    // The raw-message substring must not appear in either field either.
    expect(diag.category).not.toMatch(/ZZZ-MARKER-9981/);
    expect(diag.remediation).not.toMatch(/ZZZ-MARKER-9981/);
    expect(diag.remediation).not.toMatch(/Bearer/);
  });

  it("6. null/non-Error/non-string inputs never throw", () => {
    const inputs: unknown[] = [null, 42, {}, new Error()];
    for (const input of inputs) {
      // Must not throw.
      let diag: AdcDiagnostic | undefined;
      expect(() => {
        diag = classifyAdcDiagnostic(input);
      }).not.toThrow();
      // Must return a valid AdcDiagnostic with a defined category.
      expect(diag).toBeDefined();
      expect(diag!.category).toBeDefined();
      expect([
        "missing_adc",
        "bad_billing_project",
        "api_denied",
        "location_mismatch",
        "unknown",
      ]).toContain(diag!.category);
      // Remediation must be a non-empty string.
      expect(typeof diag!.remediation).toBe("string");
      expect(diag!.remediation.length).toBeGreaterThan(0);
    }
  });
});