// src/ui/__tests__/aiChatPanelCloneHost.test.ts — TASK-AGTUI-006
//
// Host-side wiring for the clone protocol:
//   1) Ready path posts one `models` frame (active role + filtered roles).
//   2) Invalid `model_select` is rejected (error bubble + activeRole unchanged).
//   3) Valid `model_select` switches the active role silently — a fresh
//      `models` frame follows, NO assistant echo.
//   4) `bypass_permissions` ON auto-answers an ACP permission request with
//      the first allow-kind option (`allow-once` or `allow-session`).
//      The webview receives NO `permission_request` frame.
//   5) Bypass ON but the request's options contain no allow-kind entry →
//      default-DENY posture (resolved with no optionId, no webview frame).
//   6) Default OFF + reset flow parity: with OFF, permission_request reaches
//      the webview exactly as today; `enabled:false` after ON resets.
//   7) Regression: existing engine-dispatch suites pass unmodified.
//
// Tests use the existing harness pattern (mocked `vscode` + `agent`) so the
// only new dependency is `AgentDeps.loadConfig()` returning an `AiConfig`
// fixture. Tests do NOT mock `requestHostPermission` — they exercise the real
// path via the panel's own `handleAcpServerRequest` (the wire shape mirrors
// `src/ai/omp/hostMcp.ts:113-124`).

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AdapterFactory } from "../../ai/tools/types";
import type { AgentDeps } from "../../ai/agent";
import {
  AcpClient,
  type AcpTransport,
} from "../../ai/omp/acp";
import type { AcpProcessHandle } from "../../ai/omp/acpProcess";
import type { AiConfig, AiModelRole } from "../../ai/settings";

// Mock the agent module BEFORE importing the panel.
const agentState = vi.hoisted(() => ({
  runAgentMock: vi.fn() as Mock,
}));

vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return {
    ...actual,
    runAgent: agentState.runAgentMock,
  };
});

import { AiChatPanel, type AcpPanelDeps } from "../aiChatPanel";

// ---- vscode mock ------------------------------------------------------------
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
    asWebviewUri: Mock;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const state = vi.hoisted(() => ({
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
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

const extUri = vscode.Uri.file("/ext");

// ---- helpers ---------------------------------------------------------------

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

function panelHarness(): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
  const panel = state.panels[state.panels.length - 1] as MockPanel;
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

interface ModelsMsg {
  type: "models";
  active: AiModelRole;
  roles: Array<{ role: AiModelRole; modelId: string; vision: boolean }>;
}
interface InitMsg {
  type: "init";
}
interface ErrorMsg {
  type: "error";
  message: string;
}
interface AssistantMsg {
  type: "assistant";
  text: string;
}
interface PermissionRequestMsg {
  type: "permission_request";
  requestId: string;
  tool: { id: string; name: string; detail: string };
  options: Array<{ optionId: string; label: string }>;
}

function isModels(m: unknown): m is ModelsMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "models";
}
function isInit(m: unknown): m is InitMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isError(m: unknown): m is ErrorMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
function isAssistant(m: unknown): m is AssistantMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "assistant";
}
function isPermissionRequest(m: unknown): m is PermissionRequestMsg {
  return (
    !!m &&
    typeof m === "object" &&
    (m as { type?: string }).type === "permission_request"
  );
}

// ---- fixture helpers -------------------------------------------------------

/** Build an `AiConfig` fixture from per-role modelId overrides. Empty
 *  modelId is preserved verbatim — the host is responsible for filtering. */
function makeAiConfig(opts: {
  work?: string;
  smart?: string;
  autocomplete?: string;
  lite?: string;
}): AiConfig {
  return {
    baseUrl: "https://api.openai.com/v1",
    method: "chat/completions",
    timeoutMs: 60000,
    maxSteps: 12,
    models: {
      work: {
        modelId: opts.work ?? "",
        vision: true,
      },
      smart: {
        modelId: opts.smart ?? "",
        vision: false,
      },
      autocomplete: {
        modelId: opts.autocomplete ?? "",
        vision: false,
      },
      lite: {
        modelId: opts.lite ?? "",
        vision: false,
        engine: "omp",
      },
    },
    engine: "builtin",
    apiKey: "sk-fixture-not-loaded",
  };
}

function makeDepsWithConfig(cfg: AiConfig | null): AgentDeps {
  return {
    loadConfig: vi.fn(async () => cfg),
    complete: vi.fn(),
  };
}

// ---- ACP harness (mirrors aiChatPanelAcp.test.ts shape) -------------------

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
  exitListeners: Array<(code: number | null) => void>;
  disposeCalls: number;
}

