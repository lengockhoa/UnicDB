// src/core/ddl/__tests__/renameRunner.test.ts — TASK-DBX06-003 (host logic)
// Sequential statement execution with progress, mid-run failure reporting,
// and cancel-before-next semantics. Pure orchestration — the caller passes
// an execute callback, so this stays vscode-free and trivially testable.
import { describe, it, expect } from "vitest";
import { runRenameStatements } from "../renameRunner";

describe("runRenameStatements", () => {
  it("executes in order with progress callbacks", async () => {
    const executed: string[] = [];
    const progress: Array<{ i: number; total: number; s: string }> = [];
    const r = await runRenameStatements(
      ["A;", "B;", "C;"],
      async (sql) => {
        executed.push(sql);
      },
      (i, total, s) => progress.push({ i, total, s }),
      () => false,
    );
    expect(executed).toEqual(["A;", "B;", "C;"]);
    expect(r).toEqual({ applied: 3 });
    expect(progress).toEqual([
      { i: 0, total: 3, s: "A;" },
      { i: 1, total: 3, s: "B;" },
      { i: 2, total: 3, s: "C;" },
    ]);
  });

  it("mid-run failure reports applied/failedAt/error", async () => {
    const executed: string[] = [];
    const r = await runRenameStatements(
      ["A;", "B;", "C;"],
      async (sql) => {
        if (sql === "B;") throw new Error("relation locked");
        executed.push(sql);
      },
      () => {},
      () => false,
    );
    expect(executed).toEqual(["A;"]);
    expect(r).toEqual({
      applied: 1,
      failedAt: 1,
      error: "relation locked",
      failedStatement: "B;",
    });
  });

  it("cancel stops BEFORE the next statement and reports state", async () => {
    const executed: string[] = [];
    let cancelled = false;
    const r = await runRenameStatements(
      ["A;", "B;", "C;"],
      async (sql) => {
        executed.push(sql);
        if (sql === "A;") cancelled = true; // user hits cancel after A
      },
      () => {},
      () => cancelled,
    );
    expect(executed).toEqual(["A;"]);
    expect(r).toEqual({ applied: 1, cancelledAfter: 1, remaining: 2 });
  });
});
