// src/ui/__tests__/commitGenManifest.test.ts
// TASK-GC-004 — manifest guards for the "Generate Commit Message" sparkle.
//
// Asserts that `package.json` declares:
//   - `contributes.commands` contains
//     { command: "UnicDB.generateCommitMessage", title: "Generate Commit Message",
//       category: "UnicDB", icon: "$(sparkle)" }
//   - `contributes.menus["scm/title"]` contains
//     { command: "UnicDB.generateCommitMessage", group: "navigation",
//       when: "scmProvider == git && scmProviderHasChanges" }
//   - The pre-existing 54 command ids are still fully present (superset guard, not a
//     frozen count of 55/54 — unrelated command churn must not false-fail).
//   - The new command id appears exactly once.
//   - Every command referenced in any `menus` block resolves to a declared command id.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Manifest = {
  contributes: {
    commands?: Array<Record<string, unknown>>;
    menus?: Record<string, Array<Record<string, unknown>> | undefined>;
  };
};

const PRE_EXISTING_COMMAND_IDS: ReadonlyArray<string> = [
  "UnicDB.addConnection",
  "UnicDB.editConnection",
  "UnicDB.deleteConnection",
  "UnicDB.selectConnection",
  "UnicDB.runQuery",
  "UnicDB.cancelQuery",
  "UnicDB.generateSelect",
  "UnicDB.copyQualifiedName",
  "UnicDB.refreshSchema",
  "UnicDB.runStatement",
  "UnicDB.filterSchemaTree",
  "UnicDB.clearSchemaTreeFilter",
  "UnicDB.runScript",
  "UnicDB.newTable",
  "UnicDB.modifyTable",
  "UnicDB.renameTable",
  "UnicDB.renameColumn",
  "UnicDB.copyCreateDdl",
  "UnicDB.generateSampleData",
  "UnicDB.analyzeTable",
  "UnicDB.vacuumTable",
  "UnicDB.openAiSettings",
  "UnicDB.aiChat",
  "UnicDB.ai.useWithOmp",
  "UnicDB.ai.refreshDbContext",
  "UnicDB.ai.showPolicy",
  "UnicDB.ai.exportTrace",
  "UnicDB.ai.clearTrace",
  "UnicDB.browseTableData",
  "UnicDB.createSchema",
  "UnicDB.postmanPayload",
  "UnicDB.exportStructure",
  "UnicDB.exportAllStructures",
  "UnicDB.openConsole",
  "UnicDB.consoleNewTab",
  "UnicDB.openConsoleForObject",
  "UnicDB.openUserGuide",
  "UnicDB.openHelpGrid",
  "UnicDB.refreshAdmin",
  "UnicDB.openSessionsPanel",
  "UnicDB.killSession",
  "UnicDB.terminateSession",
  "UnicDB.runGrantSql",
  "UnicDB.importCsv",
  "UnicDB.importJson",
  "UnicDB.openFormView",
  "UnicDB.editLargeValue",
  "UnicDB.compareTables",
  "UnicDB.relationshipExplorer",
  "UnicDB.diagnostics.show",
  "UnicDB.diagnostics.clear",
  "UnicDB.generateViewDdl",
  "UnicDB.generateFunctionDdl",
  "UnicDB.openSettings",
];

const NEW_COMMAND_ID = "UnicDB.generateCommitMessage";

function loadManifest(): Manifest {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  return JSON.parse(raw) as Manifest;
}

describe("TASK-GC-004 — package.json manifest guards for the Generate Commit Message sparkle", () => {
  // ---- Case 1 — happy ----------------------------------------------------
  it("case 1: command declared with icon + category (exact shape)", () => {
    const json = loadManifest();
    const commands = json.contributes.commands ?? [];
    const entry = commands.find((c) => c.command === NEW_COMMAND_ID);
    expect(entry).toBeDefined();
    expect(entry).toEqual({
      command: NEW_COMMAND_ID,
      title: "Generate Commit Message",
      category: "UnicDB",
      icon: "$(sparkle)",
    });
  });

  // ---- Case 2 — happy ----------------------------------------------------
  it("case 2: scm/title menu entry has command, group navigation, and the frozen when clause", () => {
    const json = loadManifest();
    const menus = json.contributes.menus ?? {};
    const scmTitle = menus["scm/title"];
    expect(Array.isArray(scmTitle)).toBe(true);
    const entry = (scmTitle as Array<Record<string, unknown>>).find(
      (m) => m.command === NEW_COMMAND_ID,
    );
    expect(entry).toBeDefined();
    expect(entry!.group).toBe("navigation");
    expect(entry!.when).toBe(
      "scmProvider == git && scmProviderHasChanges",
    );
  });

  // ---- Case 4 — edge (malformed / superset) ------------------------------
  it("case 4: no duplicate command ids and the pre-existing 54 ids remain (superset)", () => {
    const json = loadManifest();
    const commands = json.contributes.commands ?? [];
    const ids = commands.map((c) => c.command as string);

    // The new command id is present exactly once.
    const occurrences = ids.filter((id) => id === NEW_COMMAND_ID).length;
    expect(occurrences).toBe(1);

    // Superset guard over the pre-GC command id list — we assert every pre-existing
    // id is still present, but we do NOT freeze the total count, so unrelated
    // command churn (new commands added later) cannot false-fail this test.
    for (const preId of PRE_EXISTING_COMMAND_IDS) {
      expect(ids).toContain(preId);
    }
  });

  // ---- Case 5 — edge (consistency) ---------------------------------------
  it("case 5: every command referenced in any menus block resolves to a declared command id", () => {
    const json = loadManifest();
    const commands = json.contributes.commands ?? [];
    const declared = new Set(commands.map((c) => c.command as string));

    const menus = json.contributes.menus ?? {};
    for (const [, entries] of Object.entries(menus)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry.command !== "string") continue;
        expect(declared.has(entry.command)).toBe(true);
      }
    }
  });
});
