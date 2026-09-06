// src/ui/__tests__/aiSettingsForm.test.ts
// Host tests for AiSettingsForm (TASK-004).
//
// Pattern mirror src/ui/__tests__/newTableForm.test.ts (mock vscode, capture
// panel + onDidReceiveMessage). Asserts:
//   - init round-trip (apiKey NEVER posted to webview)
//   - save happy / keep-stored-on-empty / empty-with-nothing-stored
//   - host re-validates before save
//   - test happy / error-mapping (apiKey-free message)
//   - cancel disposes
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import * as vscode from "vscode";
import { AiSettingsForm } from "../aiSettingsForm";
import { defaultAiSettings } from "../../ai/settings";
import type { AiSettings } from "../../ai/settings";
import type { AiConfig } from "../../ai/settings";
import type { ProviderRequest, ProviderResult } from "../../ai/provider";
import type { AiConfigStore } from "../../ai/config";

// ---- vscode mock (subset needed for AiSettingsForm) -----------------------
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
  onDidDispose: (cb: () => void) => { dispose: () => void };
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
          // Fire onDidDispose listeners (mirror VS Code semantics).
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
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

const extUri = vscode.Uri.file("/ext");

// ---- helpers ---------------------------------------------------------------

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

function panelHarness(): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
  const panel = state.panels[state.panels.length - 1];
  return {
    panel,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0][0],
  };
}

function postedMessages(panel: MockPanel): unknown[] {
  return panel.webview.postMessage.mock.calls.map((c) => c[0]);
}

interface InitMsg {
  type: "init";
  settings: AiSettings;
  hasApiKey: boolean;
}
interface TestResultMsg {
  type: "testResult";
  ok: boolean;
  latencyMs?: number;
  error?: string;
}
interface SavedMsg {
  type: "saved";
}
interface SaveResultMsg {
  type: "saveResult";
  ok: false;
  error: string;
}

function isInit(m: unknown): m is InitMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isTestResult(m: unknown): m is TestResultMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "testResult";
}
function isSaved(m: unknown): m is SavedMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "saved";
}
function isSaveResult(m: unknown): m is SaveResultMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "saveResult";
}

interface FakeStore {
  loadSettings: Mock;
  loadApiKey: Mock;
  save: Mock;
}

function makeStore(initial?: {
  settings?: AiSettings | null;
  apiKey?: string | undefined;
}): FakeStore {
  const s: FakeStore = {
    loadSettings: vi.fn().mockResolvedValue(initial?.settings ?? null),
    loadApiKey: vi.fn().mockResolvedValue(initial?.apiKey ?? undefined),
    save: vi.fn().mockResolvedValue(undefined),
  };
  return s;
}

const validSettings: AiSettings = {
  baseUrl: "https://api.openai.com/v1",
  method: "chat/completions",
  timeoutMs: 60000,
  maxSteps: 12,
  models: {
    work: { modelId: "gpt-4o-mini", vision: true },
    smart: { modelId: "gpt-4o", vision: false },
    autocomplete: { modelId: "", vision: false },
    lite: { modelId: "", vision: false, engine: "omp" },
  },
  engine: "builtin",
};


const invalidSettings: AiSettings = {
  baseUrl: "not-a-url",
  method: "chat/completions",
  timeoutMs: 60000,
  maxSteps: 12,
  models: {
    work: { modelId: "gpt-4o-mini", vision: true },
    smart: { modelId: "gpt-4o", vision: false },
    autocomplete: { modelId: "", vision: false },
    lite: { modelId: "", vision: false, engine: "omp" },
  },
  engine: "builtin",
};
beforeEach(() => {
  state.panels.length = 0;
});

// ============================================================================
// #1 — init round-trip (apiKey NOT posted to webview)
// ============================================================================
describe("AiSettingsForm — init round-trip", () => {
  it("init: posts settings + hasApiKey:true; no apiKey field anywhere", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    const initMsg = postedMessages(panel).find(isInit);
    expect(initMsg).toBeDefined();
    expect(initMsg!.settings).toEqual(validSettings);
    expect(initMsg!.hasApiKey).toBe(true);
    // SECURITY: apiKey must never appear in init payload.
    const json = JSON.stringify(initMsg);
    expect(json).not.toContain("sk-1");
    expect(Object.prototype.hasOwnProperty.call(initMsg, "apiKey")).toBe(false);
  });

  it("init: unconfigured → defaults + hasApiKey:false", async () => {
    const store = makeStore({ settings: null, apiKey: undefined });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    const initMsg = postedMessages(panel).find(isInit);
    expect(initMsg).toBeDefined();
    expect(initMsg!.settings).toEqual(defaultAiSettings());
    expect(initMsg!.hasApiKey).toBe(false);
  });
});

