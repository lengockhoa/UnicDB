// src/ui/__tests__/helpGrid.test.ts
//
// TASK-OC4O-002 — pure help-card registry tests.
import { describe, it, expect } from "vitest";
import {
  helpCardRegistry,
  allHelpCardCommandIds,
} from "../helpGrid";

describe("helpGrid registry (pure)", () => {
  it("returns the full canonical set when every command is registered", () => {
    const ids = new Set(allHelpCardCommandIds());
    const cards = helpCardRegistry(ids);
    expect(cards.length).toBe(allHelpCardCommandIds().length);
    for (const c of cards) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.blurb.length).toBeGreaterThan(0);
      expect(c.icon.startsWith("$(")).toBe(true);
      expect(c.commandId.startsWith("vsdb.") || c.commandId.startsWith("workbench."))
        .toBe(true);
    }
  });

  it("filters out cards whose command id is not registered", () => {
    const all = allHelpCardCommandIds();
    // Register only the first 4 vsdb.* commands; every other card whose
    // commandId starts with `vsdb.` is dropped. The workbench.* card
    // (`workbench.action.openSettings`) survives because the registry
    // accepts workbench.* by prefix regardless of the supplied set.
    const registeredSet = new Set<string>(
      all.filter((id) => id.startsWith("vsdb.")).slice(0, 4),
    );
    const cards = helpCardRegistry(registeredSet);
    const cmdIds = cards.map((c) => c.commandId);
    // Exactly 4 vsdb.* + 1 workbench.* = 5 cards.
    expect(cmdIds.length).toBe(5);
    const vsdbSurvivors = cmdIds.filter((id) => id.startsWith("vsdb."));
    expect(vsdbSurvivors.length).toBe(4);
    expect(cmdIds).toContain("workbench.action.openSettings");
    for (const c of cards) {
      expect(
        registeredSet.has(c.commandId) || c.commandId.startsWith("workbench."),
      ).toBe(true);
    }
  });

  it("keeps workbench.* cards even when the workbench id is not in the set", () => {
    // `workbench.action.openSettings` is provided by VS Code itself, not by
    // the extension's registeredCommandIds set — the registry must still
    // surface it so users can navigate to settings from the help grid.
    const registeredSet = new Set<string>([
      "vsdb.openConsole",
      "vsdb.runQuery",
    ]);
    const cards = helpCardRegistry(registeredSet);
    const cmdIds = cards.map((c) => c.commandId);
    expect(cmdIds).toContain("workbench.action.openSettings");
  });

  it("drops cards when the registered set is empty (no vsdb.* registered)", () => {
    const cards = helpCardRegistry(new Set());
    // workbench.* cards still pass through, so the result is non-empty.
    const cmdIds = cards.map((c) => c.commandId);
    expect(cmdIds.every((id) => id.startsWith("workbench."))).toBe(true);
  });

  it("canonical inventory is stable (ids match the shipped cards)", () => {
    // Pin the names so a stray rename in the registry fails this test.
    const ids = allHelpCardCommandIds();
    expect(ids).toContain("vsdb.openConsole");
    expect(ids).toContain("vsdb.openConsoleForObject");
    expect(ids).toContain("vsdb.runQuery");
    expect(ids).toContain("vsdb.refreshSchema");
    expect(ids).toContain("vsdb.browseTableData");
    expect(ids).toContain("vsdb.generateSelect");
    expect(ids).toContain("vsdb.aiChat");
    expect(ids).toContain("vsdb.manageConnections");
    expect(ids).toContain("workbench.action.openSettings");
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length);
  });
});