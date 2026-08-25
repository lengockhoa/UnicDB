// src/ai/omp/__tests__/mcpBridge.test.ts — TASK-012 TDD
// Spec: docs/AI_HANDOFF/tasks/TASK-012.md §Test Cases (frozen) +
// docs/AI_HANDOFF/queue/ACP-TOOLS-research.md (probe-confirmed HTTP shape).
//
// `handleMcpRequest` is the PURE request handler — every case below drives it
// directly (no socket, no real omp). The lifecycle case is the sole exception:
// it exercises the real 127.0.0.1 listener via a raw `net.connect` probe to
// prove the port is actually released on dispose().

import { describe, it, expect, vi } from "vitest";
import net from "node:net";
import type { DbAdapter, BatchedQuery, RunResult } from "../../../adapters/types";
import type { AdapterFactory } from "../../tools/types";
import { createDbTools } from "../../tools/registry";
import { createSqlTool } from "../../tools/sqlTool";
import { createExportStructureTool } from "../../tools/schemaTools";
import type { ToolRegistry, AgentTool } from "../../agent";
import { createMcpBridge } from "../mcpBridge";

// ---- fake adapters (shared shape with hostTools.test.ts / sqlTool.test.ts) --

interface CursorFakes {
  adapter: DbAdapter;
  fetchBatch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  runQuery: ReturnType<typeof vi.fn>;
}

function makeCursorAdapter(
  opts: { columns?: string[]; rows?: unknown[][] } = {},
): CursorFakes {
  const cols = opts.columns ?? ["id", "name"];
  const allRows = opts.rows ?? [
    [1, "a"],
    [2, "b"],
  ];
  const fetchBatch = vi.fn(async (): Promise<unknown[][] | null> => allRows);
  const close = vi.fn(async () => undefined);
  const cursor: BatchedQuery = {
    columns: cols,
    fetchBatch: fetchBatch as BatchedQuery["fetchBatch"],
    cancel: vi.fn(async () => undefined),
    close: close as BatchedQuery["close"],
  };
  const runQuery = vi.fn(async (_sql: string): Promise<RunResult> => ({
    results: [],
    batched: cursor,
  }));
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

/** Pull the bearer token out of the descriptor's `headers` array — the only
 * public surface a caller (test or omp itself) has to learn it. */
function tokenFromDescriptor(bridge: { descriptor: Record<string, unknown> }): string {
  const headers = bridge.descriptor["headers"] as Array<{ name: string; value: string }>;
  const auth = headers.find((h) => h.name === "Authorization");
  return auth ? auth.value.replace(/^Bearer /, "") : "";
}

function fullRegistry(factory: AdapterFactory): ToolRegistry {
  const reg = createDbTools(factory);
  reg.register(createSqlTool(factory));
  reg.register(createExportStructureTool(factory));
  return reg;
}

// ---- test #1: tools/list — exactly the 4 registry tools, inputSchema passthrough

describe("createMcpBridge — tools/list (happy)", () => {
  it("returns exactly the 4 registry tools with names + inputSchema unchanged from parameters", async () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      { method: "tools/list", params: {}, id: 1 },
      tokenFromDescriptor(bridge),
    );

    expect(out.error).toBeUndefined();
    const result = out.result as { tools: Array<Record<string, unknown>> };
    expect(result.tools).toHaveLength(4);
    const byName = new Map(result.tools.map((t) => [t["name"] as string, t]));
    expect(byName.has("list_tables")).toBe(true);
    expect(byName.has("describe_table")).toBe(true);
    expect(byName.has("export_structure")).toBe(true);
    expect(byName.has("run_sql")).toBe(true);

    const runSqlDef = byName.get("run_sql")!;
    const originalRunSqlTool = reg.get("run_sql")!;
    expect(runSqlDef["inputSchema"]).toEqual(originalRunSqlTool.parameters);
    expect(runSqlDef["description"]).toBe(originalRunSqlTool.description);

    bridge.dispose();
  });
});

// ---- test #2: tools/call list_tables — success envelope ---------------------

describe("createMcpBridge — tools/call (happy)", () => {
  it("invokes list_tables through the registry and returns the string result inside content[0].text", async () => {
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
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      {
        method: "tools/call",
        params: { name: "list_tables", arguments: { schema: "public" } },
        id: 2,
      },
      tokenFromDescriptor(bridge),
    );

    expect(out.error).toBeUndefined();
    const result = out.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(tables);

    bridge.dispose();
  });
});

// ---- test #3: auth — wrong/absent bearer token -------------------------------

describe("createMcpBridge — auth", () => {
  it("rejects a request with a wrong or absent token (401-equivalent); the tool is never invoked", async () => {
    const executed: unknown[] = [];
    const tool: AgentTool = {
      name: "list_tables",
      description: "",
      parameters: { type: "object" },
      execute: async (args) => {
        executed.push(args);
        return "[]";
      },
    };
    const reg: ToolRegistry = {
      list: () => [tool],
      get: (n) => (n === "list_tables" ? tool : undefined),
    };
    const bridge = await createMcpBridge(reg);

    const wrongToken = await bridge.handleMcpRequest(
      { method: "tools/call", params: { name: "list_tables", arguments: {} }, id: 3 },
      "not-the-real-token",
    );
    expect(wrongToken.error).toBeDefined();
    expect(wrongToken.error?.code).toBe(401);

    const absentToken = await bridge.handleMcpRequest(
      { method: "tools/call", params: { name: "list_tables", arguments: {} }, id: 4 },
      "",
    );
    expect(absentToken.error).toBeDefined();
    expect(absentToken.error?.code).toBe(401);

    expect(executed).toHaveLength(0);

    bridge.dispose();
  });
});

