// webview/aiChat/__tests__/slash.test.ts — TASK-CHATV2-010
//
// Covers the interactive half of the slash contract: SLASH-02 eligibility
// (line start only — never URL/path/prose/escaped/markdown code), SLASH-03 the
// shared button/typed state, SLASH-04 keyboard selection (insert only, zero
// intents), SLASH-05 invalid/unknown handling, SLASH-06 capability-gated
// provider rows and SLASH-08 hostile descriptor text rendered as text.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  ALL_UNIVERSAL_COMMANDS,
  resolveChatCommands,
  type ChatCommandDescriptorV2,
  type CommandGateInput,
} from "../../../src/ui/aiChatPanelCommands";
import type { EngineCapabilitySnapshot } from "../../../src/ai/capabilities";
import {
  SLASH_EMPTY_MESSAGE,
  SLASH_MAX_VISIBLE_ROWS,
  SLASH_ROW_HEIGHT_PX,
  SLASH_WIDTH_MAX,
  SLASH_WIDTH_MIN,
  SLASH_VERTICAL_PADDING_PX,
  buildSlashRows,
  filterSlashCommands,
  slashAcceptEdit,
  slashEligibility,
  slashExecution,
  toSlashCommand,
  type SlashExecutionContext,
} from "../slash";
import { parseChatCommand } from "../../../src/ui/aiChatPanelCommands";

function snapshot(over: Partial<{
  displayName: string;
  savedTranscriptResume: boolean;
  nativeSessionResume: boolean;
  exportTranscript: boolean;
  commands: EngineCapabilitySnapshot["commands"];
}> = {}): EngineCapabilitySnapshot {
  return {
    engine: "builtin",
    displayName: over.displayName ?? "Builtin",
    status: "ready",
    supports: {
      streamText: true,
      streamThought: false,
      toolTimeline: true,
      imageInput: true,
      nativeSessionResume: over.nativeSessionResume ?? true,
      savedTranscriptResume: over.savedTranscriptResume ?? false,
      engineCommands: false,
      permissions: true,
      bypassPermissions: true,
      modelRoles: true,
      workspaceMentions: true,
      dbMentions: true,
      exportTranscript: over.exportTranscript ?? true,
    },
    commands: over.commands ?? [],
    modelRoles: [],
  } as EngineCapabilitySnapshot;
}

function gate(over: Partial<CommandGateInput> = {}): CommandGateInput {
  return {
    capabilities: snapshot(),
    availableEngines: ["builtin", "omp", "claude-code", "codex"],
    modelRoles: ["work", "smart"],
    ...over,
  };
}

function ctx(over: Partial<SlashExecutionContext> = {}): SlashExecutionContext {
  return {
    hasHistory: false,
    hasDraft: false,
    hasTurn: false,
    hasSession: false,
    ...over,
  };
}

// ============================================================================
// SLASH-02 — eligibility
// ============================================================================
describe("slashEligibility", () => {
  it("opens at the start of the current logical line after optional spaces", () => {
    expect(slashEligibility("/", 1).eligible).toBe(true);
    expect(slashEligibility("/eng", 4).eligible).toBe(true);
    expect(slashEligibility("   /eng", 7).eligible).toBe(true);
    expect(slashEligibility("first line\n  /mo", 15).eligible).toBe(true);
  });

  it("does not open mid-prose", () => {
    expect(slashEligibility("see https://x.dev/a", 18).eligible).toBe(false);
    expect(slashEligibility("ratio is 3/4 here", 16).eligible).toBe(false);
    expect(slashEligibility("do /clear now", 12).eligible).toBe(false);
  });

  it("does not open in a URL or filesystem path", () => {
    expect(slashEligibility("https://example.com/a", 21).eligible).toBe(false);
    expect(slashEligibility("path/to/file", 12).eligible).toBe(false);
    expect(slashEligibility("src/ui/aiChatPanel.ts", 22).eligible).toBe(false);
  });

  it("does not open on an escaped slash", () => {
    expect(slashEligibility("\\/clear", 7).eligible).toBe(false);
  });

  it("does not open inside Markdown inline code or a fenced block", () => {
    expect(slashEligibility("use `/clear` for that", 7).eligible).toBe(false);
    expect(slashEligibility("```\n/clear\n```", 8).eligible).toBe(false);
    // A closed fence no longer blocks a later line.
    expect(slashEligibility("```\nx\n```\n/clear", 15).eligible).toBe(true);
  });

  it("returns the token when eligible", () => {
    const r = slashEligibility("  /eng", 6);
    expect(r.eligible).toBe(true);
    expect(r.token).toEqual({ start: 2, end: 6, query: "eng" });
  });
});

