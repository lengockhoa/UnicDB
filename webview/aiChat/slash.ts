// webview/aiChat/slash.ts — TASK-CHATV2-010
//
// The INTERACTIVE half of the slash contract, kept as pure functions so the
// eligibility rules, the row model and the execution mapping are all testable
// without a DOM, a timer or a transport:
//
//   - `slashEligibility(text, caret)` — where a `/` may open the popover. A
//     token is eligible ONLY when its slash begins the current logical line
//     after optional spaces and is not inside Markdown inline/fenced code. A
//     URL, a filesystem path, mid-prose punctuation and an escaped `\/` all
//     return ineligible, so the popover never hijacks ordinary text.
//   - `filterSlashCommands` / `buildSlashRows` — the local, case-insensitive,
//     stable-order list and the fixed row model the renderer paints. Rows are
//     plain data: hostile descriptor copy is a string here and is written with
//     `textContent` by the view, never parsed as markup.
//   - `slashExecution` — the semantic action for a COMPLETE command. It never
//     returns a raw provider slash string; the controller turns the action into
//     a V2 intent.
//
// NO EXECUTION PATH SENDS A TURN. Accepting a row only edits the draft; a turn
// is submitted later, by the controller, only on a plain Enter in a
// submittable phase.
//
// Pure module: no `vscode`, no DOM, no transport, no clock.

import {
  getSlashToken,
  type ChatCommandDescriptorV2,
  type ChatCommandParse,
  type SlashToken,
} from "../../src/ui/aiChatPanelCommands";
import { replaceSelection, type TextRangeEdit } from "./keyboard";

// The popover geometry contract (PLAN §4 / task spec) lives HERE because this
// pure module has no DOM: `autocomplete.ts` imports these to paint the shared
// listbox, and the `SLASH_*` aliases below are the slash-domain names callers
// read. One definition, no cycle.
/** Max rows the popover shows at once (PLAN §4). */
export const AUTOCOMPLETE_MAX_VISIBLE_ROWS = 8;
/** Row height in px (PLAN §4: "Rows are 44px"). */
export const AUTOCOMPLETE_ROW_HEIGHT_PX = 44;
/** Popover width bounds in px (task spec: 280–420). */
export const AUTOCOMPLETE_WIDTH_MIN = 280;
export const AUTOCOMPLETE_WIDTH_MAX = 420;
/** Vertical padding inside the popover, in px. */
export const AUTOCOMPLETE_VERTICAL_PADDING_PX = 12;
/** Empty-state copy. The empty state is NOT a selectable row. */
export const AUTOCOMPLETE_EMPTY_MESSAGE = "No matching commands";

export const SLASH_MAX_VISIBLE_ROWS = AUTOCOMPLETE_MAX_VISIBLE_ROWS;
export const SLASH_ROW_HEIGHT_PX = AUTOCOMPLETE_ROW_HEIGHT_PX;
export const SLASH_WIDTH_MIN = AUTOCOMPLETE_WIDTH_MIN;
export const SLASH_WIDTH_MAX = AUTOCOMPLETE_WIDTH_MAX;
export const SLASH_VERTICAL_PADDING_PX = AUTOCOMPLETE_VERTICAL_PADDING_PX;
export const SLASH_EMPTY_MESSAGE = AUTOCOMPLETE_EMPTY_MESSAGE;

/** Eligibility result. `token` is present only when `eligible` is true. */
export interface SlashEligibility {
  readonly eligible: boolean;
  readonly token: SlashToken | null;
}

const NOT_ELIGIBLE: SlashEligibility = { eligible: false, token: null };

/**
 * True when `line` has an odd number of backtick runs before `before`, i.e. the
 * caret sits inside an unterminated inline-code span.
 */
function insideInlineCode(line: string, before: number): boolean {
  let runs = 0;
  let i = 0;
  while (i < before) {
    if (line[i] === "`") {
      // Collapse a run of backticks into one delimiter.
      while (i < before && line[i] === "`") i++;
      runs++;
      continue;
    }
    i++;
  }
  return runs % 2 === 1;
}

/**
 * True when the caret on `lineIndex` sits inside an open ``` fence. A fence
 * opens on a line whose first non-space run is three or more backticks and
 * closes on the next such line.
 */
