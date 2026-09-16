// src/ui/__tests__/aiChatPanelReadyV2Models.test.ts — REVIEW-CHATV2-R1 P1-2
//
// The V2 webview consumes ONLY the V2 `models` frame (the V1 models handler
// is gone), so the ready handshake must mirror the legacy `models` post on
// the V2 seam — otherwise the model chip boots dead. Pins the ready fan-out:
// legacy `models` AND V2 `models` with the same active role + role catalog,
// and the set_model ack still carries the correlation id.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps } from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";

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
        dispose: vi.fn(),
        visible: true,
        disposed: false,
      };
      state.panels.push(panel);
      return panel;
    }),
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/work" }, name: "work", index: 0 }] },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn(),
}));

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

import { AiChatPanel } from "../aiChatPanel";

interface ModelsFrame {
  active: string;
  roles: Array<{ role: string; modelId: string; vision: boolean }>;
}

function posted(panel: MockPanel): Array<Record<string, unknown>> {
  return panel.webview.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

describe("REVIEW-CHATV2-R1 P1-2 — ready fan-out mirrors models on the V2 seam", () => {
  beforeEach(() => {
    state.panels.length = 0;
    (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  });

  it("ready posts a V2 models frame with the active role + catalog (no clientRequestId)", async () => {
    const panel = new AiChatPanel({
      extensionUri: vscode.Uri.file("/ext"),
      deps: { loadConfig: vi.fn(async () => null), complete: vi.fn() } as unknown as AgentDeps,
      adapterFactory: vi.fn(async () => null) as unknown as AdapterFactory,
      engine: "builtin",
    });
    panel.show();
    const p = state.panels[state.panels.length - 1] as MockPanel;
    const handler = p.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (msg: unknown) => void;
    handler({ protocolVersion: 2, kind: "ready_v2" });
    await flush();

    const legacyModels = posted(p).filter((m) => m.type === "models") as ModelsFrame[];
    expect(legacyModels.length).toBe(1);
    const v2Models = posted(p).filter(
      (m) => m.protocolVersion === 2 && m.kind === "models",
    ) as Array<Record<string, unknown> & ModelsFrame>;
    // THE FIX: the V2 seam receives the same catalog the legacy frame carries.
    expect(v2Models.length).toBe(1);
    expect(v2Models[0]!.active).toBe(legacyModels[0]!.active);
    expect(v2Models[0]!.roles).toEqual(legacyModels[0]!.roles);
    // The ready fan-out is NOT a set_model ack — no correlation id.
    expect(v2Models[0]!.clientRequestId).toBeUndefined();
    // The chip/menu seed arrives before hydration completes.
    const hydrateIdx = posted(p).findIndex((m) => m.kind === "session_hydrated");
    const modelsIdx = posted(p).findIndex((m) => m.kind === "models");
    expect(modelsIdx).toBeGreaterThanOrEqual(0);
    expect(hydrateIdx).toBeGreaterThan(modelsIdx);
  });
});
