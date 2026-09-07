// src/ai/claudeCode/__tests__/detect.test.ts — TASK-002 TDD tests
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MIN_CLAUDE_CODE_VERSION,
  CLAUDE_CODE_INSTALL_HINT,
  detectClaudeCode,
  type ClaudeCodeDetection,
} from "../detect";

describe("detectClaudeCode — frozen contract", () => {
  // Case 1 — happy: execFn returns path then "2.0.1 (Claude Code)"
  it("happy: available, ok, version '2.0.1', path set", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which claude") return "/usr/local/bin/claude\n";
      if (cmd.endsWith(" --version")) return "2.0.1 (Claude Code)";
      throw new Error("unexpected: " + cmd);
    };
    const result: ClaudeCodeDetection = await detectClaudeCode(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/usr/local/bin/claude");
    expect(result.version).toBe("2.0.1");
    expect(result.reason).toBeUndefined();
    // Sanity: both commands ran, in order.
    expect(calls).toEqual(["which claude", "/usr/local/bin/claude --version"]);
  });

  // Case 2 — ENOENT: must NOT throw, available=false, reason "not-installed"
  it("edge (missing): ENOENT → not-installed, does not throw", async () => {
    const err = Object.assign(new Error("spawn which claude ENOENT"), {
      code: "ENOENT",
    });
    const execFn = vi.fn().mockRejectedValue(err);
    const result = await detectClaudeCode(execFn);
    expect(result.available).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-installed");
    expect(result.path).toBeUndefined();
    expect(result.version).toBeUndefined();
  });

  // Case 3 — boundary: version exactly MIN_CLAUDE_CODE_VERSION is ok=true;
  // one patch lower is ok=false, reason "version-too-old".
  it.each([
    ["1.0.0", true],
    ["0.9.9", false],
    ["0.9.0", false],
  ])(
    "edge (boundary): version %s → ok=%s",
    async (versionString, expectedOk) => {
      const execFn = async (cmd: string) => {
        if (cmd === "which claude") return "/usr/local/bin/claude\n";
        if (cmd.endsWith(" --version"))
          return `${versionString} (Claude Code)`;
        throw new Error("unexpected: " + cmd);
      };
      const result = await detectClaudeCode(execFn);
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

  // Case 4 — garbage output, unparseable
  it("edge (garbage): unparseable output → reason 'version-unknown', ok=false", async () => {
    const execFn = async (cmd: string) => {
      if (cmd === "which claude") return "/usr/local/bin/claude\n";
      if (cmd.endsWith(" --version")) return "garbage-output";
      throw new Error("unexpected: " + cmd);
    };
    const result = await detectClaudeCode(execFn);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("version-unknown");
    expect(result.version).toBeUndefined();
  });
});

// ---- TASK-006 (B12) — platform + quoting -----------------------------------

describe("detectClaudeCode — platform + quoting (TASK-006 B12)", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  // Case 5 — win32: locator is `where claude`; multi-line output → first non-empty path.
  it("edge (win32): uses `where claude`, first non-empty line wins", async () => {
    setPlatform("win32");
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "where claude")
        return "C:\\Tools\\claude.exe\r\nC:\\Program Files\\claude\\claude.exe\r\n";
      if (cmd.endsWith(" --version")) return "2.0.1 (Claude Code)";
      throw new Error("unexpected: " + cmd);
    };
    const result = await detectClaudeCode(execFn);
    expect(calls[0]).toBe("where claude");
    expect(calls[0]).not.toBe("which claude");
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("C:\\Tools\\claude.exe");
  });

  it("non-windows platforms still use `which`", async () => {
    setPlatform("darwin");
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which claude") return "/usr/local/bin/claude\n";
      if (cmd.endsWith(" --version")) return "2.0.1 (Claude Code)";
      throw new Error("unexpected: " + cmd);
    };
    await detectClaudeCode(execFn);
    expect(calls[0]).toBe("which claude");
  });

  // Edge (path with spaces) — the version probe must still succeed; the path
  // is quoted/argv-passed rather than shell-concatenated word-by-word.
  it("edge (path with spaces): version probe succeeds; path is quoted, not shell-split", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "which claude") return "/opt/my apps/claude\n";
      if (cmd === '"/opt/my apps/claude" --version') return "2.0.1 (Claude Code)";
      throw new Error("unexpected/unquoted cmd: " + cmd);
    };
    const result = await detectClaudeCode(execFn);
    expect(calls).toEqual([
      "which claude",
      '"/opt/my apps/claude" --version',
    ]);
    expect(result.available).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.0.1");
  });
});

describe("constants — frozen values", () => {
  it("MIN_CLAUDE_CODE_VERSION is '1.0.0'", () => {
    expect(MIN_CLAUDE_CODE_VERSION).toBe("1.0.0");
  });
  it("CLAUDE_CODE_INSTALL_HINT is the documented install command", () => {
    expect(CLAUDE_CODE_INSTALL_HINT).toBe(
      "npm install -g @anthropic-ai/claude-code",
    );
  });
});