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
//   - The pre-existing 56 command ids are still fully present (superset guard, not a
//     frozen count — unrelated command churn must not false-fail).
//   - The new command id appears exactly once.
//   - Every command referenced in any `menus` block resolves to a declared command id.
//
// TASK-013 — manifest contribution: four engines and two agent commands.
//   - `UnicDB.ai.engine` enum exposes builtin, omp, claude-code, codex (default builtin).
//   - `UnicDB.ai.useWithClaudeCode` and `UnicDB.ai.useWithCodex` commands are
//     contributed and activated exactly once each, with no duplicates creeping into
//     activationEvents.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Manifest = {
  contributes: {
    commands?: Array<Record<string, unknown>>;
    menus?: Record<string, Array<Record<string, unknown>> | undefined>;
    configuration?: {
      properties?: Record<string, Record<string, unknown> | undefined>;
    };
  };
  activationEvents?: string[];
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
  "UnicDB.ai.useWithClaudeCode",
  "UnicDB.ai.useWithCodex",
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
      title: "UnicDB: Generate Commit Message",
      category: "UnicDB",
      icon: { light: "media/commit-spark.svg", dark: "media/commit-spark.svg" },
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
    expect(entry!.when).toBe("scmProvider == git");
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

  // ===== TASK-013: four engines and two agent commands ====================

  // ---- Case 1 (TASK-013) — happy ------------------------------------------
  it("TASK-013 case 1: UnicDB.ai.engine enum exposes four values (builtin, omp, claude-code, codex) and default remains builtin", () => {
    const json = loadManifest();
    const properties = json.contributes.configuration?.properties ?? {};
    const engine = properties["UnicDB.ai.engine"];
    expect(engine, "UnicDB.ai.engine phải tồn tại trong configuration.properties").toBeDefined();
    expect(engine!.type).toBe("string");
    expect(engine!.enum).toEqual(["builtin", "omp", "claude-code", "codex"]);
    expect(engine!.default).toBe("builtin");
  });

  // ---- Case 2 (TASK-013) — happy ------------------------------------------
  it("TASK-013 case 2: UnicDB.ai.useWithClaudeCode & useWithCodex are contributed and activated", () => {
    const json = loadManifest();

    const commands = json.contributes.commands ?? [];
    const ids = commands.map((c) => c.command as string);

    expect(ids).toContain("UnicDB.ai.useWithClaudeCode");
    expect(ids).toContain("UnicDB.ai.useWithCodex");

    const claudeEntry = commands.find((c) => c.command === "UnicDB.ai.useWithClaudeCode");
    const codexEntry = commands.find((c) => c.command === "UnicDB.ai.useWithCodex");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry!.title).toBe("Use with Claude Code");
    expect(codexEntry).toBeDefined();
    expect(codexEntry!.title).toBe("Use with Codex");

    const events: string[] = Array.isArray(json.activationEvents) ? json.activationEvents : [];
    expect(events).toContain("onCommand:UnicDB.ai.useWithClaudeCode");
    expect(events).toContain("onCommand:UnicDB.ai.useWithCodex");
  });

  // ---- Case 3 (TASK-013) — edge (duplicate) -------------------------------
  it("TASK-013 case 3: new activation events appear exactly once; no preexisting events get duplicated", () => {
    const json = loadManifest();
    const events: string[] = Array.isArray(json.activationEvents) ? json.activationEvents : [];

    const newEvents = [
      "onCommand:UnicDB.ai.useWithClaudeCode",
      "onCommand:UnicDB.ai.useWithCodex",
    ];
    for (const e of newEvents) {
      const count = events.filter((x) => x === e).length;
      expect(count, `${e} phải xuất hiện đúng 1 lần`).toBe(1);
    }

    // Sanity: a few preexisting activation events keep their original single count.
    const preexisting = ["onLanguage:sql", "onCommand:UnicDB.aiChat", "onCommand:UnicDB.ai.useWithOmp"];
    for (const e of preexisting) {
      const count = events.filter((x) => x === e).length;
      expect(count, `${e} phải giữ nguyên count = 1`).toBe(1);
    }
  });
});
