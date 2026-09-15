// ===========================================================================
// TASK-CHATV2-010 — the V2 command registry, grammar and validated parse.
//
// This module owns the SEMANTIC command surface. It is pure: no `vscode`, no
// DOM, no transport, no clock. Two layers live here and deliberately do not
// overlap:
//
//   - The V2 registry (`UNIVERSAL_COMMANDS` + `resolveChatCommands`) is a set of
//     frozen descriptors: id, name, description, syntax, source, capability
//     gate, inserted template, execution mode and one example. A descriptor's
//     `insertedTemplate` is the EXACT text a selection inserts — selection never
//     executes anything.
//   - The V1 surface (`AI_CHAT_COMMANDS`, `parseAiChatCommand`,
//     `aiChatCommandsForEngine`) is unchanged and still serves the archived V1
//     composer until CHATV2-017 removes it.
//
// GRAMMAR. Arguments use a small shell-like splitter: whitespace separates
// unquoted values, matching quotes group whitespace, backslash escapes the next
// character, and an unclosed quote is `malformed` (never half-applied).
// Command words are matched case-insensitively; argument bytes are preserved
// verbatim because they are echoed back into an insertion template.
//
// ARGUMENT VALIDATION IS CAPABILITY-DRIVEN. `/engine` accepts every engine the
// host advertises and `/model` every role it advertises — never a hard-coded
// legacy subset — and an invalid argument reports the descriptor's syntax plus
// one concrete example so the user can repair the line without guessing.
//
// HOSTILE TEXT. Descriptor copy is data. This module never builds markup, never
// composes a class name from input and never echoes a raw provider command
// string; the renderer writes every field with `textContent`.

import type {
  ChatCommandDescriptor as CapabilityCommandDescriptor,
  EngineCapabilitySnapshot,
} from "../ai/capabilities";

/** Recognized local commands supported by the AI Chat composer. */
export const AI_CHAT_COMMANDS = [
  "clear",
  "resume",
  "engine",
  "context",
  "export",
  "model",
] as const;

export type AiChatCommand = (typeof AI_CHAT_COMMANDS)[number];

/** One-line description shown next to a command in the slash menu. */
const COMMAND_DESCRIPTIONS: Record<AiChatCommand, string> = {
  clear: "Clear the conversation",
  resume: "Resume a previous session",
  engine: "Show or switch the active engine",
  context: "Show grounded context for this session",
  export: "Export the transcript",
  model: "Show or switch the active model role",
};

/** A slash-menu row: the command plus its per-engine availability. */
export interface AiChatCommandEntry {
  command: AiChatCommand;
  description: string;
  available: boolean;
  /** Why the command is unavailable on the active engine (omitted when
   * available). Rendered as the secondary line so the menu never promises an
   * action the engine cannot perform. */
  reason?: string;
}

/** Engine-gated reason a local command is not usable on `engine`, or
 * `undefined` when it is. Grounded in the existing host guards: `/resume`
 * posts "Resume requires the omp engine." on every non-omp engine
 * (`src/ui/aiChatPanel.ts:4023`), so the menu marks it unavailable there
 * instead of offering a command that can only fail. Unrecognized engine
 * values fail closed the same way (only `omp` may resume). */
function unavailableReason(
  command: AiChatCommand,
  engine: string,
): string | undefined {
  if (command === "resume" && engine !== "omp") {
    return "Requires the omp engine";
  }
  return undefined;
}

/**
 * Slash commands for the active engine, in menu order. Native provider
 * commands are absent for every engine today — omp's
 * `available_commands_update` is explicitly ignored
 * (`src/ai/omp/ompChatEngine.ts:332`) and claude-code / codex expose no
 * command parser — so the set is the shared local registry with per-engine
 * availability applied. A command the engine cannot run is listed as
 * unavailable rather than hidden, so the user sees why it is not offered.
 */
export function aiChatCommandsForEngine(engine: string): AiChatCommandEntry[] {
  return AI_CHAT_COMMANDS.map((command) => {
    const reason = unavailableReason(command, engine);
    const entry: AiChatCommandEntry = {
      command,
      description: COMMAND_DESCRIPTIONS[command],
      available: reason === undefined,
    };
    if (reason !== undefined) entry.reason = reason;
    return entry;
  });
}

export interface ParsedAiChatCommand {
  command: AiChatCommand;
  args: string[];
}

const COMMANDS: Record<AiChatCommand, true> = {
  clear: true,
  resume: true,
  engine: true,
  context: true,
  export: true,
  model: true,
};

