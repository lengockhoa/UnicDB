// src/ai/__tests__/engineChoice.test.ts — TASK-011 (B3): pure resolveEngine matrix.
import { describe, expect, it } from "vitest";
import { resolveEngine } from "../engineChoice";
import { OMP_INSTALL_HINT, OMP_UPDATE_HINT, type OmpDetection } from "../omp/detect";

describe("resolveEngine", () => {
  it("Happy — omp present, no config → engine omp, zero config required", () => {
    const detection: OmpDetection = {
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    };
    const choice = resolveEngine({ detection, config: null });
    expect(choice).toEqual({
      engine: "omp",
      requiresConfig: false,
      version: "18.0.1",
      path: "/usr/bin/omp",
    });
  });

  // Review Finding 2: `path` must be threaded through from detectOmp()'s
  // `which`/`where` probe so callers stop hardcoding the bare "omp" literal
  // (which breaks on Windows, where `where omp` resolves `omp.cmd` and
  // spawn("omp", …) without shell:true cannot execute a .cmd shim).
  it("R(Finding2) regression: choice.path mirrors detection.path when engine is omp", () => {
    const detection: OmpDetection = {
      available: true,
      ok: true,
      path: "C:\\Users\\dev\\AppData\\Local\\omp\\omp.cmd",
      version: "18.0.1",
    };
    const choice = resolveEngine({ detection, config: null });
    expect(choice.engine).toBe("omp");
    expect(choice.path).toBe("C:\\Users\\dev\\AppData\\Local\\omp\\omp.cmd");
  });

  it("R(Finding2) edge: no path from detectOmp() → choice.path stays undefined (caller falls back to bare \"omp\")", () => {
    const detection: OmpDetection = {
      available: true,
      ok: true,
      version: "18.0.1",
    };
    const choice = resolveEngine({ detection, config: null });
    expect(choice.engine).toBe("omp");
    expect(choice.path).toBeUndefined();
  });

  it("Edge (missing binary) — omp absent, no config → builtin, requiresConfig, OMP_INSTALL_HINT", () => {
    const detection: OmpDetection = {
      available: false,
      ok: false,
      reason: "not-installed",
    };
    const choice = resolveEngine({ detection, config: null });
    expect(choice.engine).toBe("builtin");
    expect(choice.requiresConfig).toBe(true);
    expect(choice.hint).toBe(OMP_INSTALL_HINT);
    expect(choice.version).toBeUndefined();
  });

  it("Edge (version floor) — omp 16.0.0 → version-too-old ⇒ builtin, OMP_UPDATE_HINT", () => {
    const detection: OmpDetection = {
      available: true,
      ok: false,
      path: "/usr/bin/omp",
      version: "16.0.0",
      reason: "version-too-old",
    };
    const choice = resolveEngine({ detection, config: null });
    expect(choice.engine).toBe("builtin");
    expect(choice.hint).toBe(OMP_UPDATE_HINT);
  });

  it("Edge (both available) — omp ok AND a full config present → omp wins, config untouched", () => {
    const detection: OmpDetection = {
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    };
    const config = {
      baseUrl: "https://api.openai.com/v1",
      method: "chat/completions",
      apiKey: "sk-test",
    };
    const choice = resolveEngine({ detection, config });
    expect(choice.engine).toBe("omp");
    expect(choice.requiresConfig).toBe(false);
    // Config itself is not mutated or inspected further — resolveEngine
    // never reads its fields when omp is ok.
    expect(config).toEqual({
      baseUrl: "https://api.openai.com/v1",
      method: "chat/completions",
      apiKey: "sk-test",
    });
  });

  it("builtin engine with a valid config present → requiresConfig is false (config already satisfies it)", () => {
    const detection: OmpDetection = {
      available: false,
      ok: false,
      reason: "not-installed",
    };
    const config = { baseUrl: "https://api.openai.com/v1" };
    const choice = resolveEngine({ detection, config });
    expect(choice.engine).toBe("builtin");
    expect(choice.requiresConfig).toBe(false);
  });

  it("builtin engine with config === undefined behaves like null (requiresConfig true)", () => {
    const detection: OmpDetection = {
      available: false,
      ok: false,
      reason: "not-installed",
    };
    const choice = resolveEngine({ detection, config: undefined });
    expect(choice.requiresConfig).toBe(true);
  });
});
