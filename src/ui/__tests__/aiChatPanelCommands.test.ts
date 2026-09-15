// src/ui/__tests__/aiChatPanelCommands.test.ts — TASK-CHATV2-010
//
// Covers SLASH-01 (eight universal descriptors), SLASH-05 (invalid/unknown
// arguments keep the corrective syntax + one example), SLASH-06 (provider
// descriptors appear only when the capability snapshot advertises a verified
// handler, and a name collision is disambiguated) and SLASH-07 (engine/model
// validation spans every advertised value, not a legacy subset).
//
// The legacy six-command V1 surface (`parseAiChatCommand` /
// `aiChatCommandsForEngine`) is deliberately preserved and still covered here:
// it is what the archived V1 composer posts until CHATV2-017 removes it.
import { describe, expect, it } from "vitest";

import type {
  AiEngineName,
  ChatCommandDescriptor as CapabilityCommandDescriptor,
  EngineCapabilitySnapshot,
} from "../../ai/capabilities";
import {
  ALL_UNIVERSAL_COMMANDS,
  UNIVERSAL_COMMANDS,
  UNIVERSAL_COMMAND_ORDER,
  parseChatCommand,
  parseAiChatCommand,
  aiChatCommandsForEngine,
  resolveChatCommands,
  providerCommandsFromCapabilities,
  commandAvailability,
  advertisedModelRoles,
  getSlashToken,
} from "../aiChatPanelCommands";

/** A minimal capability snapshot carrying only what the gate reads. */
function snapshot(over: {
  engine?: AiEngineName;
  displayName?: string;
  savedTranscriptResume?: boolean;
  nativeSessionResume?: boolean;
  modelRoles?: boolean;
  exportTranscript?: boolean;
  commands?: readonly CapabilityCommandDescriptor[];
} = {}): EngineCapabilitySnapshot {
  return {
    engine: over.engine ?? "builtin",
    displayName: over.displayName ?? "Builtin",
    status: "ready",
    supports: {
      streamText: true,
      streamThought: false,
      toolTimeline: true,
      imageInput: true,
      nativeSessionResume: over.nativeSessionResume ?? false,
      savedTranscriptResume: over.savedTranscriptResume ?? false,
      engineCommands: false,
      permissions: true,
      bypassPermissions: true,
      modelRoles: over.modelRoles ?? true,
      workspaceMentions: true,
      dbMentions: true,
      exportTranscript: over.exportTranscript ?? true,
    },
    commands: over.commands ?? [],
    modelRoles: [],
  } as EngineCapabilitySnapshot;
}

/** A gate with sane defaults; each test states only the facts it varies. */
function gate(over: Partial<Parameters<typeof resolveChatCommands>[0]> = {}) {
  return {
    capabilities: snapshot(),
    availableEngines: ["builtin", "omp", "claude-code", "codex"] as readonly string[],
    modelRoles: ["work", "smart"] as readonly string[],
    ...over,
  };
}