/**
 * Parse a complete, local AI chat slash command.
 *
 * Commands must occupy the complete trimmed input and begin with `/`; ordinary
 * text and unknown/incomplete command prefixes return null. Arguments use a
 * small shell-like grammar: whitespace separates unquoted values, and matching
 * single or double quotes group whitespace. Backslash escapes the next
 * character inside or outside quotes. Malformed/unclosed quotes return null.
 */
export function parseAiChatCommand(input: string): ParsedAiChatCommand | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;


  let i = 1;
  const commandStart = i;
  while (i < text.length && !/\s/.test(text[i] ?? "")) i++;
  const command = text.slice(commandStart, i).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) return null;

  const args: string[] = [];
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (i >= text.length) break;
    let value = "";
    let quote: '"' | "'" | null = null;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") {
        i++;
        if (i >= text.length) return null;
        value += text[i]!;
        i++;
        continue;
      }
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
          i++;
        } else {
          value += ch;
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      value += ch;
      i++;
    }
    if (quote !== null) return null;
    args.push(value);
  }
  return { command: command as AiChatCommand, args };
}

// ===========================================================================
// V2 registry — universal descriptors
// ===========================================================================

/** Frozen menu order. Callers must not reorder — the popover renders this
 * order and the keyboard cursor starts on row 0. */
export const UNIVERSAL_COMMAND_ORDER = Object.freeze([
  "new",
  "clear",
  "help",
  "engine",
  "model",
  "context",
  "export",
  "resume",
] as const);

export type UniversalCommandName = (typeof UNIVERSAL_COMMAND_ORDER)[number];

/** What a descriptor DOES once a complete command is executed. The execution
 * mode is host-owned: the webview maps it to an intent, never to a raw string. */
export type ChatCommandExecution =
  | "new-session"
  | "clear-session"
  | "help-card"
  | "engine-picker"
  | "model-picker"
  | "context-inspector"
  | "export-flow"
  | "resume-picker"
  | "provider-handler";

/** Which host fact must hold before the command may be executed. `always`
 * covers host-owned actions that need no engine capability. */
export type ChatCommandCapability =
  | "always"
  | "engine-switch"
  | "model-roles"
  | "transcript-export"
  | "session-resume";

/** One V2 slash-command descriptor. All text is display copy consumed via
 * `textContent`; `id` is a safe identifier, never a raw provider command. */
export interface ChatCommandDescriptorV2 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly syntax: string;
  readonly source: "universal" | "provider";
  readonly capability: ChatCommandCapability;
  /** Exact text a selection inserts. Never carries an executed action. */
  readonly insertedTemplate: string;
  readonly execution: ChatCommandExecution;
  /** At least one concrete example, shown alongside a syntax error. */
  readonly examples: readonly string[];
  /** Provider rows only: `<Engine>: <name>` (universal rows omit it). */
  readonly providerLabel?: string;
  /** Safe user copy when the command is unavailable on this host. */
  readonly reason?: string;
}

type UniversalSpec = Omit<
  ChatCommandDescriptorV2,
  "source" | "providerLabel" | "reason"
>;

/** The eight universal commands. Template strings are load-bearing: the
 * popover inserts them verbatim and the caret lands after the trailing space. */
const UNIVERSAL_SPECS: readonly UniversalSpec[] = Object.freeze([
  {
    id: "new",
    name: "new",
    description: "Start a new chat session",
    syntax: "/new",
    capability: "always",
    insertedTemplate: "/new ",
    execution: "new-session",
    examples: Object.freeze(["/new"]),
  },
  {
    id: "clear",
    name: "clear",
    description: "Clear this chat's transcript",
    syntax: "/clear",
    capability: "always",
    insertedTemplate: "/clear ",
    execution: "clear-session",
    examples: Object.freeze(["/clear"]),
  },
  {
    id: "help",
    name: "help",
    description: "Show the local slash-command reference",
    syntax: "/help",
    capability: "always",
    insertedTemplate: "/help ",
    execution: "help-card",
    examples: Object.freeze(["/help"]),
  },
  {
    id: "engine",
    name: "engine",
    description: "Show or switch the active chat engine",
    syntax: "/engine [name]",
    capability: "engine-switch",
    insertedTemplate: "/engine ",
    execution: "engine-picker",
    examples: Object.freeze(["/engine omp", "/engine"]),
  },
  {
    id: "model",
    name: "model",
    description: "Show or switch the active model role",
    syntax: "/model [role]",
    capability: "model-roles",
    insertedTemplate: "/model ",
    execution: "model-picker",
    examples: Object.freeze(["/model smart", "/model"]),
  },
  {
    id: "context",
    name: "context",
    description: "Inspect the grounded context for this session",
    syntax: "/context",
    capability: "always",
    insertedTemplate: "/context ",
    execution: "context-inspector",
    examples: Object.freeze(["/context"]),
  },
  {
    id: "export",
    name: "export",
    description: "Export the transcript as Markdown or JSON",
    syntax: "/export [markdown|json]",
    capability: "transcript-export",
    insertedTemplate: "/export ",
    execution: "export-flow",
    examples: Object.freeze(["/export markdown", "/export json"]),
  },
  {
    id: "resume",
    name: "resume",
    description: "Resume a saved UnicDB chat",
    syntax: "/resume",
    capability: "session-resume",
    insertedTemplate: "/resume ",
    execution: "resume-picker",
    examples: Object.freeze(["/resume"]),
  },
]);

