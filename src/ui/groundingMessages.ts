// src/ui/groundingMessages.ts — TASK-AIX01-003
// Wire types for the host↔webview grounding channel.

export type GroundingStateMsg = {
  type: "grounding_state";
  selectionPath: string | null;
  fileCount: number;
  excludedCount: number;
  turnId: string;
};

export type GroundingToggleMsg = {
  type: "grounding_toggle";
  enabled: boolean;
};

export function isGroundingToggle(msg: unknown): msg is GroundingToggleMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { type?: unknown; enabled?: unknown };
  return m.type === "grounding_toggle" && typeof m.enabled === "boolean";
}
