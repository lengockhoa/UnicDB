// src/ai/omp/mcpBridge.ts — TASK-012 (B11)
// In-process MCP Streamable-HTTP bridge exposing the EXISTING ToolRegistry
// (DbToolRegistry + run_sql + export_structure) to omp's ACP agent via the
// `mcpServers` extension point in `session/new`/`session/load`.
//
// Probe evidence (docs/AI_HANDOFF/queue/ACP-TOOLS-research.md): omp 18.0.1
// connects to an HTTP-shaped `mcpServers` entry SYNCHRONOUSLY as part of
// handling `session/new` (MCPManager.connectServers → listTools), performing
// `initialize` → `notifications/initialized` → `tools/list` before the
// `session/new` response even returns. `mcpCapabilities` has no `stdio` key
// at the ACP-session level, so HTTP is the only viable transport here.
//
// Security (§7):
//   - Listener binds 127.0.0.1 ONLY — never reachable off-box.
//   - A per-bridge random bearer token (crypto.randomBytes) is required on
//     every JSON-RPC call; wrong/absent token → 401-equivalent, the
//     registry tool is never invoked (checked before method dispatch).
//   - Tool execution routes through the SAME ToolRegistry/AgentTool objects
//     the builtin loop uses (src/ai/agent.ts) — `run_sql`'s isReadOnlySql
//     guard (sqlTool.ts) is the only chokepoint; this bridge adds no second
//     execution path to the database, and no credential/connection-string
//     ever appears in the descriptor, a header, or a log line.
//   - `handleMcpRequest` is a PURE function — unit-tested without a socket.
//     The real `node:http` listener is a thin adapter around it.
//
// Error wording mirrors the builtin agent loop exactly (src/ai/agent.ts /
// the now-deleted src/ai/omp/hostTools.ts) so both engines behave
// identically: "Unknown tool: <name>", "Invalid tool arguments",
// "Tool failed: <msg>".
//
// NO vscode import.

import http from "node:http";
import crypto from "node:crypto";
import type { ToolRegistry } from "../agent";

const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpBridge {
  /** Descriptor for session/new|session/load's `mcpServers` array — the ACP
   * `McpServer` HTTP variant. Shape fixed by the probe; do not guess. */
  descriptor: Record<string, unknown>;
  /** Pure request handler — unit-tested without omp and without a socket. */
  handleMcpRequest(
    req: { method: string; params?: unknown; id?: unknown },
    token: string,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  dispose(): void;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Constant-time-ish token compare — mismatched lengths short-circuit false
 * (safe: both operands are always short random/attacker strings, not secret
 * material whose length itself is sensitive here). */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function textResult(text: string, isError = false): { result: unknown } {
  return {
    result: {
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    },
  };
}

/** Build the pure JSON-RPC handler bound to `registry` + `expectedToken`. */
function makeHandler(
  registry: ToolRegistry,
  expectedToken: string,
): McpBridge["handleMcpRequest"] {
  return async (req, token) => {
    // Auth gate FIRST — wrong/absent token never reaches tool dispatch.
    if (!tokensMatch(token, expectedToken)) {
      return { error: { code: 401, message: "Unauthorized" } };
    }

    switch (req.method) {
      case "initialize":
        return {
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "vsdb", version: "1.0.0" },
          },
        };

      case "notifications/initialized":
        // Best-effort notification — no meaningful reply body.
        return { result: {} };

      case "tools/list":
        return {
          result: {
            tools: registry.list().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          },
        };

      case "tools/call": {
        const params = req.params;
        if (!isRecordLike(params) || typeof params["name"] !== "string") {
          return textResult("Invalid tool arguments", true);
        }
        const name = params["name"];
        const args = params["arguments"];

        const tool = registry.get(name);
        if (!tool) {
          return textResult(`Unknown tool: ${name}`, true);
        }
        if (!isRecordLike(args)) {
          return textResult("Invalid tool arguments", true);
        }
        try {
          const out = await tool.execute(args);
          return textResult(out);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return textResult(`Tool failed: ${msg}`, true);
        }
      }

      default:
        return { error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  };
}

function extractBearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] ?? "" : "";
}

/**
 * Build a bridge exposing `registry` over an in-process MCP Streamable-HTTP
 * server bound to `127.0.0.1` on an OS-assigned port. Async because the
 * listener must actually be bound (and its port known) before the caller
 * can build a `session/new`-ready `descriptor`.
 */
export async function createMcpBridge(registry: ToolRegistry): Promise<McpBridge> {
  const token = crypto.randomBytes(24).toString("hex");
  const handleMcpRequest = makeHandler(registry, token);

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not allowed" },
        }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
          return;
        }
        if (!isRecordLike(body) || typeof body["method"] !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }));
          return;
        }

        const presented = extractBearerToken(req.headers["authorization"]);
        const id = body["id"];
        const isNotification = id === undefined;

        const outcome = await handleMcpRequest(
          { method: body["method"], params: body["params"], id },
          presented,
        );

        if (outcome.error?.code === 401) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: outcome.error }));
          return;
        }

        if (isNotification) {
          // Best-effort — no JSON-RPC response body expected by the caller.
          res.writeHead(202);
          res.end();
          return;
        }

        if (outcome.error) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: outcome.error }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: outcome.result }));
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    descriptor: {
      type: "http",
      name: "vsdb",
      url: `http://127.0.0.1:${port}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    handleMcpRequest,
    dispose(): void {
      server.close();
    },
  };
}
