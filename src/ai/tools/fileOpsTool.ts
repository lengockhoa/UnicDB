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
import { buildUnifiedDiff, diffStats } from "../fileDiff";

export interface FileOpsDeps {
  readFile: (path: string) => Promise<string>;
  /**
   * Host MUST implement temp-write + rename (atomic replacement) AND a
   * compare-and-swap: when expectedOld is provided the host re-reads the
   * target right before the rename and MUST reject (throw) when it differs
   * — closing the check→write TOCTOU window.
   */
  writeFile: (path: string, content: string, expectedOld?: string) => Promise<void>;
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

type Reason =
  | "outside-workspace"
  | "permission-denied"
  | "not-found"
  | "write-failed"
  | "stale-preview"
  | "bad-args";

function envelope(reason: Reason, detail?: string): string {
  return JSON.stringify(detail === undefined ? { applied: false, reason } : { applied: false, reason, detail });
}

/** JSON envelope the permission gate returns when the user denies. */
export function fileOpsDeniedEnvelope(): string {
  return envelope("permission-denied");
}

/**
 * Per-call snapshot carry: the preview computes and returns the file
 * snapshot it rendered; the registration (aiChatPanel) binds that snapshot
 * to THE individual permission request, so two concurrent cards for the
 * same path can never approve against each other's snapshot. The snapshot
 * rides on the execute args as `__UnicDBExpectedOld` (stripped before the
 * model-visible envelope contract; also passed to the host writeFile CAS).
 */
const SNAPSHOT_ARG = "__UnicDBExpectedOld";

export interface FileOpsPreview {
  card: string | undefined;
  /** undefined when no snapshot was captured (bad-args/out-of-scope/missing). */
  snapshot?: string;
}

/**
 * Build the permission-card preview BEFORE the user decides: reads the
 * current file and renders the same capped unified diff the write would
 * apply, returning the snapshot for request-scoped binding.
 */
export function createFileOpsPreview(
  deps: Pick<FileOpsDeps, "readFile" | "files">,
): (args: Record<string, unknown>) => Promise<FileOpsPreview | undefined> {
  return async (args) => {
    const path = typeof args["path"] === "string" ? args["path"] : undefined;
    const newContent = typeof args["newContent"] === "string" ? args["newContent"] : undefined;
    if (path === undefined || newContent === undefined) return { card: undefined };
    if (!deps.files.includes(path)) return { card: undefined };
    let old: string;
    try {
      old = await deps.readFile(path);
    } catch {
      return { card: undefined };
    }
    const stats = diffStats(old, newContent);
    const diff = buildUnifiedDiff(old, newContent);
    const head = `proposed ${path} (+${stats.added} -${stats.removed})`;
    return {
      card: diff === "" ? `${head} — no changes` : `${head}\n${diff}`,
      snapshot: old,
    };
  };
}

export function createFileOpsTool(deps: FileOpsDeps): AgentTool {
  return {
    name: "workspace_write",
    description:
      "Propose an edit to ONE workspace file (exact allowlist paths only). " +
      "Returns a unified diff preview; the user must explicitly approve before " +
      "anything is written. Writes are atomic (temp+rename by the host) and " +
      "compare-and-swapped against the previewed snapshot — the host refuses " +
      "and the tool returns reason=stale-preview if the file changed after " +
      "the preview the user approved.",
    parameters: SCHEMA,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const path = typeof args["path"] === "string" ? args["path"] : undefined;
      const newContent = typeof args["newContent"] === "string" ? args["newContent"] : undefined;
      const expectedOld = typeof args[SNAPSHOT_ARG] === "string" ? (args[SNAPSHOT_ARG] as string) : undefined;
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
      // Freshness (approval-scope): refuse when the file no longer matches
      // the snapshot bound to THIS permission decision.
      if (expectedOld !== undefined && expectedOld !== old) {
        return envelope("stale-preview", path);
      }
      const diff = buildUnifiedDiff(old, newContent);
      if (diff === "") {
        return JSON.stringify({ applied: true, path, diff: "", unchanged: true });
      }
      try {
        // CAS: the host re-checks expectedOld right before the rename.
        await deps.writeFile(path, newContent, expectedOld);
      } catch (err) {
        return envelope("write-failed", err instanceof Error ? err.message : String(err));
      }
      return JSON.stringify({ applied: true, path, diff });
    },
  };
}
