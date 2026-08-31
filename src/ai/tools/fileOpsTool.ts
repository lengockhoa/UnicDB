// src/ai/tools/fileOpsTool.ts — TASK-AIX02-002
// `workspace_write` AgentTool: the model proposes a whole-file edit; the tool
// verifies scope (exact host-curated allowlist membership — no path math, so
// traversal cannot widen scope), builds a unified diff preview, and performs
// the write THROUGH the injected host callback (temp+rename atomicity is the
// host's contract). Never throws: every failure is a JSON envelope.
// Pure — NO vscode import, NO fs, NO child_process. Permission is enforced
// upstream by DbToolPermissionGate; `permissionDenied` mirrors that deny for
// defense-in-depth and tests.
import type { AgentTool } from "../agent";
import { buildUnifiedDiff } from "../fileDiff";

export interface FileOpsDeps {
  readFile: (path: string) => Promise<string>;
  /** Host MUST implement temp-write + rename (atomic replacement). */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Host-curated workspace allowlist (grounding file list). Exact strings. */
  files: readonly string[];
  /** Test/debug escape hatch: mirror a denied permission decision. */
  permissionDenied?: boolean;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "Workspace-relative file path (exact allowlist match)" },
    newContent: { type: "string", description: "Complete new file content" },
  },
  required: ["path", "newContent"],
  additionalProperties: false,
};

type Reason = "outside-workspace" | "permission-denied" | "not-found" | "write-failed" | "bad-args";

function envelope(reason: Reason, detail?: string): string {
  return JSON.stringify(detail === undefined ? { applied: false, reason } : { applied: false, reason, detail });
}

export function createFileOpsTool(deps: FileOpsDeps): AgentTool {
  return {
    name: "workspace_write",
    description:
      "Propose an edit to ONE workspace file (exact allowlist paths only). " +
      "Returns a unified diff preview; the user must explicitly approve before " +
      "anything is written. Writes are atomic (temp+rename by the host).",
    parameters: SCHEMA,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const path = typeof args["path"] === "string" ? args["path"] : undefined;
      const newContent = typeof args["newContent"] === "string" ? args["newContent"] : undefined;
      if (path === undefined || newContent === undefined) {
        return envelope("bad-args", "path and newContent are required strings");
      }
      if (deps.permissionDenied) return envelope("permission-denied");
      // Scope: EXACT membership against the host-curated allowlist. No path
      // normalization, no prefix matching — `src/../x` can never widen scope.
      if (!deps.files.includes(path)) return envelope("outside-workspace");
      let old: string;
      try {
        old = await deps.readFile(path);
      } catch {
        return envelope("not-found", path);
      }
      const diff = buildUnifiedDiff(old, newContent);
      if (diff === "") {
        return JSON.stringify({ applied: true, path, diff: "", unchanged: true });
      }
      try {
        await deps.writeFile(path, newContent);
      } catch (err) {
        return envelope("write-failed", err instanceof Error ? err.message : String(err));
      }
      return JSON.stringify({ applied: true, path, diff });
    },
  };
}
