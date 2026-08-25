// src/ui/__tests__/aiChatE2e.test.ts — TASK-004 E2E.
//
// 3 cases against the REAL `runAgent` + REAL `createProviderClient` with an
// injected `fetch`. The AiChatPanel drives the host; we only mock `vscode`
// (panel + onDidReceiveMessage capture) and supply:
//   - a fake adapter (AdapterFactory) recording every runQuery() call
//   - a fake fetch that answers 2-step chat/completions requests
//   - an AiConfig (flat shape) so `loadConfig()` resolves to a real object
//
// Cases:
//   1. happy 2-step loop → finalText contains rows from adapter; runQuery never
//      receives DML (regression guard wiring is intact through the panel).
//   2. regression: model tries DROP TABLE → tool returns reject reason;
//      adapter.runQuery never sees DML.
//   4. offline (fetch returns 500) → ProviderError bubble (scrubbed) posted
//      to webview; panel still alive afterwards.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps } from "../../ai/agent";
import type { ProviderRequest, ProviderResult } from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import type { DbAdapter } from "../../adapters/types";
import { AcpClient, type AcpTransport } from "../../ai/omp/acp";
import type { AcpProcessHandle } from "../../ai/omp/acpProcess";

// Mock vscode BEFORE importing the panel.
type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const l of this.listeners.slice()) l(data);
  }
}

interface MockPanel {
  webview: {
    html: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: (u: unknown) => unknown;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const panelState = vi.hoisted(() => ({
  panels: [] as MockPanel[],
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel: MockPanel = {
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => u),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(() => {
          panel.disposed = true;
          const listeners = (panel.onDidDispose as unknown as {
            mock: { calls: Array<[() => void]> };
          }).mock.calls;
          for (const [cb] of listeners) cb();
        }),
        visible: true,
        disposed: false,
      };
      panelState.panels.push(panel);
      return panel;
    }),
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: undefined },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

import { AiChatPanel } from "../aiChatPanel";
import { createProviderClient } from "../../ai/provider";
import { defaultAiSettings, type AiConfig } from "../../ai/settings";

// ---- helpers ---------------------------------------------------------------

// TASK-012 (B11): ensureAcpSession() now binds a real `node:http` listener
// (McpBridge) before calling `acp.start()`. `server.listen()`'s callback
// fires on I/O-completion, a macrotask — draining only the microtask queue
// (plain `await Promise.resolve()`) never observes it, so `until` yields via
// `setImmediate` instead. setImmediate always drains any pending microtasks
// first, so every assertion that previously relied on pure microtask-tick
// counts still holds — this is a strict superset wait.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
}

function panelHarness(): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
  const panel = panelState.panels[panelState.panels.length - 1] as MockPanel;
  return {
    panel,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (
      msg: unknown,
    ) => void,
  };
}

function postedMessages(panel: MockPanel): unknown[] {
  return panel.webview.postMessage.mock.calls.map((c) => c[0]);
}

interface AssistantMsg {
  type: "assistant";
  text: string;
  markdown: boolean;
}
interface ErrorMsg {
  type: "error";
  message: string;
}
interface DoneMsg {
  type: "done";
}
function isAssistant(m: unknown): m is AssistantMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "assistant";
}
function isError(m: unknown): m is ErrorMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
function isDone(m: unknown): m is DoneMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}

// ---- fake adapter ----------------------------------------------------------

interface RunQueryCall {
  sql: string;
}

function createFakeAdapter(opts: {
  tables?: Array<{ schema: string; name: string }>;
  selectResult?: { columns: string[]; rows: unknown[][] };
  runQuery?: Mock;
} = {}): DbAdapter & { calls: RunQueryCall[] } {
  const calls: RunQueryCall[] = [];
  const runQuery =
    opts.runQuery ??
    vi.fn(async (sql: string) => {
      calls.push({ sql });
      if (opts.selectResult) {
        return {
          results: [
            {
              columns: opts.selectResult.columns,
              rows: opts.selectResult.rows,
            },
          ],
        };
      }
      return { results: [{ columns: [], rows: [] }] };
    });
  return {
    calls,
    runQuery: runQuery as unknown as DbAdapter["runQuery"],
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => opts.tables ?? []),
    listViews: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    estimateTableRows: vi.fn(async () => null),
    listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
    testConnection: vi.fn(async () => {}),
  } as unknown as DbAdapter & { calls: RunQueryCall[] };
}

// ---- fake fetch helpers ----------------------------------------------------

/** Build a chat/completions response JSON object. */
function chatResp(args: {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  finishReason: "stop" | "tool_calls";
}): unknown {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "fake-model",
    choices: [
      {
        index: 0,
        finish_reason: args.finishReason,
        message: {
          role: "assistant",
          content: args.content ?? null,
          tool_calls: args.toolCalls
            ? args.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.args },
              }))
            : undefined,
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