// ============================================================================
// SLASH-01 — the eight universal descriptors
// ============================================================================
describe("SLASH-01 universal descriptors", () => {
  it("declares exactly the eight universal commands in frozen order", () => {
    expect(UNIVERSAL_COMMAND_ORDER).toEqual([
      "new",
      "clear",
      "help",
      "engine",
      "model",
      "context",
      "export",
      "resume",
    ]);
    expect(ALL_UNIVERSAL_COMMANDS.map((d) => d.name)).toEqual([...UNIVERSAL_COMMAND_ORDER]);
    expect(ALL_UNIVERSAL_COMMANDS).toHaveLength(8);
  });

  it("every descriptor is complete, frozen, universal and has one example", () => {
    for (const d of ALL_UNIVERSAL_COMMANDS) {
      expect(d.id, `${d.name} id`).toBeTruthy();
      expect(d.name).toBe(d.id);
      expect(d.description, `${d.name} description`).toBeTruthy();
      expect(d.syntax.startsWith("/"), `${d.name} syntax`).toBe(true);
      expect(d.source).toBe("universal");
      expect(d.insertedTemplate.startsWith("/"), `${d.name} template`).toBe(true);
      expect(d.execution, `${d.name} execution`).toBeTruthy();
      expect(d.capability, `${d.name} capability`).toBeTruthy();
      expect(d.examples.length, `${d.name} example`).toBeGreaterThanOrEqual(1);
      expect(Object.isFrozen(d), `${d.name} frozen`).toBe(true);
    }
  });

  it("uses the exact declared syntax and inserted template per command", () => {
    const byName = new Map(ALL_UNIVERSAL_COMMANDS.map((d) => [d.name, d]));
    expect(byName.get("new")!.insertedTemplate).toBe("/new ");
    expect(byName.get("clear")!.insertedTemplate).toBe("/clear ");
    expect(byName.get("help")!.syntax).toBe("/help");
    expect(byName.get("engine")!.syntax).toBe("/engine [name]");
    expect(byName.get("model")!.syntax).toBe("/model [role]");
    expect(byName.get("context")!.syntax).toBe("/context");
    expect(byName.get("export")!.syntax).toBe("/export [markdown|json]");
    expect(byName.get("resume")!.syntax).toBe("/resume");
    expect(UNIVERSAL_COMMANDS).toBe(ALL_UNIVERSAL_COMMANDS);
  });

  it("maps /new and /clear to confirmation-bearing session actions", () => {
    const byName = new Map(ALL_UNIVERSAL_COMMANDS.map((d) => [d.name, d]));
    expect(byName.get("new")!.execution).toBe("new-session");
    expect(byName.get("clear")!.execution).toBe("clear-session");
    expect(byName.get("help")!.execution).toBe("help-card");
    expect(byName.get("context")!.execution).toBe("context-inspector");
    expect(byName.get("export")!.execution).toBe("export-flow");
    expect(byName.get("resume")!.execution).toBe("resume-picker");
    expect(byName.get("engine")!.execution).toBe("engine-picker");
    expect(byName.get("model")!.execution).toBe("model-picker");
  });
});

// ============================================================================
// advertisedModelRoles — /model accepts exactly what the host advertises
// ============================================================================
describe("advertisedModelRoles", () => {
  it("returns only roles the host advertises with an available snapshot", () => {
    expect(advertisedModelRoles(snapshot({ modelRoles: true }), ["work", "smart"])).toEqual([
      "work",
      "smart",
    ]);
  });

  it("returns nothing when the engine does not offer role selection", () => {
    // omp owns its model selection: supports.modelRoles is false.
    expect(advertisedModelRoles(snapshot({ modelRoles: false }), ["work", "smart"])).toEqual([]);
  });

  it("fails closed without a snapshot", () => {
    expect(advertisedModelRoles(null, ["work", "smart"])).toEqual([]);
  });

  it("preserves the caller's role order and drops duplicates", () => {
    expect(advertisedModelRoles(snapshot(), ["smart", "work", "smart"])).toEqual([
      "smart",
      "work",
    ]);
  });
});