// ============================================================================
// Filtering + rows
// ============================================================================
describe("filterSlashCommands", () => {
  const commands = resolveChatCommands(gate());

  it("filters case-insensitively in stable registry order", () => {
    expect(filterSlashCommands(commands, "").map((d) => d.name)).toEqual([
      "new",
      "clear",
      "help",
      "engine",
      "model",
      "context",
      "export",
      "resume",
    ]);
    expect(filterSlashCommands(commands, "EN").map((d) => d.name)).toEqual(["engine"]);
    // Prefix match on the command name, case-insensitively, registry order.
    expect(filterSlashCommands(commands, "e").map((d) => d.name)).toEqual([
      "engine",
      "export",
    ]);
    expect(filterSlashCommands(commands, "c").map((d) => d.name)).toEqual([
      "clear",
      "context",
    ]);
  });

  it("returns an empty list (never a fake row) when nothing matches", () => {
    expect(filterSlashCommands(commands, "zzz")).toEqual([]);
  });
});

describe("buildSlashRows", () => {
  const commands = resolveChatCommands(gate());

  it("builds a slash/name primary, description/syntax secondary and engine badge", () => {
    const rows = buildSlashRows(commands, 0);
    expect(rows).toHaveLength(8);
    const engineRow = rows.find((r) => r.id === "engine")!;
    expect(engineRow.primary).toBe("/engine");
    expect(engineRow.separator).toBe("/");
    expect(engineRow.name).toBe("engine");
    expect(engineRow.secondary).toBeTruthy();
    expect(engineRow.syntax).toBe("/engine [name]");
    expect(engineRow.unavailable).toBe(false);
  });

  it("marks the top row selectable-active and never selects an empty state", () => {
    const rows = buildSlashRows(commands, 0);
    expect(rows[0]!.active).toBe(true);
    expect(rows.slice(1).every((r) => !r.active)).toBe(true);
    // Empty state produces zero rows, so nothing is selectable.
    expect(buildSlashRows([], 0)).toEqual([]);
  });

  it("keeps unavailable commands visible but not selectable", () => {
    const gated = resolveChatCommands(gate({ capabilities: null }));
    const rows = buildSlashRows(gated, 0);
    const help = rows.find((r) => r.id === "help")!;
    const resume = rows.find((r) => r.id === "resume")!;
    expect(help.unavailable).toBe(false);
    expect(resume.unavailable).toBe(true);
    expect(resume.secondary).toBeTruthy();
  });

  it("labels a provider row <Engine>: <name> and never duplicates a universal", () => {
    const provider = {
      id: "review",
      name: "review",
      description: "Review the diff",
      syntax: "/review",
      insertedTemplate: "/review ",
      source: "provider",
      available: true,
    } as unknown as EngineCapabilitySnapshot["commands"][number];
    const resolved = resolveChatCommands(
      gate({ capabilities: snapshot({ displayName: "Codex", commands: [provider] }) }),
      { isProviderImplemented: (id) => id === "review" },
    );
    const rows = buildSlashRows(resolved, resolved.length - 1);
    const row = rows.find((r) => r.id === "review")!;
    expect(row.badge).toBe("Codex");
    expect(row.label).toBe("Codex: review");
    expect(row.primary).toBe("/review");
  });
});

// ============================================================================
// SLASH-03 / SLASH-04 — accept inserts, never executes
// ============================================================================
describe("slashAcceptEdit", () => {
  it("replaces the active token range with the exact template and caret after it", () => {
    const descriptor = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "engine")!;
    const edit = slashAcceptEdit("/eng", 4, descriptor)!;
    expect(edit.text).toBe("/engine ");
    expect(edit.selectionStart).toBe(8);
    expect(edit.selectionEnd).toBe(8);
  });

  it("preserves surrounding text on both sides", () => {
    const descriptor = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "help")!;
    const edit = slashAcceptEdit("line one\n  /he", 14, descriptor)!;
    expect(edit.text).toBe("line one\n  /help ");
    expect(edit.text).toHaveLength(17);
    expect(edit.selectionStart).toBe(17);
  });

  it("returns null when the caret is not on an eligible token", () => {
    const descriptor = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "help")!;
    expect(slashAcceptEdit("no slash here", 13, descriptor)).toBeNull();
  });

  it("gives every universal descriptor a template the caret lands inside a space", () => {
    for (const d of ALL_UNIVERSAL_COMMANDS) {
      const edit = slashAcceptEdit("/x", 2, d);
      expect(edit, d.name).not.toBeNull();
      expect(edit!.text, d.name).toBe(d.insertedTemplate);
      expect(edit!.text.endsWith(" "), `${d.name} trailing space`).toBe(true);
    }
  });
});

