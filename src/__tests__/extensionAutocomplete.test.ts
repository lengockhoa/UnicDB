// src/__tests__/extensionAutocomplete.test.ts — Cycle AIC TASK-AIC-005.

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p, scheme: "file" }),
    joinPath: (...parts: unknown[]) => ({
      toString: () => parts.map((p) => String(p)).join("/"),
    }),
  },
  workspace: { workspaceFolders: undefined, getConfiguration: vi.fn() },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  languages: {
    registerInlineCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  InlineCompletionItem: class { constructor(public insertText: string) {} },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    dispose() {}
  },
  env: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  registerSqlAutocomplete,
  type AutocompleteDeps,
} from "../extensionAutocomplete";
import type { AiConfig } from "../ai/settings";
import type { SqlAutocompleteService } from "../ai/sqlAutocomplete";

function makeService() {
  const suggest = vi.fn().mockResolvedValue("suffix");
  const cancel = vi.fn();
  return { suggest, cancel } as unknown as SqlAutocompleteService;
}

function makeCfg(): AiConfig {
  return {
    baseUrl: "https://api.example.com/v1",
    method: "openai",
    timeoutMs: 30000,
    maxSteps: 5,
    models: {
      work: { modelId: "gpt", vision: false },
      smart: { modelId: "o1", vision: false },
      autocomplete: { modelId: "gpt", vision: false },
    },
    engine: "builtin",
    apiKey: "sk-test",
  };
}

function buildDeps(): AutocompleteDeps {
  return {
    service: makeService(),
    loadConfig: vi.fn().mockResolvedValue(makeCfg()),
  };
}

describe("extensionAutocomplete — AIC-005 lifecycle", () => {
  beforeEach(() => {
    vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mockClear();
  });

  it("registers an InlineCompletionItemProvider scoped to SQL", () => {
    const deps = buildDeps();
    const reg = registerSqlAutocomplete(deps);
    expect(vscode.languages.registerInlineCompletionItemProvider).toHaveBeenCalledTimes(1);
    const [selector] = vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mock.calls[0] as [
      { language: string; scheme: string },
    ];
    expect(selector.language).toBe("sql");
    expect(selector.scheme).toBe("file");
    reg.dispose();
  });

  it("consoleAutocomplete delegates to the service.suggest with callerScope=tabId", async () => {
    const deps = buildDeps();
    const reg = registerSqlAutocomplete(deps);
    const out = await reg.consoleAutocomplete({
      tabId: "tab-1",
      requestId: "r-1",
      cursorOffset: 8,
      documentText: "SELECT *",
      schemaFingerprint: "v1",
      signal: new AbortController().signal,
    });
    expect(out).toBe("suffix");
    expect(vi.mocked(deps.service as unknown as { suggest: ReturnType<typeof vi.fn> }).suggest).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deps.service as unknown as { suggest: ReturnType<typeof vi.fn> }).suggest.mock.calls[0];
    const req = call[1] as { callerScope: string; cursorOffset: number; documentText: string };
    expect(req.callerScope).toBe("tab-1");
    expect(req.cursorOffset).toBe(8);
    expect(req.documentText).toBe("SELECT *");
    reg.dispose();
  });

  it("dispose() drops the registered provider", () => {
    const deps = buildDeps();
    const disposable = { dispose: vi.fn() };
    vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mockReturnValueOnce(
      disposable as unknown as vscode.Disposable,
    );
    const reg = registerSqlAutocomplete(deps);
    reg.dispose();
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when registerInlineCompletionItemProvider is unavailable", () => {
    vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mockImplementationOnce(
      (() => undefined) as unknown as typeof vscode.languages.registerInlineCompletionItemProvider,
    );
    const deps = buildDeps();
    const reg = registerSqlAutocomplete(deps);
    expect(() => reg.dispose()).not.toThrow();
  });

  it("consoleAutocomplete resolves null when loadConfig returns null (unconfigured)", async () => {
    const deps = buildDeps();
    deps.loadConfig = vi.fn().mockResolvedValue(null);
    const reg = registerSqlAutocomplete(deps);
    const out = await reg.consoleAutocomplete({
      tabId: "t",
      requestId: "r",
      cursorOffset: 0,
      documentText: "",
      schemaFingerprint: "v1",
      signal: new AbortController().signal,
    });
    expect(out).toBeNull();
    const suggestFn = vi.mocked(deps.service as unknown as { suggest: ReturnType<typeof vi.fn> }).suggest;
    expect(suggestFn).not.toHaveBeenCalled();
    reg.dispose();
  });
});