// ============================================================================
// #3–#5 — save paths
// ============================================================================
describe("AiSettingsForm — save", () => {
  it("happy path: store.save called with (settings, apiKey); posts saved", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "save", settings: validSettings, apiKey: "sk-2" });
    await until(() => store.save.mock.calls.length > 0);
    expect(store.save).toHaveBeenCalledWith(validSettings, "sk-2");
    await until(() => postedMessages(panel).some(isSaved));
    expect(postedMessages(panel).some(isSaved)).toBe(true);
  });

  it("keeps stored key when submitted apiKey is empty and a key exists", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "save", settings: validSettings, apiKey: "" });
    await until(() => store.save.mock.calls.length > 0);
    expect(store.save).toHaveBeenCalledWith(validSettings, "sk-1");
  });

  it("empty key + nothing stored: store.save NOT called; saveResult error posted (B13: not testResult)", async () => {
    const store = makeStore({ settings: validSettings, apiKey: undefined });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "save", settings: validSettings, apiKey: "" });
    await until(() => postedMessages(panel).some(isSaveResult));
    expect(store.save).not.toHaveBeenCalled();
    // B13 regression guard: a failed SAVE must never surface on the
    // testResult channel — that would render as "test failed" when nothing
    // was ever tested.
    expect(postedMessages(panel).some(isTestResult)).toBe(false);
    const errs = postedMessages(panel).filter(isSaveResult);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].ok).toBe(false);
    expect(errs[0].error).toBe("API key is required");
  });

  it("invalid submitted settings: store.save NOT called; saveResult error posted (B13: not testResult); no complete", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "save", settings: invalidSettings, apiKey: "sk-1" });
    await until(() => postedMessages(panel).some(isSaveResult));
    expect(store.save).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(postedMessages(panel).some(isTestResult)).toBe(false);
    const errs = postedMessages(panel).filter(isSaveResult);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].ok).toBe(false);
    expect(errs[0].error).toMatch(/Base URL/);
  });

  it("B13 edge: store.save() itself throws → saveResult{ok:false} posted, NOT testResult", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    store.save.mockRejectedValue(new Error("disk full"));
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "save", settings: validSettings, apiKey: "sk-2" });
    await until(() => postedMessages(panel).some(isSaveResult));
    expect(postedMessages(panel).some(isTestResult)).toBe(false);
    expect(postedMessages(panel).some(isSaved)).toBe(false);
    const errs = postedMessages(panel).filter(isSaveResult);
    expect(errs[0].ok).toBe(false);
    expect(errs[0].error).toBe("disk full");
  });
});

// ============================================================================
// #7–#8 — test button paths
// ============================================================================
describe("AiSettingsForm — test", () => {
  it("happy path: complete called with work + tiny probe; posts ok+latencyMs", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn(
      async (_cfg: AiConfig, _role: "work", _req: ProviderRequest): Promise<ProviderResult> => ({
        text: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "test", settings: validSettings, apiKey: "" });
    await until(() => complete.mock.calls.length > 0);
    const [cfg, role, req] = complete.mock.calls[0];
    expect(role).toBe("work");
    expect(req.modelId).toBe(validSettings.models.work.modelId);
    expect(req.messages).toEqual([{ role: "user", content: "Reply with: ok" }]);
    expect(req.maxOutputTokens).toBe(8);
    expect(cfg.apiKey).toBe("sk-1");
    await until(() =>
      postedMessages(panel).some(
        (m) => isTestResult(m) && m.ok === true,
      ),
    );
    const ok = postedMessages(panel).filter(isTestResult).find((m) => m.ok);
    expect(ok).toBeDefined();
    expect(typeof ok!.latencyMs).toBe("number");
    expect(ok!.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it("complete rejects ProviderError: testResult{ok:false, error:msg}; no apiKey in error", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn(async () => {
      // Mimic what real provider does: throw ProviderError with message that
      // does NOT contain apiKey (provider scrubs).
      throw new Error("401 Unauthorized — bad key");
    });
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "test", settings: validSettings, apiKey: "" });
    await until(() =>
      postedMessages(panel).some(
        (m) => isTestResult(m) && m.ok === false,
      ),
    );
    const err = postedMessages(panel).filter(isTestResult).find((m) => !m.ok);
    expect(err).toBeDefined();
    expect(err!.error).toBe("401 Unauthorized — bad key");
    expect(JSON.stringify(err)).not.toContain("sk-1");
  });

  it("invalid settings + test: complete NOT called; error posted", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "test", settings: invalidSettings, apiKey: "" });
    await until(() => postedMessages(panel).some(isTestResult));
    expect(complete).not.toHaveBeenCalled();
    const errs = postedMessages(panel).filter(isTestResult);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].ok).toBe(false);
  });
});

// ============================================================================
// #11a — cancel disposes the panel
// ============================================================================
describe("AiSettingsForm — cancel", () => {
  it("cancel: panel disposed; save never called", async () => {
    const store = makeStore({ settings: validSettings, apiKey: "sk-1" });
    const complete = vi.fn();
    const form = new AiSettingsForm({
      extensionUri: extUri,
      store: store as unknown as Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">,
      complete,
    });
    form.show();
    const { panel, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(panel).some(isInit));
    handler({ type: "cancel" });
    await Promise.resolve();
    expect(panel.disposed).toBe(true);
    expect(store.save).not.toHaveBeenCalled();
  });
});

// =============================================================================
// R1 fix regression: README privacy/egress contract (task Test Case #13).
// README must name SecretStorage, the single-endpoint egress promise, and the
// no-telemetry/no-log statement — this test fails if the section is deleted
// or weakened, keeping docs and code honest.
// =============================================================================
describe("AiSettingsForm — README privacy contract", () => {
  it("README AI section names SecretStorage, single-endpoint egress, no telemetry/no log", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile("README.md", "utf8");
    expect(readme).toMatch(/SecretStorage/);
    expect(readme).toMatch(/baseUrl user cấu hình|`baseUrl`/);
    expect(readme).toMatch(/không telemetry|no telemetry|no analytics/i);
    expect(readme).toMatch(/không xuất hiện trong|logs|error message/i);
  });
});