/** Build a 200 OK Response wrapping the given JSON object. */
function jsonOk(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a 500 Response with the given snippet body. */
function json500(snippet: string): Response {
  return new Response(snippet, {
    status: 500,
    statusText: "Internal Server Error",
    headers: { "Content-Type": "text/plain" },
  });
}

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  const base = { ...defaultAiSettings(), apiKey: "sk-fake-key" } as AiConfig;
  return { ...base, ...overrides };
}

/** Build AgentDeps using a fresh createProviderClient({fetch}). */
function makeDepsWithFetch(fetchImpl: typeof fetch, cfg: AiConfig): AgentDeps {
  return {
    loadConfig: vi.fn(async () => cfg),
    complete: vi.fn(async (_c: AiConfig, _r: string, req: ProviderRequest) =>
      createProviderClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        method: cfg.method,
        timeoutMs: cfg.timeoutMs,
        fetch: fetchImpl as unknown as (
          url: string,
          init: { method?: string; headers?: Record<string, string>; body?: string },
        ) => Promise<Response>,
      }).complete(req),
    ),
  };
}

beforeEach(() => {
  panelState.panels.length = 0;
});

// ============================================================================
// #1 — happy 2-step tool loop. list_tables call → rows → final answer.
// Regression: adapter.runQuery is never called with DML.
// ============================================================================
describe("AiChatPanel — E2E happy 2-step", () => {
  it("2-step: list_tables → tool result → final answer; runQuery never sees DML", async () => {
    const cfg = makeConfig({
      models: {
        work: { modelId: "fake-work", vision: true },
        smart: { modelId: "fake-smart", vision: false },
      },
    });

    // The fake fetch answers the first provider call with a tool_call to
    // list_tables and the second call with a plain text answer.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const callCount = fetchMock.mock.calls.length;
      if (callCount === 1) {
        return jsonOk(
          chatResp({
            finishReason: "tool_calls",
            toolCalls: [
              { id: "call_1", name: "list_tables", args: "{}" },
            ],
          }),
        );
      }
      return jsonOk(
        chatResp({ finishReason: "stop", content: "Here is your table list." }),
      );
    });

    const adapter = createFakeAdapter({
      tables: [
        { schema: "public", name: "users" },
        { schema: "public", name: "orders" },
      ],
    });
    const adapterFactory: AdapterFactory = async () => adapter;

    const deps = makeDepsWithFetch(fetchMock as unknown as typeof fetch, cfg);
    const panel = new AiChatPanel({ extensionUri: vscode.Uri.file("/ext"), deps, adapterFactory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    handler({ type: "send", text: "list tables" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    // Provider was hit twice (tool_call + final).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // TASK-002 #6: tools array sent to the provider includes
    // `export_structure` (registered alongside run_sql in runBuiltinTurn).
    const firstCallInit = fetchMock.mock.calls[0]?.[1];
    const firstBodyText = typeof firstCallInit === "object" && firstCallInit !== null && "body" in firstCallInit
      ? String((firstCallInit as { body: unknown }).body)
      : "";
    const firstBody = JSON.parse(firstBodyText) as unknown;
    const tools = (typeof firstBody === "object" && firstBody !== null && "tools" in firstBody)
      ? (firstBody as { tools: unknown }).tools
      : undefined;
    expect(Array.isArray(tools)).toBe(true);
    const exportTool = (Array.isArray(tools) ? tools : []).find(
      (t) => typeof t === "object" && t !== null && "function" in t &&
        typeof (t as { function: unknown }).function === "object" &&
        (t as { function: { name?: unknown } }).function?.name === "export_structure",
    );
    expect(exportTool).toBeDefined();
    const posted = postedMessages(p);
    const assistant = posted.find(isAssistant);
    expect(assistant).toBeDefined();
    expect(assistant!.text).toBe("Here is your table list.");

    // Regression: runQuery was never invoked with DML — the read-only guard
    // is in the tool, not the adapter. Adapter's runQuery is never even
    // called here (list_tables uses adapter.listTables directly).
    for (const call of adapter.calls) {
      const sql = call.sql.toLowerCase();
      expect(sql).not.toMatch(/\b(drop|delete|update|insert|truncate|alter)\b/);
    }
    // And listTables was called at least once.
    expect((adapter.listTables as Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// #2 — regression: model tries run_sql DROP TABLE → tool rejects; runQuery
// NEVER receives DML.
// ============================================================================
describe("AiChatPanel — E2E DML regression", () => {
  it("model calls run_sql with DROP TABLE → tool returns reject; runQuery never sees DML", async () => {
    const cfg = makeConfig({
      models: {
        work: { modelId: "fake-work", vision: true },
        smart: { modelId: "fake-smart", vision: false },
      },
    });

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const callCount = fetchMock.mock.calls.length;
      if (callCount === 1) {
        // Model (mistakenly) tries to DROP via run_sql — tool MUST reject.
        return jsonOk(
          chatResp({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_bad",
                name: "run_sql",
                args: JSON.stringify({ sql: "DROP TABLE users" }),
              },
            ],
          }),
        );
      }
      // Second turn: model gives up after the rejection reason.
      return jsonOk(
        chatResp({
          finishReason: "stop",
          content: "I cannot run destructive statements.",
        }),
      );
    });

    const adapter = createFakeAdapter();
    const adapterFactory: AdapterFactory = async () => adapter;
    const deps = makeDepsWithFetch(fetchMock as unknown as typeof fetch, cfg);
    const panel = new AiChatPanel({ extensionUri: vscode.Uri.file("/ext"), deps, adapterFactory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    handler({ type: "send", text: "drop users" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    // The read-only guard must have blocked adapter.runQuery from ever
    // seeing the DROP. This is the core regression guard wired through the
    // extension's tool chain.
    for (const call of adapter.calls) {
      const sql = call.sql.toLowerCase();
      expect(sql).not.toMatch(/\b(drop|delete|update|insert|truncate|alter)\b/);
    }
    // Specifically, runQuery was either never called, or only called with
    // a SELECT — never DROP.
    const dropped = adapter.calls.find((c) => /drop\s+table/i.test(c.sql));
    expect(dropped).toBeUndefined();
  });
});

// ============================================================================
// #4 — offline (fetch 500): ProviderError bubbles; message is scrubbed (no
// apiKey); panel survives.
// ============================================================================
describe("AiChatPanel — E2E offline 500", () => {
  it("fetch returns 500 → error posted with scrubbed message; panel still alive", async () => {
    const cfg = makeConfig({
      models: {
        work: { modelId: "fake-work", vision: true },
        smart: { modelId: "fake-smart", vision: false },
      },
    });
    const apiKey = cfg.apiKey;

    const fetchMock = vi.fn(async () => json500("upstream exploded"));

    const adapter = createFakeAdapter();
    const adapterFactory: AdapterFactory = async () => adapter;
    const deps = makeDepsWithFetch(fetchMock as unknown as typeof fetch, cfg);
    const panel = new AiChatPanel({ extensionUri: vscode.Uri.file("/ext"), deps, adapterFactory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    handler({ type: "send", text: "ping" });
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));

    const errs = postedMessages(p).filter(isError);
    expect(errs.length).toBeGreaterThan(0);
    const firstErr = errs[0] as ErrorMsg;
    expect(firstErr.message).toMatch(/500|Internal Server Error|upstream exploded/i);
    // Scrubbed — the apiKey string MUST NOT appear in any error message.
    const allText = JSON.stringify(errs);
    expect(allText).not.toContain(apiKey);
    // Panel survives: not disposed, done posted, can still send again.
    expect(p.disposed).toBe(false);
    expect(postedMessages(p).some(isDone)).toBe(true);
  });
});
// ============================================================================
// TASK-002 — Case #2: full-DB context reaches the provider body in E2E.
// Pins that the system prompt actually carries DDL through the real
// runAgent → createProviderClient → fetch pipeline (not just the unit-level
// buildMessages output).
// ============================================================================
describe("AiChatPanel — E2E full-DB context", () => {
  it("#2 system prompt carries DDL through to the provider request body", async () => {
    const cfg = makeConfig({
      models: {
        work: { modelId: "fake-work", vision: true },
        smart: { modelId: "fake-smart", vision: false },
      },
    });

    const fetchMock = vi.fn(async () =>
      jsonOk(chatResp({ finishReason: "stop", content: "Here is your schema." })),
    );

    const adapter = {
      ...createFakeAdapter({ tables: [] }),
      listSchemas: vi.fn(async () => [{ name: "public" }]),
      listTables: vi.fn(async (schema: string) =>
        schema === "public"
          ? [{ name: "users", schema: "public" }]
          : [] as Array<{ name: string; schema: string }>
      ),
      listViews: vi.fn(async () => []),
      listColumns: vi.fn(async (name: string, schema?: string) =>
        schema === "public" && name === "users"
          ? [
              { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
            ]
          : []
      ),
    } as unknown as ReturnType<typeof createFakeAdapter>;
    const adapterFactory: AdapterFactory = async () => adapter;

    const deps = makeDepsWithFetch(fetchMock as unknown as typeof fetch, cfg);
    const panel = new AiChatPanel({ extensionUri: vscode.Uri.file("/ext"), deps, adapterFactory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    handler({ type: "send", text: "list users" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callInit = fetchMock.mock.calls[0]?.[1];
    const bodyText = typeof callInit === "object" && callInit !== null && "body" in callInit
      ? String((callInit as { body: unknown }).body)
      : "";
    const body = JSON.parse(bodyText) as unknown;
    const isMsgArray = (v: unknown): v is Array<{ role: string; content: string }> =>
      Array.isArray(v) &&
      v.every(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          "role" in m &&
          "content" in m &&
          typeof (m as { role: unknown }).role === "string" &&
          typeof (m as { content: unknown }).content === "string",
      );
    const isRequestBody = (v: unknown): v is { messages: unknown } =>
      v !== null && typeof v === "object" && "messages" in v;
    const requestBody = isRequestBody(body) ? body : { messages: [] };
    const messages = isMsgArray(requestBody.messages) ? requestBody.messages : [];
    const sys = messages[0]?.content ?? "";
    expect(sys).toContain("Database structure (DDL):");
    expect(sys).toContain("CREATE TABLE public.users");

    // Final assistant bubble posted with done.
    const posted = postedMessages(p);
    const assistant = posted.find(isAssistant);
    expect(assistant).toBeDefined();
    expect(assistant!.text).toBe("Here is your schema.");
    expect(posted.some(isDone)).toBe(true);
  });
});

// ============================================================================
// TASK-007 — ACP engine E2E: real AcpClient + FakeAcpTransport (mirrors the
// pattern in aiChatPanelAcp.test.ts), reaching `assistant` + `done` through
// the actual `session/prompt` JSON-RPC RESPONSE (B1 fix) — never a fake
// `agent_end`/`turn_complete` notification, which real ACP does not send.
// This is the end-to-end proof that the omp/ACP chat path is not just
// unit-testable but actually completes a turn from the panel's perspective.
// ============================================================================
class FakeAcpTransport implements AcpTransport {
  written: string[] = [];
  private listeners: Array<(line: string) => void> = [];
  private closed = false;
  write(line: string): void {
    if (this.closed) return;
    this.written.push(line);
  }
  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }
  close(): void {
    this.closed = true;
    this.listeners.length = 0;
  }
  feed(line: string): void {
    for (const cb of this.listeners.slice()) cb(line);
  }
  allWritten(): Array<Record<string, unknown>> {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

interface FakeAcpSession {
  acp: AcpClient;
  transport: FakeAcpTransport;
}

function makeFakeAcpDeps(): {
  start: (ompPath: string, cwd: string) => Promise<AcpProcessHandle>;
  sessions: FakeAcpSession[];
} {
  const sessions: FakeAcpSession[] = [];
  return {
    sessions,
    start: async (): Promise<AcpProcessHandle> => {
      const transport = new FakeAcpTransport();
      const acp = new AcpClient(transport);
      sessions.push({ acp, transport });
      return {
        acp,
        sessionId: "sess-1",
        version: "18.0.1",
        dispose: () => {
          transport.close();
          acp.dispose();
        },
      };
    },
  };
}

function feedAgentMessageChunk(transport: FakeAcpTransport, text: string): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    }),
  );
}

/** Find the `id` of the most recently written `session/prompt` request. */
function lastPromptRequestId(transport: FakeAcpTransport): unknown {
  const frames = transport.allWritten().filter((f) => f["method"] === "session/prompt");
  const last = frames[frames.length - 1];
  return last?.["id"];
}

/** Feed the `session/prompt` JSON-RPC RESPONSE — the real ACP turn-completion
 * signal (`{stopReason: "end_turn" | ...}`), never a notification. */
function respondPrompt(transport: FakeAcpTransport, id: unknown, stopReason: string): void {
  transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } }));
}

describe("AiChatPanel — E2E ACP engine turn completion (TASK-007)", () => {
  it("streams agent_message_chunk deltas then settles on the session/prompt response, posting assistant + done", async () => {
    const { start, sessions } = makeFakeAcpDeps();
    const adapter = createFakeAdapter();
    const adapterFactory: AdapterFactory = async () => adapter;
    const panel = new AiChatPanel({
      extensionUri: vscode.Uri.file("/ext"),
      deps: makeDepsWithFetch(vi.fn() as unknown as typeof fetch, makeConfig()),
      adapterFactory,
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));

    handler({ type: "send", text: "list tables" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    feedAgentMessageChunk(session.transport, "Here ");
    feedAgentMessageChunk(session.transport, "are your tables.");

    const id = lastPromptRequestId(session.transport);
    respondPrompt(session.transport, id, "end_turn");

    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const posted = postedMessages(p);
    const assistant = posted.find(isAssistant) as AssistantMsg | undefined;
    expect(assistant).toBeDefined();
    expect(assistant!.text).toBe("Here are your tables.");
    expect(posted.some(isDone)).toBe(true);
    // No stray error posted — the turn completed cleanly via the real
    // stopReason-bearing response, not a fabricated agent_end notification.
    expect(posted.some(isError)).toBe(false);
  });
});