interface FakeAcpDeps {
  start: (ompPath: string, cwd: string) => Promise<AcpProcessHandle>;
  sessions: FakeAcpSession[];
}

function makeFakeAcpDeps(): FakeAcpDeps {
  const sessions: FakeAcpSession[] = [];
  return {
    sessions,
    start: async (_ompPath: string, _cwd: string): Promise<AcpProcessHandle> => {
      const transport = new FakeAcpTransport();
      const acp = new AcpClient(transport);
      const session: FakeAcpSession = {
        acp,
        transport,
        exitListeners: [],
        disposeCalls: 0,
      };
      session.exitListeners.push((_code) => {
        acp.dispose();
      });
      sessions.push(session);
      return {
        acp,
        sessionId: "sess-1",
        version: "18.0.1",
        getStderrTail: () => "",
        dispose: () => {
          session.disposeCalls += 1;
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
  toolName = "x",
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { id: `tool-${id}`, name: toolName, detail: "" },
        options,
      },
    }),
  );
}

function respondPrompt(
  transport: FakeAcpTransport,
  id: unknown,
  stopReason: string,
): void {
  transport.feed(
    JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } }),
  );
}

function lastPromptRequestId(transport: FakeAcpTransport): unknown {
  const frames = transport.allWritten().filter((f) => f["method"] === "session/prompt");
  return frames[frames.length - 1]?.["id"];
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
  agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
});

// ============================================================================
// #1 — ready path posts one `models` frame
// ============================================================================
describe("AiChatPanel — TASK-AGTUI-006 ready posts models frame", () => {
  it("ready posts exactly one models frame filtered to non-empty modelId", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({
      work: "gpt-4o",
      smart: "gpt-4-turbo",
      autocomplete: "", // empty -> filtered out
      lite: "",          // empty -> filtered out
    });
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));
    await flush();

    const modelsFrames = postedMessages(p).filter(isModels);
    expect(modelsFrames).toHaveLength(1);
    const m = modelsFrames[0]!;
    expect(m.active).toBe("work");
    expect(m.roles).toHaveLength(2);
    const byRole = Object.fromEntries(m.roles.map((r) => [r.role, r]));
    expect(byRole.work).toEqual({ role: "work", modelId: "gpt-4o", vision: true });
    expect(byRole.smart).toEqual({ role: "smart", modelId: "gpt-4-turbo", vision: false });
    // Privacy: no apiKey/secrets cross the wire.
    const json = JSON.stringify(modelsFrames);
    expect(json).not.toMatch(/api_?key/i);
    expect(json).not.toMatch(/sk-[a-z0-9]/i);
    expect(json).not.toMatch(/fixture-not-loaded/);
  });
});

