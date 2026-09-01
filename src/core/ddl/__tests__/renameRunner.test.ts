// src/core/ddl/__tests__/renameRunner.test.ts — TASK-DBX06-003 (host logic)
// Sequential statement execution with progress, mid-run failure reporting,
// and cancel-before-next semantics. Pure orchestration — the caller passes
// an execute callback, so this stays vscode-free and trivially testable.
//
// DBX06-006 — covers ordered multi-step execution, named applied/failed
// step outcomes, and stop-at-first-failure semantics on the typed step
// surface (runRenameSteps).
import { describe, it, expect } from "vitest";
import {
  runRenameStatements,
  runRenameSteps,
} from "../renameRunner";
import type { RenamePlanStep } from "../renameCatalog";

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

describe("runRenameSteps (DBX06-006 — typed plan step runner)", () => {
  function step(
    kind: RenamePlanStep["kind"],
    statement: string,
    executable: boolean,
    operation?: RenamePlanStep["operation"],
  ): RenamePlanStep {
    return { kind, statement, executable, operation };
  }

  it("executes only executable steps in declared order with typed progress", async () => {
    const steps: RenamePlanStep[] = [
      step(
        "rename",
        'ALTER TABLE "public"."users" RENAME TO "customers";',
        true,
        { kind: "table", schema: "public", table: "users", oldName: "users", newName: "customers" },
      ),
      step("views", "", false),
      step("fks", "", false),
      step("triggers", "", false),
      step("indexes", "", false),
    ];
    const executed: string[] = [];
    const progress: Array<{ i: number; total: number; sql: string; label: string }> = [];
    const r = await runRenameSteps(
      steps,
      async (sql) => {
        executed.push(sql);
      },
      (p, total) => progress.push({ i: p.index, total, sql: p.sql, label: p.label }),
      () => false,
    );
    expect(executed).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    expect(progress).toEqual([
      {
        i: 0,
        total: 1,
        sql: 'ALTER TABLE "public"."users" RENAME TO "customers";',
        label: "Rename table",
      },
    ]);
    expect(r).toEqual({
      applied: [{ index: 0, label: "Rename table", sql: 'ALTER TABLE "public"."users" RENAME TO "customers";' }],
    });
  });

  it("multi-step failure names every applied step and the failed step, no later run", async () => {
    // Task case #5 fixture: table rename → column rename (fails) → third
    // executable step that must never be issued.
    const steps: RenamePlanStep[] = [
      step(
        "rename",
        'ALTER TABLE "public"."users" RENAME TO "customers";',
        true,
        { kind: "table", schema: "public", table: "users", oldName: "users", newName: "customers" },
      ),
      step(
        "rename",
        'ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";',
        true,
        { kind: "column", schema: "public", table: "customers", oldName: "name", newName: "full_name" },
      ),
      step(
        "rename",
        'ALTER TABLE "public"."customers" RENAME COLUMN "email" TO "mail";',
        true,
        { kind: "column", schema: "public", table: "customers", oldName: "email", newName: "mail" },
      ),
    ];
    const executed: string[] = [];
    const r = await runRenameSteps(
      steps,
      async (sql) => {
        if (sql.includes("RENAME COLUMN")) {
          throw new Error("relation locked");
        }
        executed.push(sql);
      },
      () => {},
      () => false,
    );
    expect(executed).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    expect(r).toEqual({
      applied: [
        {
          index: 0,
          label: "Rename table",
          sql: 'ALTER TABLE "public"."users" RENAME TO "customers";',
        },
      ],
      failed: {
        index: 1,
        label: "Rename column",
        sql: 'ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";',
        error: "relation locked",
      },
    });
  });

  it("cancel between steps reports applied + cancelledAfter + remaining", async () => {
    const steps: RenamePlanStep[] = [
      step("rename", "A;", true, { kind: "table", schema: "s", table: "t", oldName: "a", newName: "b" }),
      step("rename", "B;", true, { kind: "table", schema: "s", table: "t", oldName: "b", newName: "c" }),
      step("rename", "C;", true, { kind: "table", schema: "s", table: "t", oldName: "c", newName: "d" }),
    ];
    const executed: string[] = [];
    let cancelled = false;
    const r = await runRenameSteps(
      steps,
      async (sql) => {
        executed.push(sql);
        if (sql === "A;") cancelled = true;
      },
      () => {},
      () => cancelled,
    );
    expect(executed).toEqual(["A;"]);
    expect(r).toEqual({
      applied: [{ index: 0, label: "Rename table", sql: "A;" }],
      cancelledAfter: 1,
      remaining: 2,
    });
  });
});