/** The eight universal descriptors, frozen. Index `i` is `§UNIVERSAL_COMMAND_ORDER[i]`. */
export const ALL_UNIVERSAL_COMMANDS: readonly ChatCommandDescriptorV2[] = Object.freeze(
  UNIVERSAL_SPECS.map((spec) =>
    Object.freeze({
      ...spec,
      source: "universal" as const,
    }),
  ),
);

/** Alias kept for callers that read "the universal set" without the `ALL_` prefix. */
export const UNIVERSAL_COMMANDS = ALL_UNIVERSAL_COMMANDS;

const UNIVERSAL_BY_NAME: ReadonlyMap<string, ChatCommandDescriptorV2> = new Map(
  ALL_UNIVERSAL_COMMANDS.map((d) => [d.name, d]),
);

/** The two accepted `/export` formats — a closed vocabulary, not free text. */
const EXPORT_FORMATS: readonly string[] = Object.freeze(["markdown", "json"]);

// ===========================================================================
// Capability gate
// ===========================================================================

/** Everything the gate needs. `capabilities === null` means the host snapshot
 * has not arrived yet, so a capability-gated command fails closed. */
export interface CommandGateInput {
  readonly capabilities: EngineCapabilitySnapshot | null;
  /** Engine literals the host has a dispatch seam for (from capabilities). */
  readonly availableEngines: readonly string[];
  /** Model roles the host actually offers (empty → no role selector). */
  readonly modelRoles: readonly string[];
}

export interface CommandAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * Whether `descriptor` may be executed right now, with safe user copy when it
 * may not. Capability-gated commands fail closed on a missing snapshot: the UI
 * never promises an action the host has not proven it can perform.
 */
export function commandAvailability(
  descriptor: ChatCommandDescriptorV2,
  gate: CommandGateInput,
): CommandAvailability {
  const caps = gate.capabilities;
  switch (descriptor.capability) {
    case "always":
      return { available: true };
    case "engine-switch":
      return gate.availableEngines.length > 0
        ? { available: true }
        : { available: false, reason: "No chat engine is available in this workspace." };
    case "model-roles":
      return gate.modelRoles.length > 0
        ? { available: true }
        : { available: false, reason: "No model role is configured for this engine." };
    case "transcript-export":
      return caps === null || caps.supports.exportTranscript === true
        ? { available: true }
        : { available: false, reason: "This engine cannot export a transcript." };
    case "session-resume":
      return caps !== null &&
        (caps.supports.savedTranscriptResume === true ||
          caps.supports.nativeSessionResume === true)
        ? { available: true }
        : { available: false, reason: "No resumable session is available for this engine." };
    default:
      return { available: false, reason: "This command is not available." };
  }
}

// ===========================================================================
// Provider descriptors (capability-supplied, handler-verified)
// ===========================================================================

/** A safe command identifier: lowercase letters/digits/hyphens, never markup
 * and never a raw CLI string with whitespace or shell metacharacters. */
const SAFE_COMMAND_TOKEN = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * The model roles `/model` may actually select, in the caller's order and
 * deduplicated. Empty when the engine does not offer role selection
 * (`supports.modelRoles === false`, e.g. omp) or before the snapshot arrives —
 * so `/model <role>` fails closed instead of flipping to a role the engine
 * will ignore.
 */
