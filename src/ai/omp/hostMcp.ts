// src/ai/omp/hostMcp.ts — cycle AE TASK-001
// In-process MCP Streamable-HTTP server hosting the cycle-AD DB-aware tools
// (list_table_data_sample, count_rows, run_readonly_query, explain_query,
// get_table_relationships). Every call is routed through a host-side
// permission gate that mirrors `DbToolPermissionGate`'s wire shape
// (src/ui/aiChatPanel.ts:565-578) so the existing webview permission card
// answers the host MCP requests without any new code on the panel side.
//
// No credential, apiKey, secret, or DB connection-string ever reaches the
// wire — the descriptor is `127.0.0.1:<port>` only. Per
// docs/AI_HANDOFF/PLAN_AE.md §Acceptance criterion 8, a static
// byte-scan of every frame the server emits proves this invariant in the
// test file.
//
// NO vscode import.

import * as http from "node:http";
import { randomUUID } from "node:crypto";
import {
  DB_TOOL_DENIED_MESSAGE,
  type DbToolPermissionGate,
} from "../../ui/aiChatPanel";
// Type-only import: the curated registry is a pure host-side module. The
// dependency direction registry → hostMcp is forbidden; host → registry
// types is the declared TASK-AIX08-002 seam (PLAN_AIX08 §2/§3.4).
import type { CuratedMcpTool } from "./mcpExtensionRegistry";

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

export interface HostMcpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Pure-ish async execute. Returns the text payload the model sees. */
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface HostMcpPostPermission {
  (msg: {
    type: "permission_request";
    requestId: string;
    tool: { id: string; name: string; detail: string };
    options: Array<{ optionId: string; label: string }>;
  }): void;
}

export interface CreateHostMcpOptions {
  /** Caller-supplied permission card sink (typically a webview post). */
  gatePost: HostMcpPostPermission;
  /** Tool list, in registration order. The gate wraps each before listing. */
  tools: ReadonlyArray<HostMcpTool>;
  /** Policy-admitted curated registry output (TASK-AIX08-002). Listed and
   * invoked through the same MCP envelopes but NOT routed through the
   * permission gate — the registry already applied the AIX-07 policy +
   * DBX-08 capability admission before producing these tools. */
  extensions?: ReadonlyArray<CuratedMcpTool>;
  /** When true, `server.unref()` keeps the test/event-loop from hanging. */
  unref?: boolean;
}

export interface HostMcp {
  readonly port: number;
  readonly url: string;
  readonly sessionId: string;
  start(): Promise<void>;
  /** Idempotent. */
  stop(): Promise<void>;
  /** Tests reply to outstanding permission prompts through this shim. */
  respond(requestId: string, optionId: string | undefined): boolean;
  /** Underlying JSON-RPC handler — exposed for unit tests. */
  handle(
    req: { method: string; params?: unknown; id?: unknown },
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  /**
   * Chat-engine-friendly wrapper around `handle()` that wraps a
   * `tools/call` JSON-RPC request and normalises the wire response into
   * `{ result, isError }`. The engine (T2 ompChatEngine) threads this
   * shape into `events.onToolEnd(name, result, isError)` directly. No
   * double dispatch — this is the single boundary that funnels
   * `tools/call` through the JSON-RPC handler. PLAN_AE.md §Acceptance 4.
   */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError: boolean }>;
}