// ---- test #4: guard — run_sql DELETE refused, no adapter call ---------------

describe("createMcpBridge — run_sql read-only guard", () => {
  it("refuses DELETE FROM t via isReadOnlySql; runQuery never called; refusal text returned (no crash)", async () => {
    const { adapter, runQuery } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      {
        method: "tools/call",
        params: { name: "run_sql", arguments: { sql: "DELETE FROM t" } },
        id: 5,
      },
      tokenFromDescriptor(bridge),
    );

    expect(runQuery).not.toHaveBeenCalled();
    expect(out.error).toBeUndefined();
    const result = out.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text).toBe(
      "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    );

    bridge.dispose();
  });
});

// ---- test #5: malformed args (non-object) -----------------------------------

describe("createMcpBridge — malformed args", () => {
  it('returns "Invalid tool arguments" when arguments is not an object', async () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);
    const bridge = await createMcpBridge(reg);

    for (const bad of ["not-an-object", 42, null, undefined]) {
      const out = await bridge.handleMcpRequest(
        { method: "tools/call", params: { name: "list_tables", arguments: bad }, id: 6 },
        tokenFromDescriptor(bridge),
      );
      expect(out.error).toBeUndefined();
      const result = out.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]!.text).toBe("Invalid tool arguments");
    }

    bridge.dispose();
  });
});

// ---- test #6: unknown tool ----------------------------------------------------

describe("createMcpBridge — unknown tool", () => {
  it('returns "Unknown tool: nope" without throwing', async () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      { method: "tools/call", params: { name: "nope", arguments: {} }, id: 7 },
      tokenFromDescriptor(bridge),
    );
    expect(out.error).toBeUndefined();
    const result = out.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text).toBe("Unknown tool: nope");

    bridge.dispose();
  });
});

// ---- test #7: lifecycle — dispose closes the listener + releases the port ----

describe("createMcpBridge — lifecycle", () => {
  it("dispose() closes the listener; a subsequent connection attempt fails (no orphan server)", async () => {
    const { adapter } = makeCursorAdapter();
    const factory = makeFactory(adapter);
    const reg = fullRegistry(factory);
    const bridge = await createMcpBridge(reg);

    const url = new URL(bridge.descriptor["url"] as string);
    const port = Number(url.port);

    // Sanity: the listener is actually up before dispose.
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.end();
        resolve();
      });
      sock.once("error", reject);
    });

    bridge.dispose();

    await expect(
      new Promise<void>((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1", () => {
          sock.end();
          resolve();
        });
        sock.once("error", (err) => reject(err));
      }),
    ).rejects.toThrow();
  });
});

// ---- test #8: no active connection — readable string, no unhandled rejection

describe("createMcpBridge — no active connection", () => {
  it("adapterFactory() returning null surfaces a readable 'no active connection' string; no throw", async () => {
    const factory = makeFactory(null);
    const reg = fullRegistry(factory);
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      {
        method: "tools/call",
        params: { name: "run_sql", arguments: { sql: "SELECT 1" } },
        id: 8,
      },
      tokenFromDescriptor(bridge),
    );
    expect(out.error).toBeUndefined();
    const result = out.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text.toLowerCase()).toContain("no active");

    bridge.dispose();
  });
});

// ---- bonus: descriptor + MCP handshake shape (regression against drift) ----

describe("createMcpBridge — descriptor + handshake shape", () => {
  it("descriptor is a loopback-only HTTP McpServer entry with a bearer-token header array", async () => {
    const { adapter } = makeCursorAdapter();
    const reg = fullRegistry(makeFactory(adapter));
    const bridge = await createMcpBridge(reg);

    expect(bridge.descriptor["type"]).toBe("http");
    expect(typeof bridge.descriptor["name"]).toBe("string");
    expect(bridge.descriptor["url"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    const headers = bridge.descriptor["headers"] as Array<{ name: string; value: string }>;
    expect(Array.isArray(headers)).toBe(true);
    const auth = headers.find((h) => h.name === "Authorization");
    expect(auth).toBeDefined();
    expect(auth?.value).toBe(`Bearer ${tokenFromDescriptor(bridge)}`);

    bridge.dispose();
  });

  it("initialize advertises capabilities.tools (truthy) so omp's client actually calls tools/list", async () => {
    const { adapter } = makeCursorAdapter();
    const reg = fullRegistry(makeFactory(adapter));
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      { method: "initialize", params: { protocolVersion: "2025-11-25" }, id: 1 },
      tokenFromDescriptor(bridge),
    );
    expect(out.error).toBeUndefined();
    const result = out.result as { capabilities: { tools?: unknown } };
    expect(result.capabilities.tools).toBeTruthy();

    bridge.dispose();
  });
});