export function advertisedModelRoles(
  capabilities: EngineCapabilitySnapshot | null,
  candidates: readonly string[],
): readonly string[] {
  if (capabilities === null || capabilities.supports.modelRoles !== true) {
    return Object.freeze([]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of candidates) {
    if (typeof role !== "string" || role.length === 0) continue;
    const key = role.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(role);
  }
  return Object.freeze(out);
}

/** Provider descriptors from a capability snapshot, filtered to those the host
 * has a verified handler for. A descriptor whose name is not a safe token is
 * dropped — hostile capability text never becomes a row. */
export function providerCommandsFromCapabilities(
  capabilities: EngineCapabilitySnapshot | null,
  isImplemented: (id: string) => boolean,
): readonly ChatCommandDescriptorV2[] {
  if (capabilities === null) return Object.freeze([]);
  const raw = Array.isArray(capabilities.commands) ? capabilities.commands : [];
  const out: ChatCommandDescriptorV2[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (c === null || typeof c !== "object") continue;
    if (c.source !== "provider") continue;
    const id = typeof c.id === "string" ? c.id : "";
    const name = typeof c.name === "string" ? c.name : "";
    if (!SAFE_COMMAND_TOKEN.test(id) || !SAFE_COMMAND_TOKEN.test(name)) continue;
    if (seen.has(name)) continue;
    if (!isImplemented(id)) continue;
    seen.add(name);
    const descriptor: ChatCommandDescriptorV2 = {
      id,
      name,
      description: typeof c.description === "string" ? c.description : "",
      syntax: typeof c.syntax === "string" && c.syntax.length > 0 ? c.syntax : `/${name}`,
      source: "provider",
      capability: "always",
      insertedTemplate:
        typeof c.insertedTemplate === "string" && c.insertedTemplate.length > 0
          ? c.insertedTemplate
          : `/${name} `,
      execution: "provider-handler",
      examples: Object.freeze([`/${name}`]),
      providerLabel: `${capabilities.displayName}: ${name}`,
    };
    const safe: ChatCommandDescriptorV2 =
      c.available === false
        ? { ...descriptor, reason: "This command is not available on the active engine." }
        : descriptor;
    out.push(Object.freeze(safe));
  }
  return Object.freeze(out);
}

/** Options for `resolveChatCommands`. */
export interface ResolveChatCommandsOptions {
  /** Host-side proof that a provider command id has an implemented handler. */
  readonly isProviderImplemented?: (id: string) => boolean;
}

/**
 * The full command list for the popover: universal descriptors first in frozen
 * order, then provider descriptors. A universal command always wins a name
 * collision, so selecting a name can never execute a provider handler instead.
 */
export function resolveChatCommands(
  gate: CommandGateInput,
  options: ResolveChatCommandsOptions = {},
): readonly ChatCommandDescriptorV2[] {
  const isImplemented = options.isProviderImplemented;
  const out: ChatCommandDescriptorV2[] = [];
  for (const descriptor of ALL_UNIVERSAL_COMMANDS) {
    const availability = commandAvailability(descriptor, gate);
    out.push(
      availability.available
        ? descriptor
        : Object.freeze({ ...descriptor, reason: availability.reason ?? "" }),
    );
  }
  if (isImplemented !== undefined) {
    for (const provider of providerCommandsFromCapabilities(gate.capabilities, isImplemented)) {
      if (UNIVERSAL_BY_NAME.has(provider.name)) continue; // universal wins
      out.push(provider);
    }
  }
  return Object.freeze(out);
}

// ===========================================================================
// Slash token + grammar
// ===========================================================================

/** The leading `/word` token the caret sits inside, or null when there is none. */
export interface SlashToken {
  readonly start: number;
  readonly end: number;
  /** Text after the `/`, up to the caret (never contains whitespace). */
  readonly query: string;
}

/**
 * The slash token at `caret`, or null. A token is eligible only when its `/`
 * begins the current logical line after optional spaces — so a URL, a path, a
 * mid-prose slash or an escaped slash never opens the popover.
 */
export function getSlashToken(text: string, caret: number): SlashToken | null {
  const len = text.length;
  const pos = Number.isFinite(caret) ? Math.min(Math.max(Math.trunc(caret), 0), len) : 0;
  if (pos <= 0) return null;

  let start = pos;
  while (start > 0) {
    const ch = text[start - 1]!;
    if (ch === "/" || /\s/.test(ch)) break;
    start--;
  }
  if (start === 0 || text[start - 1] !== "/") return null;
  const slash = start - 1;
  // The `/` must open the line: only spaces/tabs may precede it on this line,
  // and it must not be escaped by a preceding backslash.
  let lineStart = slash;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  for (let i = lineStart; i < slash; i++) {
    const ch = text[i]!;
    if (ch !== " " && ch !== "\t") return null;
  }
  if (slash > 0 && text[slash - 1] === "\\") return null;
  return { start: slash, end: pos, query: text.slice(slash + 1, pos) };
}

/** A corrective hint attached to a failed parse. */
export interface CommandParseError {
  readonly message: string;
  readonly syntax: string;
  readonly example: string;
}

export type ChatCommandParseStatus =
  | "valid"
  | "invalid-args"
  | "unknown"
  | "malformed"
  | "none";

export interface ChatCommandParse {
  readonly status: ChatCommandParseStatus;
  /** Command word (lowercased) when one was present, else null. */
  readonly name: string | null;
  readonly args: readonly string[];
  readonly descriptor: ChatCommandDescriptorV2 | null;
  readonly error: CommandParseError | null;
}

export interface ParseChatCommandOptions {
  readonly gate: CommandGateInput;
}

function none(): ChatCommandParse {
  return { status: "none", name: null, args: [], descriptor: null, error: null };
}

function hintFor(
  descriptor: ChatCommandDescriptorV2 | undefined,
  fallbackSyntax: string,
): CommandParseError {
  return {
    message: "That command's arguments are not valid.",
    syntax: descriptor?.syntax ?? fallbackSyntax,
    example: descriptor?.examples[0] ?? fallbackSyntax,
  };
}

/** Split the argument tail with the module's shell-like grammar. Returns null
 * on an unclosed quote so a malformed line is never half-applied. */
function splitArgs(text: string, from: number): string[] | null {
  const args: string[] = [];
  let i = from;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    let value = "";
    let quote: '"' | "'" | null = null;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") {
        i++;
        if (i >= text.length) return null;
        value += text[i]!;
        i++;
        continue;
      }
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
          i++;
        } else {
          value += ch;
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      value += ch;
      i++;
    }
    if (quote !== null) return null;
    args.push(value);
  }
  return args;
}

