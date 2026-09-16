// src/ui/__tests__/aiChatPanelPermissionsV2.test.ts — TASK-CHATV2-014
//
// Host-side V2 permission policy + request correlation:
//   - the initial `capabilities` frame advertises the live `permissionPolicy`;
//   - a `set_permission_policy` flips the session flag and is ACKED by a
//     correlated `capabilities` frame carrying the NEW policy; a duplicate id
//     is inert (exactly one ack), so the webview only commits on an ack;
//   - a bypass policy auto-answers allow-kind options and sends NO request;
//     with no allow-kind option the host default-DENIES;
//   - with default policy a request reaches BOTH wires (legacy + V2
//     `permission_requested`), and a late/unknown `permission_response` is a
//     no-op (exactly one ACP result per request);
//   - the destructive-statement consent gate is untouched by bypass.
//
// Harness mirrors aiChatPanelCloneHost.test.ts (mocked vscode + agent, real
// ACP transport).
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AdapterFactory } from "../../ai/tools/types";
import type { AgentDeps } from "../../ai/agent";
import type { AiConfig } from "../../ai/settings";
import type { AcpProcessHandle } from "../../ai/omp/acpProcess";
import {
  AcpClient,
  type AcpTransport,
} from "../../ai/omp/acp";

const agentState = vi.hoisted(() => ({ runAgentMock: vi.fn() as Mock }));
vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return { ...actual, runAgent: agentState.runAgentMock };
});

type Listener<T> = (e: T) => void;
interface MockPanel {
  webview: {
    html: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const state = vi.hoisted(() => ({ panels: [] as MockPanel[] }));

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
        }),
        visible: true,
        disposed: false,
      };
      state.panels.push(panel);
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
  EventEmitter: vi.fn(),
}));

import { AiChatPanel, type AcpPanelDeps } from "../aiChatPanel";

const extUri = vscode.Uri.file("/ext");

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until: condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

function panelHarness(): { panel: MockPanel; handler: (msg: unknown) => void } {
  const panel = state.panels[state.panels.length - 1] as MockPanel;
  return {
    panel,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (msg: unknown) => void,
  };
}

function postedMessages(panel: MockPanel): Array<Record<string, unknown>> {
  return panel.webview.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

function v2(panel: MockPanel, kind: string): Array<Record<string, unknown>> {
  return postedMessages(panel).filter((m) => m["protocolVersion"] === 2 && m["kind"] === kind);
}

function isInit(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}

function makeAiConfig(work = "gpt-4o"): AiConfig {
  return {
    baseUrl: "https://api.openai.com/v1",
    method: "chat/completions",
    timeoutMs: 60000,
    maxSteps: 12,
    models: {
      work: { modelId: work, vision: true },
      smart: { modelId: "", vision: false },
      autocomplete: { modelId: "", vision: false },
      lite: { modelId: "", vision: false, engine: "omp" },
    },
    engine: "builtin",
    apiKey: "sk-fixture-not-loaded",
  };
}

function makeDeps(cfg: AiConfig | null = makeAiConfig()): AgentDeps {
  return { loadConfig: vi.fn(async () => cfg), complete: vi.fn() };
}

// ---- ACP harness -----------------------------------------------------------

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

function makeFakeAcpDeps(): { start: (p: string, cwd: string) => Promise<AcpProcessHandle>; sessions: FakeAcpSession[] } {
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
        getStderrTail: () => "",
        dispose: () => {
          transport.close();
          acp.dispose();
        },
      };
    },
  };
}

function feedPermissionRequest(
  transport: FakeAcpTransport,
  id: number,
  options: Array<{ optionId: string; label: string }>,
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { id: `tool-${id}`, name: "run", detail: "" },
        options,
      },
    }),
  );
}

function respondPrompt(transport: FakeAcpTransport, id: unknown, stopReason: string): void {
  transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } }));
}

function lastPromptRequestId(transport: FakeAcpTransport): unknown {
  const frames = transport.allWritten().filter((f) => f["method"] === "session/prompt");
  return frames[frames.length - 1]?.["id"];
}

function permissionReply(transport: FakeAcpTransport, id: number): Record<string, unknown> | undefined {
  return transport
    .allWritten()
    .find((f) => f["id"] === id && f["result"] !== undefined);
}

/** Ready an ACP-mode panel and drive one turn to the point where a permission
 * request can be fed. Returns the live session + panel handler. */
async function acpTurn(): Promise<{
  panel: MockPanel;
  handler: (msg: unknown) => void;
  session: FakeAcpSession;
}> {
  agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
  const factory: AdapterFactory = vi.fn(async () => null);
  const { start, sessions } = makeFakeAcpDeps();
  const acp: AcpPanelDeps = { start };
  const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory, acp });
  panel.show();
  const h = panelHarness();
  h.handler({ type: "ready" });
  await until(() => postedMessages(h.panel).some(isInit));
  h.handler({ type: "send", text: "go" });
  await until(() => sessions.length > 0);
  const session = sessions[0];
  await until(() => lastPromptRequestId(session.transport) !== undefined);
  await flush();
  return { panel: h.panel, handler: h.handler, session };
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