function insideFence(text: string, lineIndex: number): boolean {
  const lines = text.split("\n");
  let open = false;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) open = !open;
  }
  return open;
}

/**
 * Decide whether the popover may open at `caret`, and with which token.
 * `token`'s slash must begin the line after only spaces, must not be escaped,
 * and must not be inside Markdown inline or fenced code.
 */
export function slashEligibility(text: string, caret: number): SlashEligibility {
  const token = getSlashToken(text, caret);
  if (token === null) return NOT_ELIGIBLE;

  // Line + column of the token's slash.
  const slash = token.start;
  const before = text.slice(0, slash);
  const lineIndex = before.split("\n").length - 1;
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart, slash);

  // Inside Markdown inline code on this line?
  if (insideInlineCode(line, line.length)) return NOT_ELIGIBLE;
  // Inside an open fenced block?
  if (insideFence(text, lineIndex)) return NOT_ELIGIBLE;

  return { eligible: true, token };
}

/**
 * Local, case-insensitive filter over already-resolved descriptors. Order is
 * the registry order (stable), so rows never reshuffle as the user types.
 */
export function filterSlashCommands(
  commands: readonly ChatCommandDescriptorV2[],
  query: string,
): readonly ChatCommandDescriptorV2[] {
  const q = query.toLowerCase();
  if (q.length === 0) return commands;
  return commands.filter((d) => d.name.toLowerCase().startsWith(q));
}

/** One renderable popover row. All copy is plain text written via `textContent`. */
export interface SlashRow {
  readonly id: string;
  readonly name: string;
  /** The `/name` primary text. */
  readonly primary: string;
  /** The leading slash glyph, for styling the primary as slash + name. */
  readonly separator: string;
  /** Secondary line: description, or the safe reason when unavailable. */
  readonly secondary: string;
  /** The declared syntax, shown alongside the description. */
  readonly syntax: string;
  /** Optional provider engine badge (display name only). */
  readonly badge?: string;
  /** `<Engine>: <name>` for provider rows; the bare name for universal rows. */
  readonly label: string;
  /** True when the current row is the active descendant. */
  readonly active: boolean;
  /** True when selecting the row would promise an unavailable action. */
  readonly unavailable: boolean;
}

/**
 * Build the visible row model. At most `SLASH_MAX_VISIBLE_ROWS` rows are
 * returned, windowed so the active row is always on screen — a list longer than
 * eight (universal commands plus capability-supplied provider commands) stays
 * fully reachable by keyboard instead of stranding its tail. An empty list
 * yields zero rows, so the empty state can never be selected or accepted.
 */
export function buildSlashRows(
  commands: readonly ChatCommandDescriptorV2[],
  activeIndex: number,
): readonly SlashRow[] {
  const total = commands.length;
  if (total === 0) return Object.freeze([]);

  const active = Number.isFinite(activeIndex)
    ? Math.min(Math.max(Math.trunc(activeIndex), 0), total - 1)
    : 0;

  const max = Math.min(total, SLASH_MAX_VISIBLE_ROWS);
  const first = Math.min(Math.max(active - max + 1, 0), total - max);
  const visible = commands.slice(first, first + max);

  return Object.freeze(
    visible.map((descriptor, index) => {
      const unavailable = descriptor.reason !== undefined;
      const providerLabel = descriptor.providerLabel;
      const badge =
        providerLabel !== undefined && providerLabel.includes(": ")
          ? providerLabel.slice(0, providerLabel.indexOf(": "))
          : undefined;
      const row: SlashRow = {
        id: descriptor.id,
        name: descriptor.name,
        primary: `/${descriptor.name}`,
        separator: "/",
        secondary: unavailable ? descriptor.reason! : descriptor.description,
        syntax: descriptor.syntax,
        label: providerLabel ?? descriptor.name,
        active: first + index === active,
        unavailable,
        ...(badge !== undefined ? { badge } : {}),
      };
      return Object.freeze(row);
    }),
  );
}

/**
 * The draft edit accepting `descriptor` performs: replace the eligible slash
 * token with the descriptor's EXACT inserted template, caret after the trailing
 * space. Returns null when no eligible token sits at `caret` — acceptance never
 * edits a line the popover would not have opened on.
 */
