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
