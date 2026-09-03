// src/ui/helpGrid.ts
//
// TASK-OC4O-002 — VSDB Help Grid: a pure registry of feature cards that the
// help-grid webview renders as a responsive grid. Every card carries the
// command id the user can trigger via "Try it"; the registry filters out
// cards whose command id is missing/empty so a future-cycle command that
// loses its registration cannot silently break the help grid.
//
// Pure module: no vscode import, no I/O, deterministic output for the same
// input list. The card list below is the canonical "what features exist"
// inventory; new cycles that add a command should append a card here.

export type HelpCard = {
  /** Stable id used as the DOM key + analytics key. */
  readonly id: string;
  /** Short title shown on the card (1-3 words). */
  readonly title: string;
  /** 1-line description shown under the title. */
  readonly blurb: string;
  /** VS Code codicon string (e.g. "$(window)", "$(database)"). */
  readonly icon: string;
  /**
   * Command id the card launches when the user clicks "Try it". The
   * registry filters out any card whose command id is not a non-empty
   * string, so a typo or a removed command cannot produce a broken card.
   */
  readonly commandId: string;
};

/**
 * The canonical inventory. Order matters — it is the order the cards
 * appear in the grid (top-left to bottom-right).
 */
const CARDS: readonly HelpCard[] = [
  {
    id: "open-console",
    title: "SQL Console",
    blurb: "Multi-tab scratchpad to type and run SQL against the active connection.",
    icon: "$(window)",
    commandId: "vsdb.openConsole",
  },
  {
    id: "open-console-for-object",
    title: "Console for Object",
    blurb: "Right-click a table/view → open the Console with a pre-filled SELECT snippet.",
    icon: "$(window)",
    commandId: "vsdb.openConsoleForObject",
  },
  {
    id: "run-query",
    title: "Run Query",
    blurb: "Run the active SQL statement (Cmd/Ctrl+Enter from a .sql editor).",
    icon: "$(play)",
    commandId: "vsdb.runQuery",
  },
  {
    id: "refresh-schema",
    title: "Refresh Schema",
    blurb: "Invalidate schema cache and reload the tree.",
    icon: "$(refresh)",
    commandId: "vsdb.refreshSchema",
  },
  {
    id: "browse-table-data",
    title: "Browse Table Data",
    blurb: "Open the Results grid for a table (paginated, inline editable).",
    icon: "$(table)",
    commandId: "vsdb.browseTableData",
  },
  {
    id: "generate-select",
    title: "Generate SELECT",
    blurb: "Right-click a table/view → insert a driver-aware SELECT into the editor.",
    icon: "$(preview)",
    commandId: "vsdb.generateSelect",
  },
  {
    id: "ai-chat",
    title: "AI Chat",
    blurb: "Open the AI chat panel (built-in or OMP engine) for the active connection.",
    icon: "$(comment-discussion)",
    commandId: "vsdb.aiChat",
  },
  {
    id: "manage-connections",
    title: "Manage Connections",
    blurb: "Add, edit, delete connections and set the active one.",
    icon: "$(plug)",
    commandId: "vsdb.manageConnections",
  },
  {
    id: "results-placement",
    title: "Results Placement",
    blurb: "Configure where the Results panel opens (below the editor or beside it).",
    icon: "$(split-vertical)",
    commandId: "workbench.action.openSettings",
  },
];

/**
 * Filter the registry against the actual set of registered command ids
 * (caller supplies the set — keeps this module pure). Any card whose
 * `commandId` is empty OR not in the supplied set is dropped. The
 * `workbench.*` / `vsdb.*` ids are the only valid prefixes for the help
 * grid; any other prefix is also filtered out as a defence-in-depth check
 * (prevents a future card from accidentally launching an unrelated,
 * arbitrary command id).
 */
export function helpCardRegistry(
  registeredCommandIds: ReadonlySet<string>,
): readonly HelpCard[] {
  return CARDS.filter((c) => {
    if (typeof c.commandId !== "string" || c.commandId.length === 0) return false;
    if (!c.commandId.startsWith("vsdb.") && !c.commandId.startsWith("workbench.")) {
      return false;
    }
    // Settings / workbench.* may not be in registeredCommandIds (they live
    // in the workbench itself); accept them by prefix when the caller does
    // not have them in the set.
    if (c.commandId.startsWith("workbench.")) return true;
    return registeredCommandIds.has(c.commandId);
  });
}

/**
 * Return the full list of `commandId` strings the registry *would* expose,
 * before filtering. Exported so tests can pin the canonical inventory
 * without depending on which subset survives filtering.
 */
export function allHelpCardCommandIds(): readonly string[] {
  return CARDS.map((c) => c.commandId);
}