export function slashAcceptEdit(
  text: string,
  caret: number,
  descriptor: ChatCommandDescriptorV2,
): TextRangeEdit | null {
  const eligibility = slashEligibility(text, caret);
  if (!eligibility.eligible || eligibility.token === null) return null;
  const { start, end } = eligibility.token;
  return replaceSelection(text, start, end, descriptor.insertedTemplate);
}

// ===========================================================================
// Execution mapping
// ===========================================================================

/** Webview-owned facts a command's confirmation depends on. */
export interface SlashExecutionContext {
  readonly hasHistory: boolean;
  readonly hasDraft: boolean;
  readonly hasTurn: boolean;
  readonly hasSession: boolean;
}

/** A parsed line ready for execution. `raw` is the trimmed original, sent
 * verbatim when the command word turns out to be unknown. */
export interface SlashCommandInput {
  readonly descriptor: ChatCommandDescriptorV2 | null;
  readonly name: string | null;
  readonly args: readonly string[];
  readonly raw: string;
}

/** Adapt a `parseChatCommand` result + the original line into an input. */
export function toSlashCommand(parse: ChatCommandParse, raw: string): SlashCommandInput {
  return {
    descriptor: parse.descriptor,
    name: parse.name,
    args: parse.args,
    raw: raw.trim(),
  };
}

/** The semantic action for a complete command. NEVER a raw slash string. */
export type SlashAction =
  | { readonly kind: "new-session"; readonly confirm: boolean }
  | { readonly kind: "clear-session"; readonly confirm: boolean }
  | { readonly kind: "local"; readonly action: "help-card" | "context-inspector" | "engine-picker" | "model-picker" }
  | { readonly kind: "set-engine"; readonly engine: string }
  | { readonly kind: "set-role"; readonly role: string }
  | { readonly kind: "export-session"; readonly format: "markdown" | "json" }
  | { readonly kind: "list-sessions" }
  | { readonly kind: "provider-handler"; readonly id: string }
  | { readonly kind: "send-as-message"; readonly text: string };

/** True when the session has content worth confirming before destroying it. */
function needsConfirm(ctx: SlashExecutionContext): boolean {
  return ctx.hasHistory || ctx.hasDraft || ctx.hasTurn;
}

/**
 * Map a validated command to a semantic action.
 *
 * `input.descriptor === null` means the command word is unknown: the only
 * honest outcome is an explicit `send-as-message`, so the text is delivered as
 * a chat message rather than silently discarded or reinterpreted as a command.
 *
 * Capability gating (whether the action is allowed at all) is the caller's:
 * an unavailable row is never selectable in the first place.
 */
export function slashExecution(
  input: SlashCommandInput,
  ctx: SlashExecutionContext,
): SlashAction {
  const descriptor = input.descriptor;
  const args = input.args;
  if (descriptor === null) {
    const text = input.raw.length > 0 ? input.raw : input.name === null ? "" : `/${input.name}`;
    return { kind: "send-as-message", text };
  }

  switch (descriptor.execution) {
    case "new-session":
      return { kind: "new-session", confirm: needsConfirm(ctx) };
    case "clear-session":
      return { kind: "clear-session", confirm: needsConfirm(ctx) };
    case "help-card":
      return { kind: "local", action: "help-card" };
    case "context-inspector":
      return { kind: "local", action: "context-inspector" };
    case "engine-picker":
      // No argument opens the picker; an argument is a validated switch.
      return args.length === 0
        ? { kind: "local", action: "engine-picker" }
        : { kind: "set-engine", engine: args[0]! };
    case "model-picker":
      return args.length === 0
        ? { kind: "local", action: "model-picker" }
        : { kind: "set-role", role: args[0]! };
    case "export-flow":
      return {
        kind: "export-session",
        format: args.length === 0 || args[0]!.toLowerCase() === "markdown" ? "markdown" : "json",
      };
    case "resume-picker":
      // Saved UnicDB transcripts only. Never a provider-native resume.
      return { kind: "list-sessions" };
    case "provider-handler":
      return { kind: "provider-handler", id: descriptor.id };
    default:
      // Unreachable for a well-formed descriptor; fail to the honest path.
      return { kind: "send-as-message", text: `/${descriptor.name}` };
  }
}
