// src/ai/tools/__tests__/fileOpsTool.test.ts
// TASK-AIX02-002 — workspace_write tool: allowlist scope, permission no-op,
// atomic-write contract, JSON envelope. Pure over injected deps.
import { describe, it, expect } from "vitest";
import { createFileOpsTool } from "../fileOpsTool";

function makeDeps(overrides: Partial<Parameters<typeof createFileOpsTool>[0]> = {}) {
  const files = new Map<string, string>([["src/a.ts", "old\ncontent\n"]]);
  const writes: Array<{ path: string; content: string }> = [];
  return {
    files: ["src/a.ts"],
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    writeFile: async (p: string, content: string) => {
      writes.push({ path: p, content });
    },
    writes,
    ...overrides,
  };
}

describe("workspace_write", () => {
  it("outside-root path → outside-workspace, no write", async () => {
    const deps = makeDeps();
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(
      await tool.execute({ path: "../../etc/passwd", newContent: "x" }),
    );
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("outside-workspace");
    expect(deps.writes.length).toBe(0);
  });

  it("traversal via src/../ escape → still outside (exact membership only)", async () => {
    const deps = makeDeps({ files: ["src/a.ts"] });
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(
      await tool.execute({ path: "src/../src/a.ts", newContent: "x" }),
    );
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("outside-workspace");
    expect(deps.writes.length).toBe(0);
  });

  it("permissionDenied → permission-denied, no read/write", async () => {
    const deps = makeDeps({ permissionDenied: true });
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(
      await tool.execute({ path: "src/a.ts", newContent: "x" }),
    );
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("permission-denied");
    expect(deps.writes.length).toBe(0);
  });

  it("read failure → not-found, no write", async () => {
    const deps = makeDeps();
    const tool = createFileOpsTool(deps);
    // File is allowlisted (host listed it) but read fails — e.g. deleted
    // after the allowlist was curated.
    deps.files = ["src/a.ts", "src/missing.ts"];
    const res = JSON.parse(
      await tool.execute({ path: "src/missing.ts", newContent: "x" }),
    );
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("not-found");
    expect(deps.writes.length).toBe(0);
  });

  it("write throws → write-failed envelope with detail", async () => {
    const deps = makeDeps({
      writeFile: async () => {
        throw new Error("EACCES: boom");
      },
    });
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(
      await tool.execute({ path: "src/a.ts", newContent: "new\n" }),
    );
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("write-failed");
    expect(res.detail).toContain("EACCES");
  });

  it("happy path → applied true + unified diff; one write with new content", async () => {
    const deps = makeDeps();
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(
      await tool.execute({ path: "src/a.ts", newContent: "new\ncontent\n" }),
    );
    expect(res.applied).toBe(true);
    expect(res.path).toBe("src/a.ts");
    expect(res.diff).toContain("-old");
    expect(res.diff).toContain("+new");
    expect(deps.writes).toEqual([{ path: "src/a.ts", content: "new\ncontent\n" }]);
  });

  it("args validation: missing newContent → rejected envelope, no write", async () => {
    const deps = makeDeps();
    const tool = createFileOpsTool(deps);
    const res = JSON.parse(await tool.execute({ path: "src/a.ts" }));
    expect(res.applied).toBe(false);
    expect(deps.writes.length).toBe(0);
  });
});