// ============================================================================
// #2 — invalid `model_select` rejected (cast as `AiModelRole`)
// ============================================================================
describe("AiChatPanel — TASK-AGTUI-006 model_select validation", () => {
  it("invalid role in model_select is rejected; activeRole unchanged; next models frame still shows old active", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({ work: "gpt-4o", smart: "gpt-4-turbo" });
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));
    const baselineModels = postedMessages(p).filter(isModels);
    expect(baselineModels).toHaveLength(1);
    expect(baselineModels[0]!.active).toBe("work");

    // Cast through unknown — the wire message type-system forbids this,
    // but the host must defensively reject unknown values.
    handler({ type: "model_select", role: "turbo" as unknown as AiModelRole });
    await flush();

    const errs = postedMessages(p).filter(isError);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/model/i);

    // activeRole unchanged: NO fresh `models` frame (the active field would
    // have flipped). The single existing models frame is still active:"work".
    const allModels = postedMessages(p).filter(isModels);
    expect(allModels).toHaveLength(1);
    expect(allModels[0]!.active).toBe("work");
  });

  it("valid role whose settings modelId is empty is rejected (no active role flip)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    // autocomplete is empty in settings → reject, NOT a flip.
    const cfg = makeAiConfig({ work: "gpt-4o" });
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));
    const baseline = postedMessages(p).filter(isModels);
    expect(baseline).toHaveLength(1);

    handler({ type: "model_select", role: "autocomplete" });
    await flush();

    const errs = postedMessages(p).filter(isError);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/model/i);
    // No new models frame — activeRole is unchanged.
    const allModels = postedMessages(p).filter(isModels);
    expect(allModels).toHaveLength(1);
    expect(allModels[0]!.active).toBe("work");
  });
});

// ============================================================================
// #3 — valid `model_select` switches role + posts fresh models frame
// ============================================================================
describe("AiChatPanel — TASK-AGTUI-006 model_select happy path", () => {
  it("valid role flips; fresh models frame with new active; NO assistant echo", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({ work: "gpt-4o", smart: "gpt-4-turbo" });
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));
    expect(postedMessages(p).filter(isModels)).toHaveLength(1);

    handler({ type: "model_select", role: "smart" });
    await until(() => postedMessages(p).filter(isModels).length >= 2);

    const models = postedMessages(p).filter(isModels);
    expect(models).toHaveLength(2);
    expect(models[0]!.active).toBe("work");
    expect(models[1]!.active).toBe("smart");
    // The chip path is silent — PLAN §3 (no assistant bubble on selection).
    expect(postedMessages(p).some(isAssistant)).toBe(false);
    expect(postedMessages(p).some(isError)).toBe(false);
  });
});

// ============================================================================
// #4 — bypass_permissions ON auto-answers allow-kind
// ============================================================================
describe("AiChatPanel — TASK-AGTUI-006 bypass ON auto-allow", () => {
  it("bypass ON: allow-kind option auto-selected; NO permission_request to webview; ACP resolved with that optionId", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({ work: "gpt-4o" });
    const { start, sessions } = makeFakeAcpDeps();
    const acp: AcpPanelDeps = { start };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
      acp,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));

    // Toggle ON.
    handler({ type: "bypass_permissions", enabled: true });

    // Trigger an ACP session so `handleAcpServerRequest` actually fires.
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);
    await flush();

    // Reset the postMessage log baseline AFTER send so permission_request
    // frames (if any) can be isolated.
    const baselineCount = postedMessages(p).length;

    feedPermissionRequest(session.transport, 42, [
      { optionId: "deny", label: "Deny" },
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "allow-session", label: "Allow for this session" },
    ]);

    // Wait for the server response to be written.
    await until(() => {
      const frames = session.transport.allWritten();
      return frames.some(
        (f) =>
          typeof f["id"] === "number" &&
          f["id"] === 42 &&
          f["result"] !== undefined,
      );
    });

    // The webview MUST NOT have received a `permission_request`.
    const newFrames = postedMessages(p).slice(baselineCount);
    expect(newFrames.some(isPermissionRequest)).toBe(false);

    // The written response must be `{outcome:"selected", optionId:<allow-kind>}`.
    const written = session.transport.allWritten();
    const reply = written.find(
      (f) => typeof f["id"] === "number" && f["id"] === 42,
    ) as Record<string, unknown>;
    expect(reply).toBeDefined();
    const result = reply["result"] as { outcome: { outcome: string; optionId?: string } };
    expect(result.outcome.outcome).toBe("selected");
    expect(["allow-once", "allow-session"]).toContain(result.outcome.optionId);

    // Settle the session/prompt so the test exits cleanly.
    const promptId = lastPromptRequestId(session.transport);
    if (promptId !== undefined) respondPrompt(session.transport, promptId, "end_turn");
  });
});

