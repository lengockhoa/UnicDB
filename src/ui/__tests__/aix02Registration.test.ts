// src/ui/__tests__/aix02Registration.test.ts
// TASK-AIX02-003 — workspace_write registration policy + gate + card detail.
import { describe, it, expect } from "vitest";
import { createFileOpsTool, createFileOpsPreview, fileOpsDeniedEnvelope } from "../../ai/tools/fileOpsTool";
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
  it("preview renders the computed diff BEFORE the write + carries snapshot", async () => {
    const preview = createFileOpsPreview({
      files: ["a.txt"],
      readFile: async () => "old\n",
    });
    const p = await preview({ path: "a.txt", newContent: "new\n" });
    expect(p).toBeDefined();
    expect(p!.card).toContain("a.txt (+1 -1)");
    expect(p!.card).toContain("-old");
    expect(p!.card).toContain("+new");
    expect(p!.card).toContain("@@");
    expect(p!.snapshot).toBe("old\n");
  });

  it("preview falls back to card undefined outside scope / missing file", async () => {
    const preview = createFileOpsPreview({
      files: ["a.txt"],
      readFile: async () => {
        throw new Error("gone");
      },
    });
    const a = await preview({ path: "other.txt", newContent: "x" });
    expect(a?.card).toBeUndefined();
    const b = await preview({ path: "a.txt", newContent: "x" });
    expect(b?.card).toBeUndefined();
  });

  // AIX-02 review round 3: snapshots are REQUEST-SCOPED — two concurrent
  // cards for the same path keep their own snapshots; approving card 1 can
  // never pass card 2's snapshot (the old shared-Map ledger bug).
  it("concurrent cards keep separate snapshots", async () => {
    const content = { v: "old\n" };
    const deps = {
      files: ["a.txt"],
      readFile: async () => content.v,
      writeFile: async () => {},
    };
    const preview = createFileOpsPreview(deps);
    const tool = createFileOpsTool(deps);
    const card1 = await preview({ path: "a.txt", newContent: "v1\n" });
    content.v = "changed meanwhile\n";
    const card2 = await preview({ path: "a.txt", newContent: "v2\n" });
    // Approving card 1: its OWN snapshot (old) no longer matches → refused.
    const r1 = JSON.parse(
      await tool.execute({
        path: "a.txt",
        newContent: "v1\n",
        __vsdbExpectedOld: card1!.snapshot,
      }),
    );
    expect(r1).toEqual({ applied: false, reason: "stale-preview", detail: "a.txt" });
    // Approving card 2: its snapshot matches → write proceeds with CAS.
    const r2 = JSON.parse(
      await tool.execute({
        path: "a.txt",
        newContent: "v2\n",
        __vsdbExpectedOld: card2!.snapshot,
      }),
    );
    expect(r2.applied).toBe(true);
  });

  it("host CAS: write-failed when the host rejects at rename time (race)", async () => {
    // Tool-level check passes (expectedOld matches the read), but the host
    // CAS re-read sees different bytes — models the check→rename race.
    let flips = 0;
    const tool = createFileOpsTool({
      files: ["a.txt"],
      readFile: async () => "old\n",
      writeFile: async (_p, _c, expected) => {
        flips++;
        if (flips === 2) throw new Error("conflict: file changed since the approved preview");
      },
    });
    const ok = JSON.parse(
      await tool.execute({ path: "a.txt", newContent: "new\n", __vsdbExpectedOld: "old\n" }),
    );
    expect(ok.applied).toBe(true);
    const raced = JSON.parse(
      await tool.execute({ path: "a.txt", newContent: "new2\n", __vsdbExpectedOld: "old\n" }),
    );
    expect(raced.applied).toBe(false);
    expect(raced.reason).toBe("write-failed");
    expect(raced.detail).toContain("conflict");
  });

  // AIX-02 review round 2/3: stale-preview protection is request-scoped —
  // the snapshot bound to THIS decision must match at execute time.
  it("execute refuses when the bound snapshot no longer matches", async () => {
    let current = "old\n";
    let writes = 0;
    const deps = {
      files: ["a.txt"],
      readFile: async () => current,
      writeFile: async () => {
        writes++;
      },
    };
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(
      await tool.execute({ path: "a.txt", newContent: "new\n", __vsdbExpectedOld: "old\n" }),
    );
    current = "changed elsewhere\n";
    // Re-execute with the SAME bound snapshot after the file changed → refused.
    const stale = JSON.parse(
      await tool.execute({ path: "a.txt", newContent: "new\n", __vsdbExpectedOld: "old\n" }),
    );
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe("stale-preview");
    expect(writes).toBe(1); // only the first (fresh) write happened
  });

  it("execute without a bound snapshot still works (single-shot path)", async () => {
    let writes = 0;
    const deps = {
      files: ["a.txt"],
      readFile: async () => "old\n",
      writeFile: async () => {
        writes++;
      },
    };
    const tool = createFileOpsTool(deps);
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
