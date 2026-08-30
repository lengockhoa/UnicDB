// src/ai/tools/workspaceSearchTool.ts — TASK-AIX01-003
// Read-only AgentTool: the model can ask for bounded, attributed
// file hits inside a turn. Permission-gated (default-deny) by the
// existing DbToolPermissionGate path in the host. Pure over injected
// file contents — host owns fs.

import { searchWorkspaceFiles, MAX_FILE_HITS, MAX_CONTEXT_LINES, type GroundedFile } from "../../ai/grounding/fileSearch";
import type { AgentTool } from "../agent";

const NOOP_HITS = JSON.stringify({ hits: [], excluded: [], permission: "denied" });

export interface WorkspaceSearchDeps {
  readFile: (path: string) => Promise<string>;
  files: readonly string[];
  /** When true (debug/test only), bypass and emit a no-op JSON. */
  permissionDenied?: boolean;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terms: { type: "array", items: { type: "string" }, description: "Search terms" },
    glob: { type: "string", description: "Optional path glob (e.g. src/**)" },
  },
  required: ["terms"],
  additionalProperties: false,
};

export function createWorkspaceSearchTool(deps: WorkspaceSearchDeps): AgentTool {
  return {
    name: "workspace_search",
    description:
      "Bounded, attributed file hits (max " +
      MAX_FILE_HITS +
      " files, " +
      MAX_CONTEXT_LINES +
      " total lines). Returns JSON { hits, excluded }.",
    parameters: SCHEMA,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      if (deps.permissionDenied) return NOOP_HITS;
      const termsRaw = args["terms"];
      const terms: string[] = Array.isArray(termsRaw)
        ? termsRaw.filter((t): t is string => typeof t === "string")
        : [];
      const glob = typeof args["glob"] === "string" ? (args["glob"] as string) : undefined;
      if (terms.length === 0) return JSON.stringify({ hits: [], excluded: [] });

      const files: GroundedFile[] = [];
      const excluded: string[] = [];
      for (const p of deps.files) {
        let content: string;
        try {
          content = await deps.readFile(p);
        } catch {
          excluded.push(p);
          continue;
        }
        files.push({ path: p, content });
      }
      const r = searchWorkspaceFiles(files, { terms, glob });
      return JSON.stringify({ hits: r.hits, excluded: r.excluded });
    },
  };
}
