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
import http from "node:http";
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

// ---- MINOR review finding 5: dispose() must close lingering connections ----
//
// Plain `server.close()` stops accepting NEW connections but lets any
// connection with an ACTIVE in-flight request (handler hasn't responded yet)
// linger open indefinitely — it only tears down once that request completes.
// A slow/hung tool call (e.g. a stuck `run_sql` against a wedged DB) would
// leave the socket (and the process's event loop) alive well past
// `dispose()`. `closeAllConnections()` forces it closed immediately.

describe("createMcpBridge — dispose closes lingering connections", () => {
  it("R(Finding5) regression: dispose() forcibly closes a socket with an in-flight (hung) request instead of waiting for it to finish", async () => {
    // A tool whose execute() never resolves — simulates a hung/slow call
    // still in flight when dispose() happens.
    const hungTool: AgentTool = {
      name: "hang",
      description: "",
      parameters: { type: "object" },
      execute: () => new Promise<string>(() => {}),
    };
    const reg: ToolRegistry = {
      list: () => [hungTool],
      get: (n) => (n === "hang" ? hungTool : undefined),
    };
    const bridge = await createMcpBridge(reg);
    const token = tokenFromDescriptor(bridge);
    const url = new URL(bridge.descriptor["url"] as string);
    const port = Number(url.port);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hang", arguments: {} },
    });

    const closed = await new Promise<boolean>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
        },
        () => {
          // Response never actually arrives (handler is hung) — nothing to
          // do here; the socket-level events below drive the assertion.
        },
      );
      req.on("error", () => {
        // A reset from dispose() surfaces here — treat it the same as the
        // socket's own "close" (both mean the connection was torn down).
      });
      req.on("socket", (sock) => {
        // Give the request time to actually reach the (hung) handler before
        // disposing, so this really is an in-flight request, not a queued
        // one the server never started.
        setTimeout(() => {
          bridge.dispose();
          sock.once("close", () => resolve(true));
          setTimeout(() => resolve(false), 500);
        }, 50);
      });
      req.write(body);
      req.end();
      setTimeout(() => reject(new Error("test setup timed out")), 3000);
    });

    expect(closed).toBe(true);
  });
});

// ---- TASK-AIX05-102: terminal disposal — dispose() is idempotent and the
// ---- pure handler fails closed (-32000 "MCP bridge is disposed") before any
// ---- registry/tool access once the bridge is retired.

