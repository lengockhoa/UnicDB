// src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts — TASK-CHATV2-012
//
// Host-side acknowledged engine/model switching (V2). Pins:
//   - a `set_engine` the host can honour is APPLIED and acked by a
//     `capabilities` frame carrying the SAME clientRequestId;
//   - a `set_engine` the host cannot honour changes NOTHING and answers with
//     the exact safe failure toast (also correlated);
//   - a `set_model` for a configured role flips `active` and acks with a
//     correlated `models` frame; an unconfigured role is refused;
//   - the four-engine vocabulary is validated (unknown engine rejected).
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AdapterFactory } from "../../ai/tools/types";
import type { AgentDeps } from "../../ai/agent";

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
    showInformationMessage: vi.fn(async () => undefined),
  },
  workspace: {
    getConfiguration: vi.fn((_section: string) => ({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(async () => undefined),
    })),
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn(),
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

import { AiChatPanel } from "../aiChatPanel";

const extUri = vscode.Uri.file("/ext");

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until: condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
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

function isInit(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}

function v2(
  panel: MockPanel,
  kind: string,
): Array<Record<string, unknown>> {
  return postedMessages(panel).filter(
    (m) => m["protocolVersion"] === 2 && m["kind"] === kind,
  );
}

function makeDeps(): AgentDeps & { readonly modelId: string } {
  const modelId = "acme/sonnet";
  return {
    modelId,
    loadConfig: vi.fn(async () => ({
      models: {
        work: { modelId, vision: true },
        smart: { modelId: "acme/opus", vision: true },
        lite: { modelId: "", vision: false },
        autocomplete: { modelId: "", vision: false },
      },
    })) as unknown as AgentDeps["loadConfig"],
    complete: vi.fn(),
  };
}

beforeEach(() => {
  state.panels.length = 0;
});

async function readyPanel(engine?: "builtin" | "claude-code" | "codex"): Promise<{
  panel: MockPanel;
  handler: (msg: unknown) => void;
}> {
  const factory: AdapterFactory = vi.fn(async () => null);
  const panel = new AiChatPanel({
    extensionUri: extUri,
    deps: makeDeps(),
    adapterFactory: factory,
    ...(engine === undefined ? {} : { engine }),
  });
  panel.show();
  const h = panelHarness();
  h.handler({ type: "ready" });
  await until(() => postedMessages(h.panel).some(isInit));
  return h;
}

describe("AiChatPanel — TASK-CHATV2-012 set_engine (idle ack)", () => {
  it("applies a validated switch and acks with the SAME clientRequestId", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const claudeEngine = {
      send: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      engine: "builtin",
      claudeCodeChatEngine: claudeEngine as never,
    });
    panel.show();
    const handler = panelHarness().handler;
    handler({ type: "ready" });
    await until(() => postedMessages(state.panels[state.panels.length - 1]!).some(isInit));
    const live = state.panels[state.panels.length - 1]!;

    handler({ kind: "set_engine", protocolVersion: 2, clientRequestId: "c-1", engine: "claude-code" });
    await until(() => v2(live, "capabilities").some((f) => f["clientRequestId"] === "c-1"));

    const ack = v2(live, "capabilities").find((f) => f["clientRequestId"] === "c-1")!;
    const caps = ack["capabilities"] as { engine: string; displayName: string };
    expect(caps.engine).toBe("claude-code");
    expect(caps.displayName).toBe("Claude Code");
  });

  it("refuses an unsupported engine with exact safe copy and no state change", async () => {
    const { panel, handler } = await readyPanel("builtin");
    const capsBefore = v2(panel, "capabilities").length;

    handler({ kind: "set_engine", protocolVersion: 2, clientRequestId: "c-2", engine: "codex" });
    await until(() => v2(panel, "toast").length > 0);

    const toast = v2(panel, "toast").find((t) => t["clientRequestId"] === "c-2");
    expect(toast).toBeDefined();
    expect(toast!["level"]).toBe("error");
    expect(toast!["safeMessage"]).toBe("Could not switch to Codex. This engine is not installed.");
    // No capability ack for a refused switch — the webview keeps the OLD pill.
    expect(v2(panel, "capabilities").length).toBe(capsBefore);
  });

  it("accepts a switch to an engine whose adapter seam is present (Codex)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const codexEngine = {
      send: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      engine: "builtin",
      codexChatEngine: codexEngine as never,
    });
    panel.show();
    const h = panelHarness();
    h.handler({ type: "ready" });
    await until(() => postedMessages(h.panel).some(isInit));

    h.handler({ kind: "set_engine", protocolVersion: 2, clientRequestId: "c-3", engine: "codex" });
    await until(() =>
      v2(h.panel, "capabilities").some((f) => f["clientRequestId"] === "c-3"),
    );
    const ack = v2(h.panel, "capabilities").find((f) => f["clientRequestId"] === "c-3")!;
    expect((ack["capabilities"] as { engine: string }).engine).toBe("codex");
  });

  it("rejects an unknown engine literal at the protocol boundary", async () => {
    const { panel, handler } = await readyPanel("builtin");
    const before = v2(panel, "capabilities").length;
    handler({ kind: "set_engine", protocolVersion: 2, clientRequestId: "c-4", engine: "skynet" });
    await until(() => v2(panel, "toast").length > 0);
    // The malformed intent never reaches the panel handler.
    expect(v2(panel, "capabilities").length).toBe(before);
    const toast = v2(panel, "toast")[0]!;
    expect(toast["safeMessage"]).toBe("That chat action was not understood.");
  });
});

