// src/ai/omp/__tests__/hostMcp.test.ts — cycle AE TASK-001 (TDD)
// hostMcp is an in-process MCP Streamable-HTTP server that hosts the 5
// cycle-AD DB-aware tools and routes them through DbToolPermissionGate
// before execution. Wire shape: JSON-RPC 2.0 over HTTP POST on a
// 127.0.0.1 random port. SPEC: docs/AI_HANDOFF/PLAN_AE.md §Approach
// (Bridge architecture) + §Acceptance criteria 2, 3, 8.
//
// Pulls `DB_TOOL_DENIED_MESSAGE` from `src/ui/aiChatPanel` because the
// host delegates the permission prompt through the same wire shape the
// panel already understands. The panel transitively imports `vscode`, so
// we `vi.mock("vscode", …)` here.

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: (...parts: unknown[]) => ({
      toString: () => parts.map((p) => String(p)).join("/"),
    }),
  },
  window: { createWebviewPanel: vi.fn() },
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: undefined },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";

import { createHostMcp, type HostMcp } from "../hostMcp";
import { DB_TOOL_DENIED_MESSAGE } from "../../ui/aiChatPanel";
import { createMcpExtensionRegistry } from "../mcpExtensionRegistry";
import type {
  CuratedMcpTool,
  McpExtensionContribution,
} from "../mcpExtensionRegistry";
import type { EffectivePolicy } from "../../policy";
import type { DbAdapter } from "../../../adapters/types";

// ---------------------------------------------------------------------------
// Test doubles — minimal tool shape the gate exercises.
import { DB_TOOL_DENIED_MESSAGE } from "../../../ui/aiChatPanel";

interface FakeTool {
  name: string;
  description: string;
  parameters: object;
  execute(args: Record<string, unknown>): Promise<string>;
  calls: Array<Record<string, unknown>>;
}

function fakeTool(args: {
  name: string;
  description: string;
  parameters: object;
  returns: string;
}): FakeTool {
  const calls: Array<Record<string, unknown>> = [];
  return {
    name: args.name,
    description: args.description,
    parameters: args.parameters,
    calls,
    execute: async (input: Record<string, unknown>) => {
      calls.push(input);
      return args.returns;
    },
  };
}

const FIVE_DB_TOOL_NAMES = [
  "list_table_data_sample",
  "count_rows",
  "run_readonly_query",
  "explain_query",
  "get_table_relationships",
] as const;

const HOST_INFO = { name: "UnicDB-host-mcp", version: "1.11.0" };

// ---------------------------------------------------------------------------
// HTTP probe helper — plain Node http client to mirror omp's wire path.
// ---------------------------------------------------------------------------

interface ProbeResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawText: string;
}

interface ProbeOptions {
  method: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
}

async function probeJson(url: string, opts: ProbeOptions): Promise<ProbeResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProbeResult>();
  const payload =
    opts.body === undefined ? "" : Buffer.from(JSON.stringify(opts.body), "utf8");
  const req = http.request(
    url,
    {
      method: opts.method,
      host: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        accept: "application/json, text/event-stream",
        ...(opts.headers ?? {}),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = text.length === 0 ? undefined : JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: parsed,
          rawText: text,
        });
      });
      res.on("error", reject);
    },
  );
  req.on("error", reject);
  if (payload.length > 0) req.write(payload);
  req.end();
  return promise;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

type PermissionPost = (m: {
  type: string;
  requestId: string;
  [k: string]: unknown;
}) => void;

interface Fixture {
  host: HostMcp;
}

interface BuildOptions {
  tools?: FakeTool[];
  postPermission?: PermissionPost;
  extensions?: CuratedMcpTool[];
}

async function buildFixture(opts: BuildOptions = {}): Promise<Fixture> {
  const tools =
    opts.tools ??
    FIVE_DB_TOOL_NAMES.map((name) =>
      fakeTool({
        name,
        description: `desc ${name}`,
        parameters: {
          type: "object",
          properties: { schema: { type: "string" } },
        },
        returns: `result ${name}`,
      }),
    );

  const host = createHostMcp({
    gatePost: opts.postPermission ?? (() => undefined),
    tools,
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  });
  await host.start();
  return { host };
}