describe("createMcpBridge — terminal disposal (TASK-AIX05-102)", () => {
  // TC1 (happy): live bridge lists the supplied registry exactly once.
  it("live bridge: authorized tools/list returns the exact registered names once each and calls registry.list() once", async () => {
    const tool: AgentTool = {
      name: "only_tool",
      description: "sole tool",
      parameters: { type: "object" },
      execute: async () => "ok",
    };
    const listSpy = vi.fn(() => [tool]);
    const reg: ToolRegistry = { list: listSpy, get: (n) => (n === "only_tool" ? tool : undefined) };
    const bridge = await createMcpBridge(reg);

    const out = await bridge.handleMcpRequest(
      { method: "tools/list", params: {}, id: 101 },
      tokenFromDescriptor(bridge),
    );

    expect(out.error).toBeUndefined();
    const result = out.result as { tools: Array<Record<string, unknown>> };
    expect(result.tools.map((t) => t["name"])).toEqual(["only_tool"]);
    expect(listSpy).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  // TC2 (edge): after dispose, tools/list fails closed; registry never reached.
  it("after dispose, authorized tools/list returns { error: { code: -32000, message: 'MCP bridge is disposed' } }; registry.list() is not called", async () => {
    const listSpy = vi.fn(() => [] as AgentTool[]);
    const reg: ToolRegistry = { list: listSpy, get: () => undefined };
    const bridge = await createMcpBridge(reg);
    const token = tokenFromDescriptor(bridge);

    bridge.dispose();

    const out = await bridge.handleMcpRequest({ method: "tools/list", params: {}, id: 102 }, token);
    expect(out).toEqual({ error: { code: -32000, message: "MCP bridge is disposed" } });
    expect(listSpy).not.toHaveBeenCalled();
  });

  // TC3 (edge): after dispose, tools/call cannot execute — zero side effects.
  it("after dispose, authorized tools/call returns -32000 'MCP bridge is disposed'; tool.execute is called zero times", async () => {
    const executeSpy = vi.fn(async () => "should never run");
    const tool: AgentTool = {
      name: "boom",
      description: "",
      parameters: { type: "object" },
      execute: executeSpy,
    };
    const reg: ToolRegistry = { list: () => [tool], get: (n) => (n === "boom" ? tool : undefined) };
    const bridge = await createMcpBridge(reg);
    const token = tokenFromDescriptor(bridge);

    bridge.dispose();

    const out = await bridge.handleMcpRequest(
      { method: "tools/call", params: { name: "boom", arguments: {} }, id: 103 },
      token,
    );
    expect(out).toEqual({ error: { code: -32000, message: "MCP bridge is disposed" } });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // TC4 (regression): duplicate dispose must not throw/reopen; the hanging
  // in-flight socket still closes and new connections stay refused.
  it("dispose() twice does not throw; the hanging in-flight socket closes and new connection attempts are refused", async () => {
    const hungTool: AgentTool = {
      name: "hang",
      description: "",
      parameters: { type: "object" },
      execute: () => new Promise<string>(() => {}),
    };
    const reg: ToolRegistry = {
      list: () => [hungTool],
      get: (n) => (n === "hang" ? hungTool : undefined),
    };
    const bridge = await createMcpBridge(reg);
    const token = tokenFromDescriptor(bridge);
    const url = new URL(bridge.descriptor["url"] as string);
    const port = Number(url.port);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hang", arguments: {} },
    });

    let resolveInFlight: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    });
    const socketClosed = new Promise<boolean>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
        },
        () => {},
      );
      req.on("error", () => resolve(true));
      req.on("socket", (sock) => {
        sock.once("close", () => resolve(true));
        // Let the request actually reach the hung handler first.
        setTimeout(resolveInFlight, 50);
        setTimeout(() => resolve(false), 500);
      });
      req.write(body);
      req.end();
      setTimeout(() => resolve(false), 3000);
    });

    await inFlight;
    expect(() => bridge.dispose()).not.toThrow();
    expect(() => bridge.dispose()).not.toThrow();

    expect(await socketClosed).toBe(true);

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

// ---- TASK-AIX05-103: createMcpBridge(hostMcp) composition overload --------
// The production OMP runtime composes the bridge with the authoritative
// HostMcp registry. The authenticated bridge handler must delegate
// `tools/list` AND `tools/call` to `hostMcp.handle(req)` (the member at
// hostMcp.ts that owns the standard-plus-curated registry and the
// standard-wins collision filter) — `call(name, args)` alone cannot
// implement `tools/list` and MUST NOT be used for delegation.

import type { HostMcp } from "../hostMcp";

