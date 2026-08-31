// src/ai/__tests__/engineChoice.test.ts — TASK-AIX05-003
//
// Reason → hint mapping for resolveEngine(): each of the four
// `detection.reason` values from `detectOmp()` must map to the correct
// hint (INSTALL_HINT vs UPDATE_HINT). Builtin path is the only fallback;
// `omp ok` is pinned separately.
import { describe, it, expect } from "vitest";
import { resolveEngine } from "../engineChoice";
import {
  OMP_INSTALL_HINT,
  OMP_UPDATE_HINT,
  type OmpDetection,
} from "../omp/detect";

function det(over: Partial<OmpDetection>): OmpDetection {
  return { available: false, ok: false, ...over };
}

describe("resolveEngine — AIX-05 reason → hint mapping", () => {
  it("not-installed → INSTALL_HINT", () => {
    const c = resolveEngine({
      detection: det({ reason: "not-installed" }),
      config: null,
    });
    expect(c.engine).toBe("builtin");
    expect(c.hint).toBe(OMP_INSTALL_HINT);
    expect(c.requiresConfig).toBe(true);
  });

  it("version-too-old → UPDATE_HINT", () => {
    const c = resolveEngine({
      detection: det({
        available: true,
        reason: "version-too-old",
        version: "16.0.0",
      }),
      config: null,
    });
    expect(c.engine).toBe("builtin");
    expect(c.hint).toBe(OMP_UPDATE_HINT);
  });

  it("version-unknown → INSTALL_HINT (binary present but version unreadable)", () => {
    const c = resolveEngine({
      detection: det({ available: true, reason: "version-unknown", path: "/usr/bin/omp" }),
      config: null,
    });
    expect(c.engine).toBe("builtin");
    expect(c.hint).toBe(OMP_INSTALL_HINT);
  });

  it("spawn-failed → INSTALL_HINT", () => {
    const c = resolveEngine({
      detection: det({ reason: "spawn-failed", path: "/usr/bin/omp" }),
      config: null,
    });
    expect(c.engine).toBe("builtin");
    expect(c.hint).toBe(OMP_INSTALL_HINT);
  });

  it("omp ok ⇒ engine=omp regardless of config (no hint)", () => {
    const c = resolveEngine({
      detection: { available: true, ok: true, path: "/usr/bin/omp", version: "18.0.1" },
      config: { someConfig: true },
    });
    expect(c.engine).toBe("omp");
    expect(c.hint).toBeUndefined();
    expect(c.requiresConfig).toBe(false);
    expect(c.version).toBe("18.0.1");
    expect(c.path).toBe("/usr/bin/omp");
  });

  it("omp unavailable + non-null config: builtin with hint, requiresConfig=false", () => {
    const c = resolveEngine({
      detection: det({ reason: "not-installed" }),
      config: { baseUrl: "https://example", apiKey: "x", model: "gpt" },
    });
    expect(c.engine).toBe("builtin");
    expect(c.hint).toBe(OMP_INSTALL_HINT);
    expect(c.requiresConfig).toBe(false);
  });
});
