import { describe, expect, it } from "vitest";
import {
  parseAiChatCommand,
  aiChatCommandsForEngine,
} from "../aiChatPanelCommands";

describe("parseAiChatCommand", () => {
  it("parses recognized commands case-insensitively with whitespace", () => {
    expect(parseAiChatCommand("  /ENGINE   builtin ")).toEqual({
      command: "engine",
      args: ["builtin"],
    });
  });

  it("supports quoted arguments containing spaces", () => {
    expect(parseAiChatCommand('/model "smart"')).toEqual({
      command: "model",
      args: ["smart"],
    });
  });

  it("returns null for ordinary, unknown, incomplete, or malformed input", () => {
    expect(parseAiChatCommand("hello /clear")).toBeNull();
    expect(parseAiChatCommand("/eng builtin")).toBeNull();
    expect(parseAiChatCommand("/unknown")).toBeNull();
    expect(parseAiChatCommand('/model "unterminated')).toBeNull();
    expect(parseAiChatCommand("/")).toBeNull();
  });

  it("recognizes no-argument commands and preserves argument boundaries", () => {
    expect(parseAiChatCommand("/clear")).toEqual({ command: "clear", args: [] });
    expect(parseAiChatCommand("/context foo bar")).toEqual({
      command: "context",
      args: ["foo", "bar"],
    });
  });
});

describe("aiChatCommandsForEngine", () => {
  it("lists the full local set with descriptions for the builtin engine", () => {
    const entries = aiChatCommandsForEngine("builtin");
    expect(entries.map((e) => e.command)).toEqual([
      "clear",
      "resume",
      "engine",
      "context",
      "export",
      "model",
    ]);
    for (const e of entries) {
      expect(e.description, `${e.command} description`).toBeTruthy();
    }
  });

  it("gates /resume as unavailable on every non-omp engine, available on omp", () => {
    for (const engine of ["builtin", "claude-code", "codex"]) {
      const resume = aiChatCommandsForEngine(engine).find((e) => e.command === "resume");
      expect(resume?.available, `${engine} resume`).toBe(false);
      expect(resume?.reason).toMatch(/omp/i);
    }
    const ompResume = aiChatCommandsForEngine("omp").find((e) => e.command === "resume");
    expect(ompResume?.available).toBe(true);
    expect(ompResume?.reason).toBeUndefined();
  });

  it("fails closed for an unknown/hostile engine: only omp-gated resume is restricted", () => {
    const entries = aiChatCommandsForEngine("../../evil");
    expect(entries.map((e) => e.command)).toEqual([
      "clear",
      "resume",
      "engine",
      "context",
      "export",
      "model",
    ]);
    // Unknown engine is treated like a non-omp engine: resume unavailable.
    expect(entries.find((e) => e.command === "resume")?.available).toBe(false);
    // No command name ever echoes the hostile engine string.
    for (const e of entries) {
      expect(e.command).not.toContain("evil");
    }
  });
});