function fiveDbTools(): FakeTool[] {
  return FIVE_DB_TOOL_NAMES.map((n) =>
    fakeTool({
      name: n,
      description: `desc ${n}`,
      parameters: { type: "object", properties: {} },
      returns: `OUT-${n}`,
    }),
  );
}

let fixture: Fixture | undefined;

afterEach(async () => {
  if (fixture) {
    await fixture.host.stop();
    fixture = undefined;
  }
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("createHostMcp — MCP HTTP server (T1)", () => {
  it("binds 127.0.0.1 only and exposes a loopback URL", async () => {
    fixture = await buildFixture();
    const { url, port } = fixture.host;
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  it("initialize → protocolVersion 2025-11-25 + capabilities.tools + mcp-session-id header", async () => {
    fixture = await buildFixture();
    const res = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
    });
    expect(res.status).toBe(200);
    const sessionIdHeader = res.headers["mcp-session-id"];
    const sessionIdStr =
      typeof sessionIdHeader === "string"
        ? sessionIdHeader
        : Array.isArray(sessionIdHeader)
          ? sessionIdHeader[0]
          : undefined;
    expect(sessionIdStr).toBeDefined();
    expect(sessionIdStr).toBe(fixture.host.sessionId);

    const body = res.body as {
      result?: {
        protocolVersion?: string;
        capabilities?: { tools?: unknown };
        serverInfo?: { name?: string; version?: string };
      };
    };
    expect(body.result?.protocolVersion).toBe("2025-11-25");
    expect(body.result?.capabilities?.tools).toBeDefined();
    expect(body.result?.serverInfo?.name).toBe(HOST_INFO.name);
    expect(body.result?.serverInfo?.version).toBe(HOST_INFO.version);
  });

  it("notifications/initialized → 202 with no JSON-RPC body", async () => {
    fixture = await buildFixture();
    const res = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
    });
    expect(res.status).toBe(202);
    expect(res.rawText.length).toBe(0);
  });

  it("tools/list returns exactly the 5 DB tool names with description + parameters", async () => {
    fixture = await buildFixture();
    const res = await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      result?: {
        tools?: Array<{
          name: string;
          description: string;
          inputSchema?: object;
          parameters?: object;
        }>;
      };
    };
    const tools = body.result?.tools ?? [];
    const names = [...tools.map((t) => t.name)].sort();
    expect(names).toEqual([...FIVE_DB_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      const schema = t.inputSchema ?? t.parameters;
      expect(schema).toBeDefined();
    }
  });

  it("tools/call on allow-once runs the tool and returns text content", async () => {
    fixture = await buildFixture({
      tools: fiveDbTools(),
      postPermission: (m) => {
        queueMicrotask(() =>
          fixture!.host.respond(m.requestId, "allow-once"),
        );
      },
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    const callRes = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "run_readonly_query",
          arguments: { sql: "SELECT 1" },
        },
      },
    });

    const body = callRes.body as {
      result?: {
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
    };
    expect(callRes.status).toBe(200);
    expect(body.result?.content?.[0]?.type).toBe("text");
    expect(body.result?.content?.[0]?.text).toBe("OUT-run_readonly_query");
  });

  it("tools/call on deny returns DB_TOOL_DENIED_MESSAGE with isError:true", async () => {
    fixture = await buildFixture({
      tools: fiveDbTools(),
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "deny"));
      },
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    const res = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "list_table_data_sample",
          arguments: { schema: "public", table: "users" },
        },
      },
    });
    const body = res.body as {
      result?: {
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
    };
    expect(res.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe(DB_TOOL_DENIED_MESSAGE);
  });

  it("GET / returns 200 + headers (MCP Streamable-HTTP keepalive)", async () => {
    fixture = await buildFixture();
    const res = await probeJson(fixture.host.url, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBeDefined();
  });

  it("never carries an apiKey/secret/password substring on any wire output (byte-scan)", async () => {
    fixture = await buildFixture();

    const wireChunks: string[] = [];

    const a = await probeJson(fixture.host.url, { method: "GET" });
    wireChunks.push(a.rawText, JSON.stringify(a.headers));

    const b = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
    });
    wireChunks.push(b.rawText, JSON.stringify(b.headers));

    const c = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
    });
    wireChunks.push(c.rawText);

    const d = await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    wireChunks.push(d.rawText);

    // stop & rebuild with allow-once so we capture a tools/call response
    await fixture.host.stop();
    fixture = undefined;
    fixture = await buildFixture({
      tools: fiveDbTools(),
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    const callRes = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "run_readonly_query",
          arguments: { sql: "SELECT 1" },
        },
      },
    });
    wireChunks.push(callRes.rawText, JSON.stringify(callRes.headers));

    const blob = wireChunks.join("\n--\n").toLowerCase();
    expect(blob).not.toMatch(/apikey/);
    expect(blob).not.toMatch(/api[_-]?key/);
    expect(blob).not.toMatch(/secret/);
    expect(blob).not.toMatch(/password/);
  });

  it("start/stop are idempotent and stop() actually closes the listener", async () => {
    fixture = await buildFixture();
    await fixture.host.stop();
    await fixture.host.stop();
    fixture = undefined;

    fixture = await buildFixture();
    const { url } = fixture.host;
    await fixture.host.stop();
    fixture = undefined;

    // After stop, a fresh HTTP probe must surface a connection error
    // (ECONNREFUSED) — not a 200, not a hang.
    const probed = await probeJson(url, { method: "GET" }).catch(
      (err: unknown) => err,
    );
    expect(probed instanceof Error).toBe(true);
  });

  it("stop then start again works on the same instance", async () => {
    fixture = await buildFixture();
    const originalUrl = fixture.host.url;
    const originalPort = fixture.host.port;
    expect(originalPort).toBeGreaterThan(0);

    // First stop — must release the listener and reset port.
    await fixture.host.stop();
    expect(fixture.host.port).toBe(0);

    // Probe must fail now that the original listener is closed.
    const probedAfterStop = await probeJson(originalUrl, { method: "GET" }).catch(
      (err: unknown) => err,
    );
    expect(probedAfterStop instanceof Error).toBe(true);

    // Restart on the SAME instance — start() must clear the `stopped` flag
    // and reset port=0 before binding a new server, otherwise the second
    // start() early-returns and we never get a usable URL back.
    await fixture.host.start();
    const restartedUrl = fixture.host.url;
    const restartedPort = fixture.host.port;
    expect(restartedPort).toBeGreaterThan(0);
    expect(restartedUrl).not.toBe(originalUrl);
    expect(restartedUrl.startsWith("http://127.0.0.1:")).toBe(true);

    // The new listener must answer initialize on the wire.
    const res = await probeJson(restartedUrl, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
    });
    expect(res.status).toBe(200);

    // Second stop — must close the new listener without throwing.
    await fixture.host.stop();
    await fixture.host.stop(); // second call is idempotent and a no-op
    expect(fixture.host.port).toBe(0);

    // Probe must fail after the second stop too.
    const probedAfterSecondStop = await probeJson(restartedUrl, {
      method: "GET",
    }).catch((err: unknown) => err);
    expect(probedAfterSecondStop instanceof Error).toBe(true);
  });
});

