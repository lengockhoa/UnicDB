// src/ai/omp/__tests__/hostTools.test.ts — TASK-002 TDD
// Spec: docs/AI_HANDOFF/tasks/TASK-002.md §Test Cases (frozen). NO vscode import.

import { describe, it, expect, vi, type Mock } from "vitest";
import type { DbAdapter, BatchedQuery, RunResult } from "../../../adapters/types";
import type { AdapterFactory } from "../../tools/types";
import { createDbTools } from "../../tools/registry";
import { createSqlTool } from "../../tools/sqlTool";
import { hostToolDefsFromRegistry, createHostToolExecutor } from "../hostTools";

// ---- fake adapters (shared shape with sqlTool.test.ts) --------------------

interface CursorFakes {
  adapter: DbAdapter;
  fetchBatch: Mock<[], Promise<unknown[][] | null>>;
  close: Mock<[], Promise<void>>;
  runQuery: Mock<[string], Promise<RunResult>>;
}

function makeCursorAdapter(opts: {
  columns?: string[];
  rows?: unknown[][];
  emptyResults?: boolean;
} = {}): CursorFakes {
  const cols = opts.columns ?? ["id", "name"];
  const allRows = opts.rows ?? [
    [1, "a"],
    [2, "b"],
  ];
  const emptyResults = opts.emptyResults ?? true;

  const fetchBatch = vi.fn(async (): Promise<unknown[][] | null> => allRows);
  const close = vi.fn(async () => undefined);
  const cursor: BatchedQuery = {
    columns: cols,
    fetchBatch: fetchBatch as BatchedQuery["fetchBatch"],
    cancel: vi.fn(async () => undefined),
    close: close as BatchedQuery["close"],
  };
  const runQuery = vi.fn(async (_sql: string): Promise<RunResult> => {
    if (emptyResults) {
      return { results: [], batched: cursor };
    }
    return {
      results: [
        { columns: cols, rows: allRows, rowCount: allRows.length, durationMs: 1 },
      ],
    };
  });

  const adapter: DbAdapter = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    runQuery: runQuery as DbAdapter["runQuery"],
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    estimateTableRows: vi.fn(async () => null),
    listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
    testConnection: vi.fn(async () => undefined),
  };
  return { adapter, fetchBatch, close, runQuery };
}

function makeFactory(adapter: DbAdapter | null): AdapterFactory {
  return vi.fn(async () => adapter);
}

// ---- helper: full bridge registry with run_sql registered ------------------

function fullRegistry(factory: AdapterFactory) {
  const reg = createDbTools(factory);
  reg.register(createSqlTool(factory));
  return reg;
}

// ---- test #1: defs passthrough from real registry --------------------------

describe("hostToolDefsFromRegistry — frozen contract", () => {
  it("emits {name, description, parameters} for every tool in the registry", () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);

    const defs = hostToolDefsFromRegistry(reg);

    expect(defs).toHaveLength(3);
    const byName = new Map(defs.map((d) => [d["name"] as string, d]));
    expect(byName.get("list_tables")).toBeDefined();
    expect(byName.get("describe_table")).toBeDefined();
    expect(byName.get("run_sql")).toBeDefined();

    for (const def of defs) {
      expect(def).toEqual({
        name: expect.any(String),
        description: expect.any(String),
        parameters: expect.any(Object),
      });
      // Only the three frozen keys — no leakage of execute function.
      expect(Object.keys(def).sort()).toEqual(
        ["description", "name", "parameters"],
      );
    }

    // Spot-check run_sql's passthrough parameters shape.
    const runSql = byName.get("run_sql")!;
    expect(runSql["parameters"]).toEqual({
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    });
  });
});

// ---- test #2: executor success path through list_tables --------------------

describe("createHostToolExecutor — frozen contract", () => {
  it("runs list_tables through the registry and returns the adapter's JSON string", async () => {
    const tables = [
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
    ];
    const adapter: DbAdapter = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      runQuery: vi.fn(async () => ({ results: [] })),
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => tables),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      estimateTableRows: vi.fn(async () => null),
      listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
      testConnection: vi.fn(async () => undefined),
    };
    const factory = makeFactory(adapter);
    const reg = createDbTools(factory);

    const exec = createHostToolExecutor(reg);
    const out = await exec("list_tables", { schema: "public" });

    expect(JSON.parse(out)).toEqual([
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
    ]);
  });

  // ---- test #3: unknown tool ---------------------------------------------

  it("returns 'Unknown tool: <name>' for an unknown tool name", async () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);

    const exec = createHostToolExecutor(reg);
    const out = await exec("does_not_exist", {});
    expect(out).toBe("Unknown tool: does_not_exist");
  });

  // ---- test #4: invalid args (non-object) --------------------------------

  it("returns 'Invalid tool arguments' when args is not an object", async () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);

    const exec = createHostToolExecutor(reg);
    expect(await exec("list_tables", "not-an-object")).toBe(
      "Invalid tool arguments",
    );
    expect(await exec("list_tables", 42)).toBe("Invalid tool arguments");
    expect(await exec("list_tables", null)).toBe("Invalid tool arguments");
  });

  // ---- test #5: tool throws → wrapped message ----------------------------

  it("returns 'Tool failed: <msg>' when tool.execute throws", async () => {
    // Use a hand-rolled registry with a throwing tool — independent of cycle-K tools.
    const reg = {
      list: () => [
        {
          name: "boom_tool",
          description: "always throws",
          parameters: { type: "object" },
          execute: async () => {
            throw new Error("boom");
          },
        },
      ],
      get: (n: string) =>
        n === "boom_tool"
          ? ({
              name: "boom_tool",
              description: "always throws",
              parameters: { type: "object" },
              execute: async () => {
                throw new Error("boom");
              },
            })
          : undefined,
    };

    const exec = createHostToolExecutor(reg);
    const out = await exec("boom_tool", {});
    expect(out).toBe("Tool failed: boom");
  });

  // ---- test #6: regression — DROP TABLE never reaches the adapter --------

  it("blocks DROP TABLE at the tool's read-only guard; runQuery is never called", async () => {
    const { adapter, runQuery } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);

    const exec = createHostToolExecutor(reg);
    const out = await exec("run_sql", { sql: "DROP TABLE t" });

    expect(runQuery).not.toHaveBeenCalled();
    // The exact reason string from isReadOnlySql guard.
    expect(out).toBe(
      "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    );
  });

  // ---- test #7: regression — SELECT 1 hits cursor path through bridge -----

  it("runs SELECT through run_sql using the cursor batched path; returns JSON rows", async () => {
    const { adapter, fetchBatch, close, runQuery } = makeCursorAdapter({
      columns: ["n"],
      rows: [[1]],
      emptyResults: true,
    });
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);

    const exec = createHostToolExecutor(reg);
    const out = await exec("run_sql", { sql: "SELECT 1 AS n" });

    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith("SELECT 1 AS n");
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out)).toEqual({
      columns: ["n"],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
    });
  });
});