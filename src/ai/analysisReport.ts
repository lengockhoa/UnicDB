// src/ai/analysisReport.ts — TASK-AIX03-001
// PURE analysis-report helpers for the AIX-03 Database Analysis Copilot.
// NO vscode, NO fs, NO net. Consumers: panel tool-call cards (shape-only
// summaries) and the analysis tools.

export interface ExplainPlanSummary {
  /** Number of non-empty lines in the text plan. */
  nodes: number;
  /** Last non-empty line, trimmed — the leaf operation. */
  deepest: string;
}

/** Parse a text EXPLAIN plan into a compact shape summary. */
export function parseExplainPlan(planText: string): ExplainPlanSummary {
  const lines = planText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return {
    nodes: lines.length,
    deepest: lines.length > 0 ? (lines[lines.length - 1] ?? "") : "",
  };
}

export type ToolStatus = "ok" | "failed" | "denied";

/** One compact card line for a visible tool-call card. Status decides the
 * shape: denied is fixed text (shape is irrelevant), failed shows the
 * reason, ok shows the shape summary. */
export function summarizeToolOutcome(
  tool: string,
  status: ToolStatus,
  shape: string,
): string {
  if (status === "denied") return `✗ ${tool} — denied by user`;
  if (status === "failed") return `✗ ${tool} — failed: ${shape}`;
  return `✓ ${tool} — ${shape}`;
}

/** Keep at most `max` whitespace-separated tokens, appending `…` when
 * truncated. Non-positive max → just the ellipsis. Whitespace is collapsed. */
export function capTokens(text: string, max: number): string {
  if (max <= 0) return "…";
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length <= max) return tokens.join(" ");
  return `${tokens.slice(0, max).join(" ")} …`;
}