// ============================================================================
// #5 — bypass ON, options contain NO allow-kind → default-deny
// ============================================================================
describe("AiChatPanel — TASK-AGTUI-006 bypass ON default-deny fallback", () => {
  it("bypass ON + no allow-kind option: resolved as DENY (no optionId); no permission_request frame", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({ work: "gpt-4o" });
    const { start, sessions } = makeFakeAcpDeps();
    const acp: AcpPanelDeps = { start };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
      acp,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));

    handler({ type: "bypass_permissions", enabled: true });
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);
    await flush();

    const baselineCount = postedMessages(p).length;

    // Options contain ONLY a single deny entry (no allow-once / allow-session).
    feedPermissionRequest(session.transport, 99, [
      { optionId: "deny", label: "Deny" },
    ]);

    await until(() => {
      const frames = session.transport.allWritten();
      return frames.some(
        (f) =>
          typeof f["id"] === "number" &&
          f["id"] === 99 &&
          f["result"] !== undefined,
      );
    });

    const newFrames = postedMessages(p).slice(baselineCount);
    expect(newFrames.some(isPermissionRequest)).toBe(false);

    const written = session.transport.allWritten();
    const reply = written.find(
      (f) => typeof f["id"] === "number" && f["id"] === 99,
    ) as Record<string, unknown>;
    expect(reply).toBeDefined();
    const result = reply["result"] as { outcome: { outcome: string; optionId?: string } };
    // Default-deny: cancelled outcome, no optionId.
    expect(result.outcome.outcome).toBe("cancelled");
    expect(result.outcome.optionId).toBeUndefined();

    const promptId = lastPromptRequestId(session.transport);
    if (promptId !== undefined) respondPrompt(session.transport, promptId, "end_turn");
  });
});

// ============================================================================
// #6 — bypass OFF default + parity reset flow
// ============================================================================
describe("AiChatPanel — TASK-AGTUI-006 bypass OFF default + parity", () => {
  it("default is OFF; with OFF, permission_request reaches webview as today", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({ work: "gpt-4o" });
    const { start, sessions } = makeFakeAcpDeps();
    const acp: AcpPanelDeps = { start };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
      acp,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));

    // No bypass toggle posted — default is OFF. The toggle is panel-session
    // (no persistence); we cannot read it directly, but the parity test
    // below proves the OFF behavior.

    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);
    await flush();

    feedPermissionRequest(session.transport, 11, [
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));

    // Webview receives the request as today (parity).
    const requests = postedMessages(p).filter(isPermissionRequest);
    expect(requests).toHaveLength(1);

    const promptId = lastPromptRequestId(session.transport);
    if (promptId !== undefined) respondPrompt(session.transport, promptId, "end_turn");
  });

  it("bypass_permissions{enabled:false} after ON resets to OFF parity", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const factory: AdapterFactory = vi.fn(async () => null);
    const cfg = makeAiConfig({ work: "gpt-4o" });
    const { start, sessions } = makeFakeAcpDeps();
    const acp: AcpPanelDeps = { start };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDepsWithConfig(cfg),
      adapterFactory: factory,
      acp,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isModels));

    // Toggle ON then OFF.
    handler({ type: "bypass_permissions", enabled: true });
    handler({ type: "bypass_permissions", enabled: false });

    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);
    await flush();

    feedPermissionRequest(session.transport, 12, [
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));

    const requests = postedMessages(p).filter(isPermissionRequest);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    const promptId = lastPromptRequestId(session.transport);
    if (promptId !== undefined) respondPrompt(session.transport, promptId, "end_turn");
  });
});