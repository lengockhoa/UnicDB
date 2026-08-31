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
 * Freshness ledger shared by the preview and execute halves of ONE
 * workspace_write registration: the preview records the snapshot the user
 * approved; execute refuses to write if the file changed since that
 * snapshot (stale-approval protection).
 */
export function createFileOpsLedger(): {
  record: (path: string, seen: string) => void;
  check: (path: string, current: string) => boolean;
} {
  const seen = new Map<string, string>();
  return {
    record: (path, snapshot) => {
      seen.set(path, snapshot);
    },
    check: (path, current) => {
      const snapshot = seen.get(path);
      return snapshot === undefined || snapshot === current;
    },
  };
}

/**
 * Build the permission-card preview BEFORE the user decides: reads the
 * current file and renders the same capped unified diff the write would
 * apply. Also records the read snapshot for execute-time freshness.
 * Returns undefined for bad-args/outside-workspace/not-found so the card
 * falls back to the plain args summary (the tool's own execute will still
 * produce the precise envelope).
 */
export function createFileOpsPreview(
  deps: Pick<FileOpsDeps, "readFile" | "files">,
  ledger = createFileOpsLedger(),
): (args: Record<string, unknown>) => Promise<string | undefined> {
  return async (args) => {
    const path = typeof args["path"] === "string" ? args["path"] : undefined;
    const newContent = typeof args["newContent"] === "string" ? args["newContent"] : undefined;
    if (path === undefined || newContent === undefined) return undefined;
    if (!deps.files.includes(path)) return undefined;
    let old: string;
    try {
      old = await deps.readFile(path);
    } catch {
      return undefined;
    }
    ledger.record(path, old);
    const stats = diffStats(old, newContent);
    const diff = buildUnifiedDiff(old, newContent);
    const head = `proposed ${path} (+${stats.added} -${stats.removed})`;
    return diff === "" ? `${head} — no changes` : `${head}\n${diff}`;
  };
}

export function createFileOpsTool(deps: FileOpsDeps, ledger = createFileOpsLedger()): AgentTool {
  return {
    name: "workspace_write",
    description:
      "Propose an edit to ONE workspace file (exact allowlist paths only). " +
      "Returns a unified diff preview; the user must explicitly approve before " +
      "anything is written. Writes are atomic (temp+rename by the host). " +
      "Refuses with reason=stale-preview if the file changed after the " +
      "previewed snapshot.",
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
      // Freshness: refuse when the file no longer matches the previewed
      // snapshot the approval was based on.
      if (!ledger.check(path, old)) {
        return envelope("stale-preview", path);
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
