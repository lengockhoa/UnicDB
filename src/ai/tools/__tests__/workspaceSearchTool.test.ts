import { describe, expect, it } from "vitest";
import { createWorkspaceSearchTool } from "../workspaceSearchTool";

describe("workspace_search tool", () => {
  it("exposes a JSON Schema parameters object", () => {
    const tool = createWorkspaceSearchTool({
      readFile: () => Promise.resolve(""),
      files: [],
    });
    expect(tool.name).toBe("workspace_search");
    expect(tool.parameters).toBeTypeOf("object");
    expect((tool.parameters as { properties?: unknown }).properties).toBeDefined();
  });

  it("returns JSON-encoded hits (string, not object)", async () => {
    const tool = createWorkspaceSearchTool({
      readFile: () => Promise.resolve("alpha"),
      files: ["a.ts"],
    });
    const out = await tool.execute({ terms: ["alpha"] });
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out);
    expect(parsed.excluded).toEqual([]);
    expect(Array.isArray(parsed.hits)).toBe(true);
  });

  it("returns attributed no-op JSON on permission denial", async () => {
    const tool = createWorkspaceSearchTool({
      readFile: () => Promise.resolve(""),
      files: [],
      permissionDenied: true,
    });
    const out = await tool.execute({ terms: ["alpha"] });
    const parsed = JSON.parse(out) as { permission?: string; hits?: unknown[] };
    expect(parsed.permission).toBe("denied");
    expect(parsed.hits).toEqual([]);
  });

  it("is deterministic for the same inputs (sorted output)", async () => {
    const t = createWorkspaceSearchTool({
      readFile: () => Promise.resolve("alpha"),
      files: ["a.ts", "b.ts"],
    });
    const a = await t.execute({ terms: ["alpha"] });
    const b = await t.execute({ terms: ["alpha"] });
    expect(a).toBe(b);
  });

  it("returns an empty list for empty terms", async () => {
    const t = createWorkspaceSearchTool({
      readFile: () => Promise.resolve("alpha"),
      files: ["a.ts"],
    });
    const out = await t.execute({ terms: [] });
    const parsed = JSON.parse(out) as { hits: unknown[] };
    expect(parsed.hits).toEqual([]);
  });
});