describe("createMcpBridge — HostMcp composition overload (TASK-AIX05-103)", () => {
  /** Minimal HostMcp double that records which member the bridge used. */
  function makeFakeHostMcp(overrides: Partial<HostMcp> = {}): HostMcp & {
    handleCalls: Array<{ method: string; params?: unknown; id?: unknown }>;
    callCalls: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const handleCalls: Array<{ method: string; params?: unknown; id?: unknown }> = [];
    const callCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const base = {
      port: 0,
      url: "http://127.0.0.1:0",
      sessionId: "hostmcp-test-session",
      start: async () => undefined,
      stop: async () => undefined,
      respond: () => false,
      handle: async (req: { method: string; params?: unknown; id?: unknown }) => {
        handleCalls.push(req);
        if (req.method === "tools/list") {
          return {
            result: {
              tools: [
                { name: "std_tool", description: "d", inputSchema: { type: "object" } },
              ],
            },
          };
        }
        if (req.method === "tools/call") {
          return {
            result: { content: [{ type: "text", text: "hostmcp-exec" }] },
          };
        }
        return { result: {} };
      },
      call: async (name: string, args: Record<string, unknown>) => {
        callCalls.push({ name, args });
        return { result: "should-not-be-used", isError: false };
      },
    };
    return { ...base, ...overrides, handleCalls, callCalls } as HostMcp & {
      handleCalls: Array<{ method: string; params?: unknown; id?: unknown }>;
      callCalls: Array<{ name: string; args: Record<string, unknown> }>;
    };
  }

  it("overload exists: createMcpBridge(hostMcp) returns a bridge with a bearer descriptor", async () => {
    const hostMcp = makeFakeHostMcp();
    const bridge = await createMcpBridge(hostMcp as unknown as HostMcp);
    expect(typeof bridge.descriptor["url"]).toBe("string");
    expect(bridge.descriptor["type"]).toBe("http");
    const headers = bridge.descriptor["headers"] as Array<{ name: string; value: string }>;
    expect(headers.find((h) => h.name === "Authorization")?.value).toMatch(/^Bearer /);
    bridge.dispose();
  });

  it("handleMcpRequest delegates tools/list to hostMcp.handle (NOT call)", async () => {
    const hostMcp = makeFakeHostMcp();
    const bridge = await createMcpBridge(hostMcp as unknown as HostMcp);
    const token = tokenFromDescriptor(bridge);

    const out = await bridge.handleMcpRequest(
      { method: "tools/list", params: {}, id: 1 },
      token,
    );

    expect(out.error).toBeUndefined();
    expect(hostMcp.handleCalls).toHaveLength(1);
    expect(hostMcp.handleCalls[0]?.method).toBe("tools/list");
    expect(hostMcp.callCalls).toHaveLength(0); // call() MUST NOT be used
    const tools = (out.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["std_tool"]);

    bridge.dispose();
  });

  it("handleMcpRequest delegates tools/call to hostMcp.handle (NOT call)", async () => {
    const hostMcp = makeFakeHostMcp();
    const bridge = await createMcpBridge(hostMcp as unknown as HostMcp);
    const token = tokenFromDescriptor(bridge);

    const out = await bridge.handleMcpRequest(
      { method: "tools/call", params: { name: "std_tool", arguments: { a: 1 } }, id: 2 },
      token,
    );

    expect(out.error).toBeUndefined();
    expect(hostMcp.handleCalls).toHaveLength(1);
    expect(hostMcp.handleCalls[0]?.method).toBe("tools/call");
    expect(hostMcp.callCalls).toHaveLength(0); // call() MUST NOT be used
    const content = (out.result as { content: Array<{ text: string }> }).content;
    expect(content[0]?.text).toBe("hostmcp-exec");

    bridge.dispose();
  });

  it("wrong bearer token still returns 401-equivalent before any HostMcp delegation", async () => {
    const hostMcp = makeFakeHostMcp();
    const bridge = await createMcpBridge(hostMcp as unknown as HostMcp);

    const out = await bridge.handleMcpRequest(
      { method: "tools/list", params: {}, id: 3 },
      "wrong-token",
    );

    expect(out).toEqual({ error: { code: 401, message: "Unauthorized" } });
    expect(hostMcp.handleCalls).toHaveLength(0);
    bridge.dispose();
  });

  it("TASK-AIX05-102 terminal disposal carries over: post-dispose delegation returns -32000 without reaching HostMcp", async () => {
    const hostMcp = makeFakeHostMcp();
    const bridge = await createMcpBridge(hostMcp as unknown as HostMcp);
    const token = tokenFromDescriptor(bridge);
    bridge.dispose();

    const out = await bridge.handleMcpRequest(
      { method: "tools/list", params: {}, id: 4 },
      token,
    );
    expect(out).toEqual({ error: { code: -32000, message: "MCP bridge is disposed" } });
    expect(hostMcp.handleCalls).toHaveLength(0);
  });
});
