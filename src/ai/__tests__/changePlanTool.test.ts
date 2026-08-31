// src/ai/__tests__/changePlanTool.test.ts — TASK-AIX04-002
import { describe, it, expect } from "vitest";
import { createPlanChangeTool } from "../tools/changePlanTool";
import type { AdapterFactory } from "../tools/types";

function spyAdapter() {
  let runCalls = 0;
  const f: AdapterFactory = () =>
    Promise.resolve({
      runQuery: () => {
        runCalls++;
        return Promise.resolve({ results: [] });
      },
    } as never);
  return { f, get runCalls() { return runCalls; } };
}

function fingerprint(cols: string[]) {
  return (_schema: string, _table: string) => Promise.resolve(cols);
}

describe("plan_change tool", () => {
  it("returns classified plan envelope; NEVER executes statements", async () => {
    const { f, runCalls } = spyAdapter();
    const tool = createPlanChangeTool(f, fingerprint(["a", "b"]));
    const out = JSON.parse(
      await tool.execute({
        intent: "add column c",
        statements: ["ALTER TABLE users ADD COLUMN c int", "DROP TABLE x"],
        targetTable: "users",
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.plan.statements).toHaveLength(2);
    expect(out.plan.statements[0].tier).toBe("none");
    expect(out.plan.statements[1].tier).toBe("red");
    expect(runCalls).toBe(0); // plan only — no execution
  });

  it("missing statements → error envelope", async () => {
    const { f } = spyAdapter();
    const tool = createPlanChangeTool(f, fingerprint([]));
    const out = JSON.parse(
      await tool.execute({ intent: "drop something" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("SQL statement");
  });

  it("bad targetTable → error envelope, no adapter calls", async () => {
    const { f, runCalls } = spyAdapter();
    const tool = createPlanChangeTool(f, fingerprint([]));
    const out = JSON.parse(
      await tool.execute({
        intent: "x",
        statements: ["SELECT 1"],
        targetTable: 'users"; DROP TABLE users; --',
      }),
    );
    expect(out.ok).toBe(false);
    expect(runCalls).toBe(0);
  });

  it("drift detected when claimed columns mismatch fingerprint", async () => {
    const { f } = spyAdapter();
    const tool = createPlanChangeTool(f, fingerprint(["a", "b"]));
    const out = JSON.parse(
      await tool.execute({
        intent: "touch columns a,c",
        statements: ["UPDATE users SET c = 1 WHERE a = 2"],
        targetTable: "users",
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.plan.drifted).toBe(true);
    expect(out.plan.drift).toContain("b");
    expect(out.plan.drift).toContain("c");
  });

  it("no target → no drift check", async () => {
    const { f } = spyAdapter();
    const tool = createPlanChangeTool(f, fingerprint(["a"]));
    const out = JSON.parse(
      await tool.execute({
        intent: "generic",
        statements: ["SELECT 1"],
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.plan.drifted).toBe(false);
    expect(out.plan.drift).toEqual([]);
  });
});