// ============================================================================
// SLASH-05 — invalid + unknown
// ============================================================================
describe("slashExecution", () => {
  const g = gate();
  const byName = (name: string): ChatCommandDescriptorV2 =>
    ALL_UNIVERSAL_COMMANDS.find((d) => d.name === name)!;
  /** Parse a full line, then adapt it exactly as the controller will. */
  const run = (text: string, context = ctx()) =>
    slashExecution(toSlashCommand(parseChatCommand(text, { gate: g }), text), context);

  it("maps each universal command to a semantic action, never a raw slash string", () => {
    expect(run("/help")).toEqual({ kind: "local", action: "help-card" });
    expect(run("/context")).toEqual({ kind: "local", action: "context-inspector" });
    expect(run("/resume")).toEqual({ kind: "list-sessions" });
    expect(run("/engine")).toEqual({ kind: "local", action: "engine-picker" });
    expect(run("/model")).toEqual({ kind: "local", action: "model-picker" });
    expect(run("/export")).toEqual({ kind: "export-session", format: "markdown" });
    expect(run("/engine codex")).toEqual({ kind: "set-engine", engine: "codex" });
    expect(run("/model smart")).toEqual({ kind: "set-role", role: "smart" });
    expect(run("/export json")).toEqual({ kind: "export-session", format: "json" });
  });

  it("confirms /new and /clear only when there is something to lose", () => {
    expect(run("/new")).toEqual({ kind: "new-session", confirm: false });
    expect(run("/clear")).toEqual({ kind: "clear-session", confirm: false });
    for (const c of [
      ctx({ hasHistory: true }),
      ctx({ hasDraft: true }),
      ctx({ hasTurn: true }),
    ]) {
      expect(run("/new", c).confirm).toBe(true);
      expect(run("/clear", c).confirm).toBe(true);
    }
  });

  it("never claims native provider resume: /resume lists saved UnicDB sessions", () => {
    const action = run("/resume");
    expect(action.kind).toBe("list-sessions");
    expect(JSON.stringify(action)).not.toMatch(/native|session\/load|provider/i);
  });

  it("#SLASH-05 routes an unknown command to an explicit send-as-message action", () => {
    const action = run("/foo bar");
    expect(action.kind).toBe("send-as-message");
    expect(action.text).toBe("/foo bar");
  });

  it("routes a provider descriptor to a safe handler id, never a raw slash string", () => {
    const provider: ChatCommandDescriptorV2 = {
      id: "review",
      name: "review",
      description: "",
      syntax: "/review",
      source: "provider",
      capability: "always",
      insertedTemplate: "/review ",
      execution: "provider-handler",
      examples: ["/review"],
    };
    const action = slashExecution(toSlashCommand({ status: "valid", name: "review", args: [], descriptor: provider, error: null }, "/review"), ctx());
    expect(action).toEqual({ kind: "provider-handler", id: "review" });
    expect(action.id).not.toContain("/");
  });
});

// ============================================================================
// SLASH-08 — hostile descriptor text is data
// ============================================================================
describe("hostile descriptor text", () => {
  it("rows carry hostile text verbatim as plain strings (no markup)", () => {
    const hostile: ChatCommandDescriptorV2 = {
      id: "evil",
      name: "evil",
      description: "<img src=x onerror=alert(1)>",
      syntax: "/evil",
      source: "universal",
      capability: "always",
      insertedTemplate: "/evil ",
      execution: "help-card",
      examples: ["/evil"],
    };
    const rows = buildSlashRows([hostile], 0);
    expect(rows[0]!.secondary).toBe("<img src=x onerror=alert(1)>");
    expect(rows[0]!.label).toBe("evil");
    // A row model is plain data — nothing HTML-shaped is parsed here.
    expect(typeof rows[0]!.secondary).toBe("string");
  });
});

// ============================================================================
// Popover geometry constants (PLAN §4 / task spec)
// ============================================================================
describe("popover geometry", () => {
  it("pins the contract constants", () => {
    expect(SLASH_MAX_VISIBLE_ROWS).toBe(8);
    expect(SLASH_ROW_HEIGHT_PX).toBe(44);
    expect(SLASH_WIDTH_MIN).toBe(280);
    expect(SLASH_WIDTH_MAX).toBe(420);
    expect(SLASH_VERTICAL_PADDING_PX).toBe(12);
    expect(SLASH_EMPTY_MESSAGE).toBe("No matching commands");
  });

  it("caps a long list at eight visible rows", () => {
    const many: ChatCommandDescriptorV2[] = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      name: `c${i}`,
      description: "",
      syntax: `/c${i}`,
      source: "universal",
      capability: "always",
      insertedTemplate: `/c${i} `,
      execution: "help-card",
      examples: [],
    }));
    expect(buildSlashRows(many, 0)).toHaveLength(8);
  });
});
