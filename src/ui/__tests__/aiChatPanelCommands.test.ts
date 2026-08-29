import { describe, expect, it } from "vitest";
import { parseAiChatCommand } from "../aiChatPanelCommands";

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