describe("AiChatPanel — TASK-CHATV2-012 set_model (validated ack)", () => {
  it("applies a configured role and acks with a correlated models frame", async () => {
    const { panel, handler } = await readyPanel("builtin");
    handler({ kind: "set_model", protocolVersion: 2, clientRequestId: "m-1", role: "smart" });
    await until(() => v2(panel, "models").some((f) => f["clientRequestId"] === "m-1"));
    const ack = v2(panel, "models").find((f) => f["clientRequestId"] === "m-1")!;
    expect(ack["active"]).toBe("smart");
    // The frame carries the configured roles (work/smart here).
    const roles = ack["roles"] as Array<{ role: string; modelId: string }>;
    expect(roles.map((r) => r.role).sort()).toEqual(["smart", "work"]);
  });

  it("refuses an unconfigured role with safe copy and keeps the prior role", async () => {
    const { panel, handler } = await readyPanel("builtin");
    const before = v2(panel, "models").length;
    handler({ kind: "set_model", protocolVersion: 2, clientRequestId: "m-2", role: "lite" });
    await until(() => v2(panel, "toast").some((t) => t["clientRequestId"] === "m-2"));
    const toast = v2(panel, "toast").find((t) => t["clientRequestId"] === "m-2")!;
    expect(toast["safeMessage"]).toBe(
      "Could not change the model. That role is not configured.",
    );
    // No models ack: the chip retains its prior label.
    expect(v2(panel, "models").length).toBe(before);
  });

  it("rejects an unknown role literal at the protocol boundary", async () => {
    const { panel, handler } = await readyPanel("builtin");
    const before = v2(panel, "models").length;
    handler({ kind: "set_model", protocolVersion: 2, clientRequestId: "m-3", role: "turbo" });
    await until(() => v2(panel, "toast").length > 0);
    expect(v2(panel, "models").length).toBe(before);
  });
});

describe("AiChatPanel — TASK-CHATV2-012 capability gating keeps the old engine honest", () => {
  it("omitting an adapter never advertises its capability on a fresh ready", async () => {
    const { panel } = await readyPanel("builtin");
    const first = v2(panel, "capabilities")[0]!;
    const caps = first["capabilities"] as {
      engine: string;
      supports: { permissions: boolean };
    };
    expect(caps.engine).toBe("builtin");
    // First ready frame is NOT an ack — it carries no correlation id.
    expect(first["clientRequestId"]).toBeUndefined();
  });
});
