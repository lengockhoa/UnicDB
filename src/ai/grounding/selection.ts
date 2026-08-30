// src/ai/grounding/selection.ts — TASK-AIX01-001
// Bounded editor selection grounding. Pure: no vscode, no fs.

export const MAX_SELECTION_CHARS = 8_000;

export interface GroundedSelection {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface SelectionInput {
  path: string;
  text: string;
  startLine?: number;
  endLine?: number;
}

const BLANK_LINE = /^\s*$/;

/** Trim leading/trailing blank lines from `text` (no other normalization). */
function trimBlankEdges(text: string): { trimmed: string; lead: number } {
  const lines = text.split("\n");
  let lead = 0;
  while (lead < lines.length && BLANK_LINE.test(lines[lead])) lead += 1;
  let trail = lines.length;
  while (trail > lead && BLANK_LINE.test(lines[trail - 1])) trail -= 1;
  return { trimmed: lines.slice(lead, trail).join("\n"), lead };
}

export function extractSelection(input: SelectionInput): GroundedSelection | null {
  if (typeof input?.text !== "string") return null;
  const { trimmed, lead } = trimBlankEdges(input.text);
  if (trimmed.length === 0) return null;

  const total = trimmed.split("\n").length;
  const requestedStart = typeof input.startLine === "number" ? input.startLine : 1;
  const requestedEnd = typeof input.endLine === "number" ? input.endLine : total;
  const startLine = Math.max(1, Math.min(requestedStart, total));
  const endLine = Math.max(startLine, Math.min(requestedEnd, total));

  let text = trimmed;
  let truncated = false;
  if (text.length > MAX_SELECTION_CHARS) {
    text = text.slice(0, MAX_SELECTION_CHARS);
    truncated = true;
  }

  return { path: input.path, startLine: startLine + lead, endLine: endLine + lead, text, truncated };
}

export function formatSelectionBlock(sel: GroundedSelection): string {
  return `${sel.path}:${sel.startLine}-${sel.endLine}\n${sel.text}`;
}
