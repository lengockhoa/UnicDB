// src/ai/codex/__tests__/detect.test.ts — TASK-003 TDD tests
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MIN_CODEX_VERSION,
  CODEX_INSTALL_HINT,
  detectCodex,
  type CodexDetection,
} from "../detect";

describe("detectCodex — frozen contract", () => {
  // Case 1 — happy: execFn returns path then "codex-cli 0.42.0"
  it("happy: available, ok, version '0.42.0', path set", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which codex") return "/usr/local/bin/codex\n";
      if (cmd.endsWith(" --version")) return "codex-cli 0.42.0";
      throw new Error("unexpected: " + cmd);
    };
    const result: CodexDetection = await detectCodex(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/usr/local/bin/codex");
    expect(result.version).toBe("0.42.0");
    expect(result.reason).toBeUndefined();
    // Sanity: both commands ran, in order.
    expect(calls).toEqual(["which codex", "/usr/local/bin/codex --version"]);
  });

  // Case 2 — ENOENT: must NOT throw, available=false, reason "not-installed"
  it("edge (missing): ENOENT → not-installed, does not throw", async () => {
    const err = Object.assign(new Error("spawn which codex ENOENT"), {
      code: "ENOENT",
    });
    const execFn = vi.fn().mockRejectedValue(err);
    const result = await detectCodex(execFn);
    expect(result.available).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-installed");
    expect(result.path).toBeUndefined();
    expect(result.version).toBeUndefined();
  });

  // Case 3 — boundary: version exactly MIN_CODEX_VERSION is ok=true;
  // one patch lower is ok=false, reason "version-too-old".
  it.each([
    ["0.20.0", true],
    ["0.19.9", false],
    ["0.19.0", false],
  ])(
    "edge (boundary): version %s → ok=%s",
    async (versionString, expectedOk) => {
      const execFn = async (cmd: string) => {
        if (cmd === "which codex") return "/usr/local/bin/codex\n";
        if (cmd.endsWith(" --version")) return `codex-cli ${versionString}`;
        throw new Error("unexpected: " + cmd);
      };
      const result = await detectCodex(execFn);
      expect(result.available).toBe(true);
      expect(result.ok).toBe(expectedOk);
      expect(result.version).toBe(versionString);
      if (!expectedOk) {
        expect(result.reason).toBe("version-too-old");
      } else {
        expect(result.reason).toBeUndefined();
      }
    },
  );

  // Case 4 — garbage output, unparseable (no numeric token).
  it("edge (garbage): unparseable output → reason 'version-unknown', ok=false", async () => {
    const execFn = async (cmd: string) => {
      if (cmd === "which codex") return "/usr/local/bin/codex\n";
      if (cmd.endsWith(" --version")) return "codex-cli (dev build)";
      throw new Error("unexpected: " + cmd);
    };
    const result = await detectCodex(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("version-unknown");
    expect(result.version).toBeUndefined();
  });

  // Case 5 — spawn failure on probe (--version rejects), mirror detect.ts:104-111
  it("edge (spawn-failure on probe): available=false, ok=false, path set, reason 'spawn-failed'", async () => {
    const execFn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "which codex") return "/usr/local/bin/codex\n";
      throw new Error("spawn codex --version failed");
    });
    const result = await detectCodex(execFn);
    expect(result.available).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.path).toBe("/usr/local/bin/codex");
    expect(result.reason).toBe("spawn-failed");
    expect(result.version).toBeUndefined();
  });
});

// ---- TASK-006 (B12) — platform + quoting -----------------------------------

describe("detectCodex — platform + quoting (TASK-006 B12)", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  // win32: locator is `where codex`; multi-line output → first non-empty path.
  it("edge (win32): uses `where codex`, first non-empty line wins", async () => {
    setPlatform("win32");
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "where codex")
        return "C:\\Tools\\codex.exe\r\nC:\\Program Files\\codex\\codex.exe\r\n";
      if (cmd.endsWith(" --version")) return "codex-cli 0.42.0";
      throw new Error("unexpected: " + cmd);
    };
    const result = await detectCodex(execFn);
    expect(calls[0]).toBe("where codex");
    expect(calls[0]).not.toBe("which codex");
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("C:\\Tools\\codex.exe");
  });

  it("non-windows platforms still use `which`", async () => {
    setPlatform("darwin");
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which codex") return "/usr/local/bin/codex\n";
      if (cmd.endsWith(" --version")) return "codex-cli 0.42.0";
      throw new Error("unexpected: " + cmd);
    };
    await detectCodex(execFn);
    expect(calls[0]).toBe("which codex");
  });

  // Edge (path with spaces) — the version probe must still succeed; the path
  // is quoted/argv-passed rather than shell-concatenated word-by-word.
  it("edge (path with spaces): version probe succeeds; path is quoted, not shell-split", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which codex") return "/opt/my apps/codex\n";
      if (cmd === '"/opt/my apps/codex" --version') return "codex-cli 0.42.0";
      throw new Error("unexpected/unquoted cmd: " + cmd);
    };
    const result = await detectCodex(execFn);
    expect(calls).toEqual([
      "which codex",
      '"/opt/my apps/codex" --version',
    ]);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.42.0");
  });
});

describe("constants — frozen values", () => {
  it("MIN_CODEX_VERSION is '0.20.0'", () => {
    expect(MIN_CODEX_VERSION).toBe("0.20.0");
  });
  it("CODEX_INSTALL_HINT is the documented install command", () => {
    expect(CODEX_INSTALL_HINT).toBe("npm install -g @openai/codex");
  });
});