// ============================================================================
// getSlashToken — the token the popover anchors to
// ============================================================================
describe("getSlashToken", () => {
  it("returns the token at the caret", () => {
    expect(getSlashToken("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(getSlashToken("/eng", 4)).toEqual({ start: 0, end: 4, query: "eng" });
    expect(getSlashToken("  /mo", 5)).toEqual({ start: 2, end: 5, query: "mo" });
    expect(getSlashToken("line one\n  /mo", 14)).toEqual({ start: 11, end: 14, query: "mo" });
    // A slash token on an INDENTED line is eligible; the caret mid-token narrows it.
    expect(getSlashToken("line one\n  /mo", 13)).toEqual({ start: 11, end: 13, query: "m" });
  });

  it("returns null when the caret is not on a leading slash token", () => {
    expect(getSlashToken("hello", 5)).toBeNull();
    // Mid-prose slash is not a command line start.
    expect(getSlashToken("hello /mo", 9)).toBeNull();
    expect(getSlashToken("a /b c", 6)).toBeNull();
    // URL / path / escaped slash never open the popover.
    expect(getSlashToken("https://example.com/a", 21)).toBeNull();
    expect(getSlashToken("path/to/file", 12)).toBeNull();
    expect(getSlashToken("\\/clear", 7)).toBeNull();
    expect(getSlashToken("", 0)).toBeNull();
  });

  it("clamps out-of-range carets instead of throwing", () => {
    expect(getSlashToken("/eng", 99)).toEqual({ start: 0, end: 4, query: "eng" });
    expect(getSlashToken("/eng", -3)).toBeNull();
  });
});

// ============================================================================
// parseChatCommand — grammar + validated arguments
// ============================================================================
describe("parseChatCommand", () => {
  it("#SLASH-07 accepts /engine for every advertised engine", () => {
    for (const engine of ["builtin", "omp", "claude-code", "codex"]) {
      const r = parseChatCommand(`/engine ${engine}`, { gate: gate() });
      expect(r.status, engine).toBe("valid");
      expect(r.args).toEqual([engine]);
      expect(r.descriptor?.name).toBe("engine");
    }
  });

  it("#SLASH-07 accepts /model for every advertised role (not just work|smart)", () => {
    const g = gate({ modelRoles: ["work", "smart", "autocomplete", "lite"] });
    for (const role of ["work", "smart", "autocomplete", "lite"]) {
      expect(parseChatCommand(`/model ${role}`, { gate: g }).status, role).toBe("valid");
    }
    // A role the host does not advertise is invalid, with syntax + example.
    const bad = parseChatCommand("/model nope", { gate: g });
    expect(bad.status).toBe("invalid-args");
    expect(bad.error?.syntax).toBe("/model [role]");
    expect(bad.error?.example).toBeTruthy();
  });

  it("treats an argument-less picker command as valid", () => {
    expect(parseChatCommand("/engine", { gate: gate() }).status).toBe("valid");
    expect(parseChatCommand("/model", { gate: gate() }).status).toBe("valid");
    expect(parseChatCommand("/export", { gate: gate() }).status).toBe("valid");
  });

  it("validates /export against the two formats only", () => {
    expect(parseChatCommand("/export markdown", { gate: gate() }).status).toBe("valid");
    expect(parseChatCommand("/export json", { gate: gate() }).status).toBe("valid");
    const bad = parseChatCommand("/export yaml", { gate: gate() });
    expect(bad.status).toBe("invalid-args");
    expect(bad.error?.example).toContain("/export");
  });

  it("rejects extra arguments on no-argument commands with a corrective hint", () => {
    for (const text of ["/new now", "/clear all", "/help me", "/context foo", "/resume abc"]) {
      const r = parseChatCommand(text, { gate: gate() });
      expect(r.status, text).toBe("invalid-args");
      expect(r.error?.example, text).toBeTruthy();
    }
  });

  it("#SLASH-05 reports an unknown command explicitly instead of dropping it", () => {
    const r = parseChatCommand("/foo bar", { gate: gate() });
    expect(r.status).toBe("unknown");
    expect(r.name).toBe("foo");
    expect(r.args).toEqual(["bar"]);
    expect(r.descriptor).toBeNull();
  });

  it("is case-insensitive on the command word and keeps argument bytes", () => {
    const r = parseChatCommand("  /ENGINE   Claude-Code ", { gate: gate() });
    expect(r.status).toBe("valid");
    expect(r.name).toBe("engine");
    expect(r.args).toEqual(["Claude-Code"]);
  });

  it("returns status none for prose or a bare slash", () => {
    expect(parseChatCommand("hello world", { gate: gate() }).status).toBe("none");
    expect(parseChatCommand("/", { gate: gate() }).status).toBe("none");
    expect(parseChatCommand("", { gate: gate() }).status).toBe("none");
  });

  it("flags malformed quoting and never half-applies it", () => {
    const r = parseChatCommand('/model "smart', { gate: gate() });
    expect(r.status).toBe("malformed");
    expect(r.error?.syntax).toBeTruthy();
  });

  it("keeps the legacy parser behavior for the archived V1 composer", () => {
    expect(parseAiChatCommand("  /ENGINE   builtin ")).toEqual({
      command: "engine",
      args: ["builtin"],
    });
    expect(parseAiChatCommand('/model "smart"')).toEqual({
      command: "model",
      args: ["smart"],
    });
    expect(parseAiChatCommand("hello /clear")).toBeNull();
    expect(parseAiChatCommand('/model "unterminated')).toBeNull();
    expect(parseAiChatCommand("/clear")).toEqual({ command: "clear", args: [] });
    // The V1 registry stays the six the archived host handlers implement.
    expect(aiChatCommandsForEngine("builtin").map((e) => e.command)).toEqual([
      "clear",
      "resume",
      "engine",
      "context",
      "export",
      "model",
    ]);
  });
});

// ============================================================================
// Capability gate — availability without lying to the user
// ============================================================================
describe("commandAvailability", () => {
  it("gates /resume on a resumable session (saved transcript OR native)", () => {
    const resume = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "resume")!;
    expect(commandAvailability(resume, gate()).available).toBe(false);
    expect(
      commandAvailability(resume, gate({ capabilities: snapshot({ nativeSessionResume: true }) }))
        .available,
    ).toBe(true);
    expect(
      commandAvailability(resume, gate({ capabilities: snapshot({ savedTranscriptResume: true }) }))
        .available,
    ).toBe(true);
  });

  it("gates /model on advertised model roles", () => {
    const model = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "model")!;
    expect(commandAvailability(model, gate()).available).toBe(true);
    const none = commandAvailability(model, gate({ modelRoles: [] }));
    expect(none.available).toBe(false);
    expect(none.reason).toBeTruthy();
  });

  it("fails closed while the capability snapshot has not arrived", () => {
    const g = gate({ capabilities: null });
    const always = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "help")!;
    const gated = ALL_UNIVERSAL_COMMANDS.find((d) => d.name === "resume")!;
    expect(commandAvailability(always, g).available).toBe(true);
    expect(commandAvailability(gated, g).available).toBe(false);
    expect(commandAvailability(gated, g).reason).toBeTruthy();
  });
});