// ---------------------------------------------------------------------------
// Constants & utility helpers.
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-11-25";
const HOST_INFO = { name: "vsdb-host-mcp", version: "1.11.0" } as const;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Truncated, shape-only human detail for the permission card. Mirrors
 * `summarizeDbToolArgs` in src/ui/aiChatPanel.ts. */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${(raw ?? "").slice(0, 200)}`);
  }
  return parts.join(" ");
}

const PERMISSION_OPTIONS: ReadonlyArray<{
  optionId: string;
  label: string;
}> = [
  { optionId: "allow-once", label: "Allow once" },
  { optionId: "allow-session", label: "Allow for this session" },
  { optionId: "deny", label: "Deny" },
];

function optionIdGrants(optionId: string | undefined): boolean {
  return optionId === "allow-once" || optionId === "allow-session";
}

/** Typed extraction of `server.address()` — `null` (closed / no port yet)
 * or `AddressInfo`. Anything else is invalid in this codebase. */
function readPort(addr: string | { port: number } | null): number {
  if (addr === null) return 0;
  if (typeof addr === "object" && "port" in addr) {
    const v = addr.port;
    if (typeof v === "number") return v;
  }
  return 0;
}

interface PendingGrant {
  resolve(granted: boolean): void;
  settled: boolean;
  toolName: string;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createHostMcp(opts: CreateHostMcpOptions): HostMcp {
  const sessionId = randomUUID();
  const sessionAllowed = new Set<string>();
  const pending = new Map<string, PendingGrant>();

  function respond(requestId: string, optionId: string | undefined): boolean {
    const entry = pending.get(requestId);
    if (entry === undefined || entry.settled) return false;
    entry.settled = true;
    pending.delete(requestId);
    if (optionId === "allow-session") {
      sessionAllowed.add(entry.toolName);
    }
    entry.resolve(optionIdGrants(optionId));
    return true;
  }

  function wrappedExecute(
    tool: HostMcpTool,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (sessionAllowed.has(tool.name)) {
      return tool.execute(args);
    }
    const requestId = `hostmcp-${randomUUID()}`;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    pending.set(requestId, {
      resolve,
      settled: false,
      toolName: tool.name,
    });
    opts.gatePost({
      type: "permission_request",
      requestId,
      tool: { id: requestId, name: tool.name, detail: summarizeArgs(args) },
      options: PERMISSION_OPTIONS.map((o) => ({
        optionId: o.optionId,
        label: o.label,
      })),
    });
    return promise.then((granted) =>
      granted ? tool.execute(args) : DB_TOOL_DENIED_MESSAGE,
    );
  }

  /**
   * Curated extension containment (TASK-AIX08-002): race the registry-
   * produced handler against its own validated timeout bound and map the
   * explicit failure classification to MCP outcomes. The registry context
   * is structurally read-only, so a timed-out promise cannot gain new
   * privileged authority after the host has returned; a late settlement is
   * simply observed (never an unhandled rejection). The timer is always
   * cleared in a finally block so no timer can wedge the host or hang stop().
   */
  function containedExecute(
    tool: CuratedMcpTool,
    args: Record<string, unknown>,
  ): Promise<string> {
    const budget = typeof tool.timeoutMs === "number" ? tool.timeoutMs : 0;
    if (!(budget > 0)) {
      // Fail closed: a curated tool without a positive validated budget
      // must not run unbounded. Treat as an immediate timeout outcome.
      return Promise.resolve(tool.timeoutError(0));
    }
    const { promise, resolve } = Promise.withResolvers<string>();
    const timer = setTimeout(() => resolve(tool.timeoutError(budget)), budget);
    // An errored handler must never surface as an unhandled rejection —
    // the timeout branch may have settled the race promise already.
    tool
      .execute(args)
      .then(
        (text) => resolve(text),
        (error: unknown) => resolve(tool.formatError(error)),
      )
      .finally(() => clearTimeout(timer));
    return promise;
  }

  const wrappedTools: HostMcpTool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    execute: (args) => wrappedExecute(t, args),
  }));

  /** Registry-admitted curated tools (already policy/capability gated at
   * admission time in mcpExtensionRegistry.ts). Kept as a Map keyed by the
   * v1-validated unique name; a curated name colliding with a standard
   * tool loses — the standard tool wins and the curated entry is ignored
   * (fail closed, no silent override). */
  const curatedByName = new Map<string, CuratedMcpTool>();
  for (const ext of opts.extensions ?? []) {
    if (
      typeof ext?.name === "string" &&
      ext.name.length > 0 &&
      !wrappedTools.some((t) => t.name === ext.name) &&
      !curatedByName.has(ext.name)
    ) {
      curatedByName.set(ext.name, ext);
    }
  }

  async function handle(req: {
    method: string;
    params?: unknown;
    id?: unknown;
  }): Promise<JsonRpcResponse> {
    switch (req.method) {
      case "initialize":
        return {
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: HOST_INFO,
          },
        };
      case "notifications/initialized":
        return { result: {} };
      case "tools/list":
        return {
          result: {
            tools: [
              ...wrappedTools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.parameters,
              })),
              ...[...curatedByName.values()].map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.parameters,
              })),
            ],
          },
        };
      case "tools/call": {
        const params = req.params;
        if (!isRecordLike(params) || typeof params["name"] !== "string") {
          return {
            result: {
              content: [{ type: "text", text: "Invalid tool arguments" }],
              isError: true,
            },
          };
        }
        const name = params["name"];
        const args = params["arguments"];
        const tool = wrappedTools.find((t) => t.name === name);
        const curated = curatedByName.get(name);
        if (!tool && !curated) {
          return {
            result: {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            },
          };
        }
        if (!isRecordLike(args)) {
          return {
            result: {
              content: [{ type: "text", text: "Invalid tool arguments" }],
              isError: true,
            },
          };
        }
        if (curated !== undefined) {
          // Curated containment lane: timeout + crash are classified via
          // the registry's explicit metadata (never string-prefix guesses
          // for ordinary results), and curated error text is marked with
          // isError via the registry's own classification predicate.
          const text = await containedExecute(curated, args);
          return {
            result: {
              content: [{ type: "text", text }],
              ...(curated.isErrorResult(text) ? { isError: true } : {}),
            },
          };
        }
        // `curated` is undefined here, so `tool` must be defined (the
        // unknown-tool early return above excluded the both-undefined case).
        const standard = tool as HostMcpTool;
        try {
          const text = await standard.execute(args);
          // A deny path in the gate returns DB_TOOL_DENIED_MESSAGE (a plain
          // string) instead of running the tool. Surface it as an MCP
          // `isError: true` result so the model and the user both see the
          // rejection boundary.
          if (text === DB_TOOL_DENIED_MESSAGE) {
            return {
              result: {
                content: [{ type: "text", text }],
                isError: true,
              },
            };
          }
          return { result: { content: [{ type: "text", text }] } };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            result: {
              content: [{ type: "text", text: `Tool failed: ${msg}` }],
              isError: true,
            },
          };
        }
      }
      default:
        return {
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  }

  // -----------------------------------------------------------------
  // HTTP transport layer.
  // -----------------------------------------------------------------

  let server: http.Server | undefined;
  let port = 0;
  let stopped = false;

  async function start(): Promise<void> {
    if (stopped) {
      // Lifecycle reset: stop() flips `stopped` to true. A subsequent
      // start() must clear the flag (and defensively reset `port` to 0)
      // before binding a fresh listener — otherwise the early-return at
      // `if (server !== undefined) return` would skip the rebind and the
      // caller would be left with a stale closed URL / 0 port.
      stopped = false;
      port = 0;
    }

    if (server !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (req.method === "GET") {
          // MCP Streamable-HTTP keepalive probe (omp's client sends GET /
          // before/after the prompt to confirm the session). Reply 200 with
          // the session id header so any subsequent client also receives it.
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": sessionId,
          });
          res.end();
          return;
        }
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
            const raw = Buffer.concat(chunks).toString("utf8");
            let body: unknown;
            try {
              body = raw.length === 0 ? undefined : JSON.parse(raw);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32700, message: "Parse error" },
                }),
              );
              return;
            }
            if (!isRecordLike(body) || typeof body["method"] !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32600, message: "Invalid Request" },
                }),
              );
              return;
            }
            const id = body["id"];
            const isNotification = id === undefined;
            const outcome = await handle({
              method: body["method"],
              params: body["params"],
              id,
            });
            res.setHeader("mcp-session-id", sessionId);
            if (isNotification) {
              res.writeHead(202, { "Content-Type": "application/json" });
              res.end();
              return;
            }
            if (outcome.error !== undefined) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: id ?? null,
                  error: outcome.error,
                }),
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: id ?? null,
                result: outcome.result,
              }),
            );
          })();
        });
      });
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        port = readPort(srv.address());
        if (opts.unref === true && typeof srv.unref === "function") {
          srv.unref();
        }
        resolve();
      });
      server = srv;
    });
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    // Reject any in-flight pending permission prompts as a deny — the host
    // is gone, no answer will arrive.
    for (const [, entry] of pending) {
      if (!entry.settled) {
        entry.resolve(false);
      }
    }
    pending.clear();
    if (server !== undefined) {
      const s = server;
      // Mirror mcpBridge.ts: tear every in-flight socket down immediately so
      // a hung tool call doesn't keep the event loop alive.
      if (typeof s.closeAllConnections === "function") {
        s.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
    server = undefined;
    port = 0;
  }

  return {
    get port() {
      return port;
    },
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    sessionId,
    async start() {
      await start();
    },
    async stop() {
      await stop();
    },
    respond,
    handle,
    async call(name, args) {
      const out = await handle({
        method: "tools/call",
        params: { name, arguments: args },
        id: Math.floor(Math.random() * 1e9),
      });
      if (out.error) {
        return { result: out.error.message, isError: true };
      }
      const r = out.result as
        | { content?: Array<{ text?: string }>; isError?: boolean }
        | undefined;
      if (!r || !Array.isArray(r.content)) {
        return { result: "", isError: true };
      }
      const text = r.content.map((c) => c?.text ?? "").join("");
      return { result: text, isError: r.isError === true };
    },
  };
}

// Re-export the gate type purely for downstream typing. The host and the
// panel are decoupled — the panel instantiates its own gate, the host
// consumes a simpler `gatePost` callback. This re-export documents the
// bridge boundary for consumers (T2 ompChatEngine and future callers).
export type { DbToolPermissionGate };