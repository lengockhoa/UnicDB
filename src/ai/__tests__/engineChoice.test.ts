// src/ai/__tests__/engineChoice.test.ts — TASK-007 (P0.3): selected-engine resolution.
//
// Covers both the legacy omp-first call shape `{ detection, config }` (preserved
// until TASK-012 migrates extension callers) and the explicit P0.3
// `{ engine, detections, config }` shape that honors the user-selected engine
// (omp / claude-code / codex / builtin) with reason-keyed fallback hints.
import { describe, it, expect } from "vitest";
import { resolveEngine } from "../engineChoice";
import {
  OMP_INSTALL_HINT,
  OMP_UPDATE_HINT,
  type OmpDetection,
} from "../omp/detect";
import type { EngineChoice } from "../engineChoice";

function det(over: Partial<OmpDetection>): OmpDetection {
  return { available: false, ok: false, ...over };
}

describe("resolveEngine — AIX-05 reason → hint mapping (legacy omp-first)", () => {
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

// =============================================================================
// TASK-007 §Test Cases — P0.3 selected-engine policy (engine + detections input).
// =============================================================================

describe("resolveEngine — TASK-007 P0.3 selected-engine policy", () => {
  // Test 1 — happy | configured healthy Claude Code wins.
  it("configured healthy Claude Code wins over any other installed agent", () => {
    const c: EngineChoice = resolveEngine({
      engine: "claude-code",
      detections: {
        "claude-code": { ok: true, version: "2.0.1", path: "/usr/bin/claude" },
      },
      config: null,
    });
    expect(c.engine).toBe("claude-code");
    expect(c.requiresConfig).toBe(false);
    expect(c.version).toBe("2.0.1");
    expect(c.path).toBe("/usr/bin/claude");
    expect(c.hint).toBeUndefined();
  });

  // Test 2 — edge (unavailable) | configured missing Codex falls back builtin.
  it("configured missing Codex falls back builtin with CODEX_INSTALL_HINT", () => {
    const c = resolveEngine({
      engine: "codex",
      detections: {
        codex: { ok: false, reason: "not-installed" },
      },
      config: null,
    });
    expect(c.engine).toBe("builtin");
    expect(c.requiresConfig).toBe(true);
    expect(c.hint).toBe("npm install -g @openai/codex");
  });

  // Test 3 — edge (boundary/config precedence) | explicit builtin ignores omp.
  it("explicit builtin ignores a healthy omp; no hint; requiresConfig reflects config presence", () => {
    const c = resolveEngine({
      engine: "builtin",
      detections: {
        omp: { ok: true, version: "18.0.1", path: "/usr/bin/omp" },
      },
      config: { baseUrl: "https://x", apiKey: "y", model: "m" },
    });
    expect(c.engine).toBe("builtin");
    expect(c.requiresConfig).toBe(false);
    expect(c.hint).toBeUndefined();
    // Critically: the healthy omp selection must NOT have leaked into engine.
    expect(c.engine).not.toBe("omp");
  });

  // Test 4 — edge (invalid input) | unknown configured engine fails closed.
  it("unknown configured engine fails closed to builtin with no unsafe external engine", () => {
    const c = resolveEngine({
      // Cast to simulate a migrated/corrupt value reaching an un-trusted input.
      engine: "copilot" as unknown,
      detections: {
        omp: { ok: true, version: "18.0.1", path: "/usr/bin/omp" },
      },
      config: null,
    });
    expect(c.engine).toBe("builtin");
    // Requires-config reflects null config — caller still needs a config.
    expect(c.requiresConfig).toBe(true);
    // The unsafe external engine string must not leak into the result.
    expect(c.engine).not.toBe("copilot");
    expect(c.engine).not.toBe("omp");
    // No selected-engine hint (we don't know which install command applies).
    expect(c.hint).toBeUndefined();
  });

  // Test 5 — regression | omitted engine preserves existing omp-first behavior.
  it("omitted engine preserves omp-first legacy behavior (regression)", () => {
    const c = resolveEngine({
      // Legacy call shape: no `engine`, no `detections`.
      detection: { available: true, ok: true, path: "/usr/bin/omp", version: "18.0.1" },
      config: null,
    });
    expect(c.engine).toBe("omp");
    expect(c.requiresConfig).toBe(false);
    expect(c.version).toBe("18.0.1");
    expect(c.path).toBe("/usr/bin/omp");
  });
});