describe("TASK-CHATV2-014 host — policy capability + ack", () => {
  it("the initial capabilities frame advertises the default policy", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(state.panels[state.panels.length - 1]!).some(isInit));
    const live = state.panels[state.panels.length - 1]!;
    const caps = v2(live, "capabilities");
    expect(caps.length).toBeGreaterThan(0);
    expect(caps[0]["permissionPolicy"]).toBe("default");
  });

  it("acks a set_permission_policy with the correlated NEW policy, once", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(state.panels[state.panels.length - 1]!).some(isInit));
    const live = state.panels[state.panels.length - 1]!;

    handler({ kind: "set_permission_policy", protocolVersion: 2, clientRequestId: "p-1", policy: "bypass" });
    await until(() => v2(live, "capabilities").some((f) => f["clientRequestId"] === "p-1"));
    const ack = v2(live, "capabilities").filter((f) => f["clientRequestId"] === "p-1");
    expect(ack).toHaveLength(1);
    expect(ack[0]["permissionPolicy"]).toBe("bypass");

    // A duplicate id is inert: still exactly one ack for it.
    handler({ kind: "set_permission_policy", protocolVersion: 2, clientRequestId: "p-1", policy: "default" });
    await flush();
    expect(v2(live, "capabilities").filter((f) => f["clientRequestId"] === "p-1")).toHaveLength(1);
  });

  it("rejects an invalid policy literal without changing state", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(state.panels[state.panels.length - 1]!).some(isInit));
    const live = state.panels[state.panels.length - 1]!;
    const before = v2(live, "capabilities").length;

    handler({ kind: "set_permission_policy", protocolVersion: 2, clientRequestId: "p-bad", policy: "nonsense" });
    await flush();
    expect(v2(live, "capabilities").length).toBe(before);
    expect(v2(live, "toast").some((t) => t["level"] === "warning")).toBe(true);
  });
});

describe("TASK-CHATV2-014 host — bypass auto-answer + request correlation", () => {
  it("bypass ON auto-answers allow-kind and sends NO permission_request frame", async () => {
    const { panel, handler, session } = await acpTurn();
    handler({ kind: "set_permission_policy", protocolVersion: 2, clientRequestId: "p-1", policy: "bypass" });
    await until(() => v2(panel, "capabilities").some((f) => f["clientRequestId"] === "p-1"));
    const baseline = postedMessages(panel).length;

    feedPermissionRequest(session.transport, 7, [
      { optionId: "deny", label: "Deny" },
      { optionId: "allow-once", label: "Allow once" },
    ]);
    await until(() => permissionReply(session.transport, 7) !== undefined);

    // No legacy permission_request and no V2 permission_requested.
    const newFrames = postedMessages(panel).slice(baseline);
    expect(newFrames.some((m) => (m as { type?: string }).type === "permission_request")).toBe(false);
    expect(v2(panel, "permission_requested").length).toBe(0);

    const reply = permissionReply(session.transport, 7)!;
    const outcome = (reply["result"] as { outcome: { outcome: string; optionId?: string } }).outcome;
    expect(outcome.outcome).toBe("selected");
    expect(outcome.optionId).toBe("allow-once");

    const pid = lastPromptRequestId(session.transport);
    if (pid !== undefined) respondPrompt(session.transport, pid, "end_turn");
  });

  it("bypass ON with no allow-kind option default-DENIES (no optionId)", async () => {
    const { panel, handler, session } = await acpTurn();
    handler({ kind: "set_permission_policy", protocolVersion: 2, clientRequestId: "p-2", policy: "bypass" });
    await until(() => v2(panel, "capabilities").some((f) => f["clientRequestId"] === "p-2"));

    feedPermissionRequest(session.transport, 8, [{ optionId: "deny", label: "Deny" }]);
    await until(() => permissionReply(session.transport, 8) !== undefined);
    const reply = permissionReply(session.transport, 8)!;
    const outcome = (reply["result"] as { outcome: { outcome: string; optionId?: string } }).outcome;
    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.optionId).toBeUndefined();
    expect(v2(panel, "permission_requested").length).toBe(0);

    const pid = lastPromptRequestId(session.transport);
    if (pid !== undefined) respondPrompt(session.transport, pid, "end_turn");
  });

  it("default policy surfaces the request on BOTH wires and answers exactly once", async () => {
    const { panel, session } = await acpTurn();
    feedPermissionRequest(session.transport, 9, [
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ]);
    await until(() => v2(panel, "permission_requested").length > 0);

    const req = v2(panel, "permission_requested")[0];
    expect(req["requestId"]).toBeTruthy();
    expect((req["tool"] as { name: string }).name).toBe("run");
    // Legacy wire parity.
    expect(postedMessages(panel).some((m) => (m as { type?: string }).type === "permission_request")).toBe(true);

    const requestId = req["requestId"] as string;
    const { handler } = panelHarness();
    handler({ type: "permission_response", requestId, optionId: "allow-once" });
    await until(() => permissionReply(session.transport, 9) !== undefined);

    // A late duplicate response is a no-op — still exactly one ACP result.
    handler({ type: "permission_response", requestId, optionId: "deny" });
    await flush();
    const replies = session.transport.allWritten().filter((f) => f["id"] === 9 && f["result"] !== undefined);
    expect(replies).toHaveLength(1);
    const outcome = (replies[0]["result"] as { outcome: { outcome: string; optionId?: string } }).outcome;
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });

    const pid = lastPromptRequestId(session.transport);
    if (pid !== undefined) respondPrompt(session.transport, pid, "end_turn");
  });
});