// ============================================================================
// SLASH-06 — provider descriptors
// ============================================================================
describe("resolveChatCommands provider descriptors", () => {
  function providerDescriptor(over: Partial<CapabilityCommandDescriptor> = {}): CapabilityCommandDescriptor {
    return {
      id: "review",
      name: "review",
      description: "Ask the engine to review the current diff",
      syntax: "/review",
      insertedTemplate: "/review ",
      source: "provider",
      available: true,
      ...over,
    } as CapabilityCommandDescriptor;
  }

  it("lists universal commands first, in frozen order, with no provider commands by default", () => {
    const names = resolveChatCommands(gate()).map((d) => d.name);
    expect(names).toEqual([...UNIVERSAL_COMMAND_ORDER]);
  });

  it("admits only provider commands the host has a verified handler for", () => {
    const caps = snapshot({ displayName: "Codex", commands: [providerDescriptor()] });
    // No handler registered → the descriptor never reaches the user.
    expect(
      resolveChatCommands(gate({ capabilities: caps })).map((d) => d.name),
    ).toEqual([...UNIVERSAL_COMMAND_ORDER]);

    const withHandler = resolveChatCommands(gate({ capabilities: caps }), {
      isProviderImplemented: (id) => id === "review",
    });
    const provider = withHandler.find((d) => d.source === "provider");
    expect(provider?.name).toBe("review");
    expect(provider?.providerLabel).toBe("Codex: review");
    expect(provider?.execution).toBe("provider-handler");
  });

  it("lets the universal command win a name collision", () => {
    const caps = snapshot({
      displayName: "OMP",
      commands: [providerDescriptor({ id: "clear", name: "clear", syntax: "/clear" })],
    });
    const resolved = resolveChatCommands(gate({ capabilities: caps }), {
      isProviderImplemented: () => true,
    });
    const clears = resolved.filter((d) => d.name === "clear");
    expect(clears).toHaveLength(1);
    expect(clears[0]!.source).toBe("universal");
    expect(clears[0]!.providerLabel).toBeUndefined();
  });

  it("requires the descriptor to declare source provider", () => {
    const caps = snapshot({
      commands: [providerDescriptor({ source: "universal" })],
    });
    expect(providerCommandsFromCapabilities(caps, () => true)).toEqual([]);
  });

  it("fails closed on a hostile capability payload", () => {
    const hostile = snapshot({
      commands: [
        providerDescriptor({ id: "x", name: "<img src=x onerror=alert(1)>" }),
        providerDescriptor({ id: "y", name: "ok", source: "provider" }),
      ],
    });
    const kept = providerCommandsFromCapabilities(hostile, () => true);
    expect(kept.map((d) => d.name)).toEqual(["ok"]);
  });
});