describe("createHostMcp — call() wrapper (T2 contract bridge)", () => {
  it("call(name, args) delegates to handle() and returns { result, isError } for a successful tool result", async () => {
    fixture = await buildFixture({
      tools: fiveDbTools(),
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    const out = await fixture.host.call("run_readonly_query", { sql: "SELECT 1" });
    expect(out).toEqual({ result: "OUT-run_readonly_query", isError: false });
  });

  it("call(name, args) returns { result, isError: true } when the gate denies the tool", async () => {
    fixture = await buildFixture({
      tools: fiveDbTools(),
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "deny"));
      },
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    const out = await fixture.host.call("list_table_data_sample", {
      schema: "public",
      table: "users",
    });
    expect(out.isError).toBe(true);
    expect(out.result).toBe(DB_TOOL_DENIED_MESSAGE);
  });

  it("call(name, args) returns { result, isError: true } when handle() emits a JSON-RPC error envelope", async () => {
    fixture = await buildFixture();
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    // Unknown tool name → handle() emits a JSON-RPC error envelope.
    const out = await fixture.host.call("does_not_exist", {});
    expect(out.isError).toBe(true);
    expect(typeof out.result).toBe("string");
    expect(out.result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TASK-AIX08-002 — curated extension containment in the host MCP path.
// ---------------------------------------------------------------------------

/** Policy fixture matching src/ai/policy.ts EffectivePolicy (db + workspace
 * allowed) so the registry admits db-read contributions. */
function allowedPolicy(): EffectivePolicy {
  return {
    provider: "omp",
    context: { schema: true, workspace: true, rows: true },
    tools: { database: true, workspace: true },
    auditExportAllowed: true,
    notice: "",
  };
}

/** Registry-produced curated tool via the real TASK-AIX08-001 registry —
 * the host must consume `registry.list()` output exactly as declared. */
function curatedTool(opts: {
  name?: string;
  schema?: McpExtensionContribution["inputSchema"];
  timeoutMs?: number;
  handler: McpExtensionContribution["handler"];
}): CuratedMcpTool {
  const registry = createMcpExtensionRegistry({
    policy: allowedPolicy(),
    adapterFactory: async () => {
      const adapter = {
        capabilities: {
          catalog: true,
          objectDdl: true,
          tableDdl: true,
          admin: true,
        },
        runQuery: async () => ({
          results: [
            { columns: ["?column?"], rows: [[1]], rowCount: 1, durationMs: 1 },
          ],
        }),
      } as unknown as DbAdapter;
      return adapter;
    },
  });
  const declaration: McpExtensionContribution = {
    name: opts.name ?? "catalog-probe",
    description: "Curated catalog probe",
    contractVersion: 1,
    inputSchema:
      opts.schema ??
      ({
        type: "object",
        properties: {
          schema: { type: "string" },
          limit: { type: "number" },
          verbose: { type: "boolean" },
        },
        required: ["schema"],
        additionalProperties: false,
      } satisfies McpExtensionContribution["inputSchema"]),
    capabilities: [{ kind: "db-read", requiredCapabilities: ["catalog"] }],
    timeoutMs: opts.timeoutMs ?? 1000,
    handler: opts.handler,
  };
  const outcome = registry.register(declaration);
  if (!outcome.ok) throw new Error(outcome.error);
  const tool = registry.list().find((t) => t.name === declaration.name);
  if (!tool) throw new Error("fixture tool not admitted");
  return tool;
}

describe("createHostMcp — curated extension containment (TASK-AIX08-002)", () => {
  it("admitted curated tool appears in tools/list and returns MCP text content", async () => {
    fixture = await buildFixture({
      tools: [],
      extensions: [
        curatedTool({
          handler: async () => "catalog ok",
        }),
      ],
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    const listRes = await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    const listBody = listRes.body as {
      result?: {
        tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
      };
    };
    const listed = listBody.result?.tools ?? [];
    const curated = listed.find((t) => t.name === "catalog-probe");
    expect(curated).toBeDefined();
    expect(curated!.inputSchema).toEqual({
      type: "object",
      properties: {
        schema: { type: "string" },
        limit: { type: "number" },
        verbose: { type: "boolean" },
      },
      required: ["schema"],
      additionalProperties: false,
    });

    const callRes = await probeJson(fixture.host.url, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "catalog-probe", arguments: { schema: "public" } },
      },
    });
    const callBody = callRes.body as {
      result?: {
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
    };
    expect(callRes.status).toBe(200);
    expect(callBody.result?.content?.[0]?.text).toBe("catalog ok");
    expect(callBody.result?.isError).toBeUndefined();
  });

  it("curated exact invalid-argument literals return isError before handler", async () => {
    const handlerCalls: number[] = [];
    fixture = await buildFixture({
      tools: [],
      extensions: [
        curatedTool({
          handler: async () => {
            handlerCalls.push(1);
            return "handler-ok";
          },
        }),
      ],
    });

    const callCurated = async (args: Record<string, unknown>) => {
      const res = await fixture!.host.handle({
        method: "tools/call",
        params: { name: "catalog-probe", arguments: args },
        id: 7,
      });
      const result = res.result as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      return { text: result.content?.[0]?.text ?? "", isError: result.isError };
    };

    expect(await callCurated({})).toEqual({
      text: 'MCP extension invalid arguments: missing required property "schema"',
      isError: true,
    });
    expect(await callCurated({ schema: "public", extra: true })).toEqual({
      text: 'MCP extension invalid arguments: unexpected property "extra"',
      isError: true,
    });
    expect(await callCurated({ schema: 1 })).toEqual({
      text: 'MCP extension invalid arguments: property "schema" must be string',
      isError: true,
    });
    expect(await callCurated({ schema: "public", limit: "1" })).toEqual({
      text: 'MCP extension invalid arguments: property "limit" must be number',
      isError: true,
    });
    expect(await callCurated({ schema: "public", verbose: "true" })).toEqual({
      text: 'MCP extension invalid arguments: property "verbose" must be boolean',
      isError: true,
    });
    expect(handlerCalls).toHaveLength(0);
  });

  it("never-settling curated handler times out and host remains usable", async () => {
    fixture = await buildFixture({
      tools: fiveDbTools(),
      extensions: [
        curatedTool({
          timeoutMs: 100,
          handler: () =>
            new Promise<string>(() => {
              /* never settles */
            }),
        }),
      ],
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });
    await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    const out = await fixture.host.call("catalog-probe", { schema: "public" });
    expect(out).toEqual({
      result: "MCP extension tool timed out after 100ms",
      isError: true,
    });

    // The host must remain usable for standard tools after the timeout.
    const after = await fixture.host.call("run_readonly_query", { sql: "SELECT 1" });
    expect(after).toEqual({ result: "OUT-run_readonly_query", isError: false });

    // stop() must complete (no leaked timer / wedge).
    await fixture.host.stop();
    fixture = undefined;
  });

  it("curated crash is contained while standard host failure wording is unchanged", async () => {
    fixture = await buildFixture({
      tools: [
        {
          name: "standard_boom",
          description: "standard tool that throws",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            throw new Error("standard boom");
          },
        } as unknown as FakeTool,
      ],
      extensions: [
        curatedTool({
          handler: async () => {
            throw new Error("extension boom");
          },
        }),
      ],
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });

    const curatedOut = await fixture.host.call("catalog-probe", { schema: "public" });
    expect(curatedOut).toEqual({
      result: "MCP extension tool failed: extension boom",
      isError: true,
    });

    const standardOut = await fixture.host.call("standard_boom", {});
    expect(standardOut).toEqual({
      result: "Tool failed: standard boom",
      isError: true,
    });
  });

  it("curated name colliding with a standard tool loses to the standard tool (review round 1)", async () => {
    const curatedCalls: number[] = [];
    const standardCalls: Array<Record<string, unknown>> = [];
    fixture = await buildFixture({
      tools: [
        {
          name: "catalog-probe",
          description: "standard tool that wins the name collision",
          parameters: { type: "object", properties: {} },
          execute: async (input: Record<string, unknown>) => {
            standardCalls.push(input);
            return "standard-wins";
          },
        } as unknown as FakeTool,
      ],
      extensions: [
        curatedTool({
          name: "catalog-probe",
          handler: async () => {
            curatedCalls.push(1);
            return "curated-loses";
          },
        }),
      ],
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });

    // tools/list: exactly ONE descriptor, and it is the standard tool's.
    const listRes = await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const listed = (listRes.body as {
      result?: { tools?: Array<{ name: string; description?: string }> };
    }).result?.tools ?? [];
    expect(listed.filter((t) => t.name === "catalog-probe")).toHaveLength(1);
    expect(
      listed.find((t) => t.name === "catalog-probe")?.description,
    ).toBe("standard tool that wins the name collision");

    // tools/call: routed to the standard tool (its gate path), curated handler never runs.
    const out = await fixture.host.call("catalog-probe", {});
    expect(standardCalls).toHaveLength(1);
    expect(curatedCalls).toHaveLength(0);
    expect(out).toEqual({ result: "standard-wins", isError: false });

    await fixture.host.stop();
    fixture = undefined;
  });

  it("late-settling curated handler after timeout is observed, never unhandled, result applied once (review round 1)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let settleHandler!: (value: string) => void;
    const handlerPromise = new Promise<string>((resolve) => {
      settleHandler = resolve;
    });
    let handlerSettled = false;
    void handlerPromise.then(
      () => {
        handlerSettled = true;
      },
      () => {
        handlerSettled = true;
      },
    );

    try {
      fixture = await buildFixture({
        tools: fiveDbTools(),
        extensions: [
          curatedTool({
            timeoutMs: 100,
            handler: () => handlerPromise,
          }),
        ],
        postPermission: (m) => {
          queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
        },
      });
      await probeJson(fixture.host.url, {
        method: "POST",
        body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      });

      const out = await fixture.host.call("catalog-probe", { schema: "public" });
      expect(out).toEqual({
        result: "MCP extension tool timed out after 100ms",
        isError: true,
      });
      // Handler has NOT settled yet — the timeout won the race.
      expect(handlerSettled).toBe(false);

      // Late settlement AFTER the response: first a rejection, then a
      // resolution. Both must be observed (no unhandledRejection) and must
      // NOT mutate the already-returned MCP result.
      settleHandler!("LATE-RESULT-MUST-NOT-APPLY");
      await new Promise((r) => setTimeout(r, 20));
      expect(handlerSettled).toBe(true);
      expect(unhandled).toHaveLength(0);

      // The second call reflects the host is still healthy; the late
      // settlement never leaked into it.
      const after = await fixture.host.call("run_readonly_query", { sql: "SELECT 1" });
      expect(after).toEqual({ result: "OUT-run_readonly_query", isError: false });

      await fixture.host.stop();
      fixture = undefined;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // ---- TASK-AIX05-103 case 9: regression pin — the standard-wins
  // ---- collision stays authoritative across OMP runtime lifetime.
  it("R(AIX05-103) collision regression: standard tool remains authoritative across OMP lifetime (before AND after host stop)", async () => {
    const curatedCalls: number[] = [];
    const standardCalls: Array<Record<string, unknown>> = [];
    fixture = await buildFixture({
      tools: [
        {
          name: "catalog-probe",
          description: "standard tool that wins the name collision",
          parameters: { type: "object", properties: {} },
          execute: async (input: Record<string, unknown>) => {
            standardCalls.push(input);
            return "standard-wins";
          },
        } as unknown as FakeTool,
      ],
      extensions: [
        curatedTool({
          name: "catalog-probe",
          handler: async () => {
            curatedCalls.push(1);
            return "curated-loses";
          },
        }),
      ],
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });

    // tools/list while live: exactly ONE descriptor, the standard one.
    const listRes = await probeJson(fixture.host.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const listed = (listRes.body as {
      result?: { tools?: Array<{ name: string; description?: string }> };
    }).result?.tools ?? [];
    expect(listed.filter((t) => t.name === "catalog-probe")).toHaveLength(1);
    expect(
      listed.find((t) => t.name === "catalog-probe")?.description,
    ).toBe("standard tool that wins the name collision");

    // tools/call while live: standard wins, curated handler never runs.
    const liveOut = await fixture.host.call("catalog-probe", {});
    expect(standardCalls).toHaveLength(1);
    expect(curatedCalls).toHaveLength(0);
    expect(liveOut).toEqual({ result: "standard-wins", isError: false });

    // Simulate OMP bridge/runtime teardown by stopping the host.
    await fixture.host.stop();

    // After teardown: the pure handle()/call() surface still routes the
    // colliding name to the STANDARD tool — the standard-wins filter is
    // structural and must survive runtime exit (no curated resurrection).
    const outAfterStop = await fixture.host.call("catalog-probe", {});
    expect(curatedCalls).toHaveLength(0);
    expect(outAfterStop).toEqual({ result: "standard-wins", isError: false });

    // Build a fresh fixture with the SAME collision fixture: the curated
    // entry must lose again — proving the filter is structural, not
    // session-state-bound.
    await fixture.host.stop();
    fixture = undefined;
    fixture = await buildFixture({
      tools: [
        {
          name: "catalog-probe",
          description: "standard tool that wins the name collision",
          parameters: { type: "object", properties: {} },
          execute: async () => "standard-wins-again",
        } as unknown as FakeTool,
      ],
      extensions: [
        curatedTool({
          name: "catalog-probe",
          handler: async () => {
            throw new Error("curated must never run on a re-built host");
          },
        }),
      ],
      postPermission: (m) => {
        queueMicrotask(() => fixture!.host.respond(m.requestId, "allow-once"));
      },
    });
    const out2 = await fixture.host.call("catalog-probe", {});
    expect(out2).toEqual({ result: "standard-wins-again", isError: false });

    await fixture.host.stop();
    fixture = undefined;
  });
});