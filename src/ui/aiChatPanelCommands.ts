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
