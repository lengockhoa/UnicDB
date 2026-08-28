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

const HOST_INFO = { name: "vsdb-host-mcp", version: "1.11.0" };

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