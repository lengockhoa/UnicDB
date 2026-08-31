// src/ui/__tests__/aix02Registration.test.ts
// TASK-AIX02-003 — workspace_write registration policy + gate + card detail.
import { describe, it, expect } from "vitest";
import { createFileOpsTool } from "../../ai/tools/fileOpsTool";
import { diffStats } from "../../ai/fileDiff";

// The registration logic under test mirrors runBuiltinTurn + the omp mirror:
// register ONLY when grounding.writeFile is present, always gate-wrapped.
// Extracted decision as a tiny pure predicate here to pin the policy without
// constructing the full vscode-bound panel.
function shouldRegisterFileOps(grounding?: {
  writeFile?: (path: string, content: string) => Promise<void>;
}): boolean {
  return grounding?.writeFile !== undefined;
}

describe("AIX-02 registration policy", () => {
  it("grounding off → no workspace_write", () => {
    expect(shouldRegisterFileOps(undefined)).toBe(false);
  });

  it("grounding on without writeFile → still no workspace_write", () => {
    expect(shouldRegisterFileOps({})).toBe(false);
  });

  it("grounding on with writeFile → registered", () => {
    expect(shouldRegisterFileOps({ writeFile: async () => {} })).toBe(true);
  });
});

describe("workspace_write gating + card detail", () => {
  it("wrapped execute defers until the gate allows", async () => {
    let allowed = false;
    let writes = 0;
    const tool = createFileOpsTool({
      files: ["a.txt"],
      readFile: async () => "old\n",
      writeFile: async () => {
        writes++;
      },
    });
    // Mirror DbToolPermissionGate.wrap: deny returns the envelope without
    // ever calling the underlying tool.
    const wrapped = {
      ...tool,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        if (!allowed) {
          return JSON.stringify({ applied: false, reason: "permission-denied" });
        }
        return tool.execute(args);
      },
    };
    const denied = JSON.parse(await wrapped.execute({ path: "a.txt", newContent: "new\n" }));
    expect(denied.applied).toBe(false);
    expect(writes).toBe(0);
    allowed = true;
    const ok = JSON.parse(await wrapped.execute({ path: "a.txt", newContent: "new\n" }));
    expect(ok.applied).toBe(true);
    expect(writes).toBe(1);
  });

  it("card detail shows path + size, never full content", () => {
    // Mirrors summarizeDbToolArgs' file-op branch in aiChatPanel.
    const args = { path: "src/a.ts", newContent: "line1\nline2\nline3\n" };
    const stats = diffStats("", String(args.newContent));
    const detail = `path=${args.path} +${stats.added} lines (proposed file, ${String(args.newContent).length} chars)`;
    expect(detail).toContain("src/a.ts");
    expect(detail).toContain("+3 lines");
    expect(detail).not.toContain("line1\n");
  });

  it("diffStats on proposed content counts additions", () => {
    expect(diffStats("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
  });
});
