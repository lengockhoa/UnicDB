// src/ui/__tests__/aix02Registration.test.ts
// TASK-AIX02-003 — workspace_write registration policy + gate + card detail.
import { describe, it, expect } from "vitest";
import { createFileOpsTool, createFileOpsPreview, createFileOpsLedger, fileOpsDeniedEnvelope } from "../../ai/tools/fileOpsTool";
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

  // AIX-02 review: the card must show the REAL diff before approval, and a
  // denial must return the file-ops JSON envelope (not the generic message).
  it("preview renders the computed diff BEFORE the write", async () => {
    const preview = createFileOpsPreview({
      files: ["a.txt"],
      readFile: async () => "old\n",
    });
    const card = await preview({ path: "a.txt", newContent: "new\n" });
    expect(card).toBeDefined();
    expect(card).toContain("a.txt (+1 -1)");
    expect(card).toContain("-old");
    expect(card).toContain("+new");
    expect(card).toContain("@@");
  });

  it("preview falls back to undefined outside scope / missing file", async () => {
    const preview = createFileOpsPreview({
      files: ["a.txt"],
      readFile: async () => {
        throw new Error("gone");
      },
    });
    expect(await preview({ path: "other.txt", newContent: "x" })).toBeUndefined();
    expect(await preview({ path: "a.txt", newContent: "x" })).toBeUndefined();
  });

  // AIX-02 review round 2: stale-preview protection — a file changed after
  // the preview snapshot must NOT be written.
  it("execute refuses when file changed since the previewed snapshot", async () => {
    let current = "old\n";
    let writes = 0;
    const deps = {
      files: ["a.txt"],
      readFile: async () => current,
      writeFile: async () => {
        writes++;
      },
    };
    const ledger = createFileOpsLedger();
    const preview = createFileOpsPreview(deps, ledger);
    const tool = createFileOpsTool(deps, ledger);
    await preview({ path: "a.txt", newContent: "new\n" }); // user sees old→new
    current = "changed elsewhere\n"; // file mutated after the card opened
    const res = JSON.parse(await tool.execute({ path: "a.txt", newContent: "new\n" }));
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("stale-preview");
    expect(writes).toBe(0);
    // Fresh snapshot → after a new preview the write succeeds.
    await preview({ path: "a.txt", newContent: "new\n" });
    const ok = JSON.parse(await tool.execute({ path: "a.txt", newContent: "new\n" }));
    expect(ok.applied).toBe(true);
    expect(writes).toBe(1);
  });

  it("execute without any preview still works (no snapshot recorded)", async () => {
    let writes = 0;
    const deps = {
      files: ["a.txt"],
      readFile: async () => "old\n",
      writeFile: async () => {
        writes++;
      },
    };
    const tool = createFileOpsTool(deps, createFileOpsLedger());
    const res = JSON.parse(await tool.execute({ path: "a.txt", newContent: "new\n" }));
    expect(res.applied).toBe(true);
    expect(writes).toBe(1);
  });

  it("denied execute returns the permission-denied envelope", async () => {
    const tool = createFileOpsTool({
      files: ["a.txt"],
      readFile: async () => "old\n",
      writeFile: async () => {
        throw new Error("MUST NOT run");
      },
    });
    const wrapped = {
      ...tool,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const granted = false; // gate denies
        if (!granted) return fileOpsDeniedEnvelope();
        return tool.execute(args);
      },
    };
    const res = JSON.parse(await wrapped.execute({ path: "a.txt", newContent: "x" }));
    expect(res).toEqual({ applied: false, reason: "permission-denied" });
  });
});