/** Case-insensitive membership without echoing the hostile input back. */
function includesFolded(values: readonly string[], value: string): boolean {
  const folded = value.toLowerCase();
  return values.some((v) => v.toLowerCase() === folded);
}

/** Validate the argument list of a universal command against host facts.
 * Comparisons are case-insensitive (a user typing `Claude-Code` means the
 * advertised `claude-code`); the stored argument keeps the bytes the user
 * typed so an insertion template round-trips exactly. */
function validateArgs(
  name: UniversalCommandName,
  args: readonly string[],
  gate: CommandGateInput,
): boolean {
  switch (name) {
    case "engine":
      // No argument → picker. With an argument, it must be an advertised engine.
      return args.length <= 1 && (args.length === 0 || includesFolded(gate.availableEngines, args[0]!));
    case "model":
      return args.length <= 1 && (args.length === 0 || includesFolded(gate.modelRoles, args[0]!));
    case "export":
      // No argument → default flow. With one, it must be an accepted format.
      return (
        args.length <= 1 &&
        (args.length === 0 || includesFolded(EXPORT_FORMATS, args[0]!))
      );
    case "new":
    case "clear":
    case "help":
    case "context":
    case "resume":
      return args.length === 0;
    default:
      return false;
  }
}

/**
 * Parse a complete input line into a validated command result. Ordinary prose
 * and a bare `/` are `none`; a command word the registry does not know is
 * `unknown` (the caller offers "Send as message"); a known command with
 * unacceptable arguments is `invalid-args` carrying the syntax and one example.
 */
export function parseChatCommand(
  input: string,
  options: ParseChatCommandOptions,
): ChatCommandParse {
  const text = input.trim();
  if (!text.startsWith("/")) return none();

  let i = 1;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  const rawName = text.slice(1, i);
  if (rawName.length === 0) return none();
  const name = rawName.toLowerCase();

  const args = splitArgs(text, i);
  if (args === null) {
    return {
      status: "malformed",
      name,
      args: [],
      descriptor: null,
      error: hintFor(undefined, `/${name}`),
    };
  }

  const descriptor = UNIVERSAL_BY_NAME.get(name);
  if (descriptor === undefined) {
    return {
      status: "unknown",
      name,
      args,
      descriptor: null,
      error: {
        message: `Unknown command /${name}.`,
        syntax: `/${name}`,
        example: "/help",
      },
    };
  }

  if (!validateArgs(name as UniversalCommandName, args, options.gate)) {
    return {
      status: "invalid-args",
      name,
      args,
      descriptor,
      error: hintFor(descriptor, descriptor.syntax),
    };
  }

  return { status: "valid", name, args, descriptor, error: null };
}
