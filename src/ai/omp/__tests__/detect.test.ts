// src/ai/omp/__tests__/detect.test.ts — TASK-003 TDD tests
import { describe, it, expect, vi } from "vitest";
import {
  MIN_OMP_VERSION,
  OMP_INSTALL_HINT,
  OMP_UPDATE_HINT,
  compareVersions,
  detectOmp,
  type OmpDetection,
} from "../detect";

// Case 1 — happy: execFn returns path then "omp/18.0.1"
describe("detectOmp — frozen contract", () => {
  it("happy: available, ok, version '18.0.1', path set", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which omp") return "/usr/local/bin/omp\n";
      if (cmd.endsWith(" --version")) return "omp/18.0.1 darwin/arm64";
      throw new Error("unexpected: " + cmd);
    };
    const result: OmpDetection = await detectOmp(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/usr/local/bin/omp");
    expect(result.version).toBe("18.0.1");
    expect(result.reason).toBeUndefined();
    // Sanity: both commands ran, in order.
    expect(calls).toEqual(["which omp", "/usr/local/bin/omp --version"]);
  });

  // Case 2 — ENOENT: must NOT throw, available=false, reason "not-installed"
  it("edge (missing): ENOENT → not-installed, does not throw", async () => {
    const err = Object.assign(new Error("spawn which omp ENOENT"), {
      code: "ENOENT",
    });
    const execFn = vi.fn().mockRejectedValue(err);
    const result = await detectOmp(execFn);
    expect(result.available).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-installed");
    expect(result.path).toBeUndefined();
    expect(result.version).toBeUndefined();
  });

  // Case 3 — version too old
  it("edge (old): version 16.9.0 → ok=false, reason 'version-too-old'", async () => {
    const execFn = async (cmd: string) => {
      if (cmd === "which omp") return "/usr/local/bin/omp\n";
      if (cmd.endsWith(" --version")) return "omp/16.9.0 darwin/arm64";
      throw new Error("unexpected: " + cmd);
    };
    const result = await detectOmp(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.version).toBe("16.9.0");
    expect(result.reason).toBe("version-too-old");
  });

  // Case 4 — garbage output, unparseable
  it("edge (garbage): unparseable output → reason 'version-unknown', ok=false", async () => {
    const execFn = async (cmd: string) => {
      if (cmd === "which omp") return "/usr/local/bin/omp\n";
      if (cmd.endsWith(" --version")) return "??? something broken ???";
      throw new Error("unexpected: " + cmd);
    };
    const result = await detectOmp(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("version-unknown");
    expect(result.version).toBeUndefined();
  });
});

// Case 5 — compareVersions numeric semantics
describe("compareVersions — frozen contract", () => {
  it("'17.0.1' vs '17.10.0' returns -1 (numeric, not string-compare)", () => {
    expect(compareVersions("17.0.1", "17.10.0")).toBe(-1);
  });
  it("'18.0.0' vs '17.99.99' returns 1", () => {
    expect(compareVersions("18.0.0", "17.99.99")).toBe(1);
  });
  it("equal versions return 0", () => {
    expect(compareVersions("17.0.0", "17.0.0")).toBe(0);
  });

  // Case 6 — non-numeric tail tolerated; "18.0.1-beta.2" parses to "18.0.1"
  it("'18.0.1-beta.2' vs '18.0.0' → 1; vs '18.0.1' → 0; vs '18.0.2' → -1", () => {
    expect(compareVersions("18.0.1-beta.2", "18.0.0")).toBe(1);
    expect(compareVersions("18.0.1-beta.2", "18.0.1")).toBe(0);
    expect(compareVersions("18.0.1-beta.2", "18.0.2")).toBe(-1);
  });
});

describe("constants — frozen values", () => {
  it("MIN_OMP_VERSION is '17.0.0'", () => {
    expect(MIN_OMP_VERSION).toBe("17.0.0");
  });
  it("OMP_INSTALL_HINT is the documented install command", () => {
    expect(OMP_INSTALL_HINT).toBe("curl -fsSL https://omp.sh/install | sh");
  });
  it("OMP_UPDATE_HINT is 'omp update'", () => {
    expect(OMP_UPDATE_HINT).toBe("omp update");
  });
});
