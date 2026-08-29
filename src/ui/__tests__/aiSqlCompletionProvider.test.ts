// src/ui/__tests__/aiSqlCompletionProvider.test.ts
// Cycle AIC TASK-AIC-003 — native InlineCompletionItemProvider adapter.
import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => {
  class InlineCompletionItem {
    insertText: string;
    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    constructor(insertText: string, range?: InlineCompletionItem["range"]) {
      this.insertText = insertText;
      this.range = range;
    }
  }
  class CancellationTokenSource {
    private _listeners: Array<() => void> = [];
    token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => { dispose: () => void } };
    constructor() {
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (cb: () => void) => {
          this._listeners.push(cb);
          return { dispose: () => {
            const i = this._listeners.indexOf(cb);
            if (i >= 0) this._listeners.splice(i, 1);
          } };
        },
      };
    }
    cancel(): void {
      this.token.isCancellationRequested = true;
      for (const cb of this._listeners.splice(0)) cb();
    }
    dispose(): void {
      this._listeners.length = 0;
    }
  }
  return { InlineCompletionItem, CancellationTokenSource };
});

import * as vscode from "vscode";
import { AiSqlCompletionProvider } from "../aiSqlCompletionProvider";
import type { SqlAutocompleteService } from "../../ai/sqlAutocomplete";
import type { AiConfig } from "../../ai/settings";

// ---- fixtures -------------------------------------------------------------

function makeConfig(): AiConfig {
  return {
    baseUrl: "https://provider.test/v1",
    method: "chat/completions",
    timeoutMs: 60_000,
    maxSteps: 12,
    engine: "builtin",
    apiKey: "sk-secret-NEVER-LEAK",
    models: {
      work: { modelId: "work", vision: true },
      smart: { modelId: "smart", vision: false },
      autocomplete: { modelId: "fast-sql", vision: false },
    },
  };
}

function makeDoc(text: string): vscode.TextDocument {
  return {
    languageId: "sql",
    uri: { toString: () => "file:///tmp/test.sql" },
    getText: () => text,
    lineAt: (_line: number) => ({ text }),
    version: 1,
  } as unknown as vscode.TextDocument;
}

function posAtEnd(text: string): vscode.Position {
  return { line: 0, character: text.length } as unknown as vscode.Position;
}

const liveCtx: vscode.InlineCompletionContext = {
  triggerKind: 1,
  selectedCompletionInfo: undefined,
} as unknown as vscode.InlineCompletionContext;

const baseDeps = () => ({
  loadConfig: async () => makeConfig(),
  buildRequest: (doc: vscode.TextDocument, position: vscode.Position) => ({
    callerScope: doc.uri.toString(),
    cursorOffset: position.character,
    documentText: doc.getText(),
    schemaFingerprint: "fp",
  }),
});

// ---- tests ----------------------------------------------------------------

describe("AiSqlCompletionProvider — happy path", () => {
  it("returns one InlineCompletionItem with the resolved suffix", async () => {
    const suggest = vi.fn(async () => "ers");
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const provider = new AiSqlCompletionProvider({
      service: svc,
      ...baseDeps(),
    });
    const text = "SELECT * FROM us";
    const items = await provider.provideInlineCompletionItems(
      makeDoc(text),
      posAtEnd(text),
      liveCtx,
      new vscode.CancellationTokenSource().token,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.insertText).toBe("ers");
    expect(suggest).toHaveBeenCalledTimes(1);
  });
});

describe("AiSqlCompletionProvider — cancellation", () => {
  it("returns [] when the token is already cancelled at request time", async () => {
    const suggest = vi.fn();
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    const provider = new AiSqlCompletionProvider({
      service: svc,
      ...baseDeps(),
    });
    const items = await provider.provideInlineCompletionItems(
      makeDoc("SELECT 1"),
      posAtEnd("SELECT 1"),
      liveCtx,
      source.token,
    );
    expect(items).toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  });

  it("returns [] when the in-flight token is cancelled before suffix lands", async () => {
    const suggest = vi.fn(async () => {
      // Yield so the test's setTimeout can fire the cancel.
      await new Promise((r) => setTimeout(r, 5));
      return "ers";
    });
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const source = new vscode.CancellationTokenSource();
    const provider = new AiSqlCompletionProvider({
      service: svc,
      ...baseDeps(),
    });
    setTimeout(() => source.cancel(), 1);
    const items = await provider.provideInlineCompletionItems(
      makeDoc("SELECT 1"),
      posAtEnd("SELECT 1"),
      liveCtx,
      source.token,
    );
    expect(items).toEqual([]);
  });
});

describe("AiSqlCompletionProvider — unavailable", () => {
  it("returns [] when loadConfig resolves null", async () => {
    const suggest = vi.fn();
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const provider = new AiSqlCompletionProvider({
      service: svc,
      loadConfig: async () => null,
      buildRequest: baseDeps().buildRequest,
    });
    const items = await provider.provideInlineCompletionItems(
      makeDoc("SELECT 1"),
      posAtEnd("SELECT 1"),
      liveCtx,
      new vscode.CancellationTokenSource().token,
    );
    expect(items).toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  });

  it("returns [] when service.suggest resolves null", async () => {
    const suggest = vi.fn(async () => null);
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const provider = new AiSqlCompletionProvider({
      service: svc,
      ...baseDeps(),
    });
    const items = await provider.provideInlineCompletionItems(
      makeDoc("SELECT 1"),
      posAtEnd("SELECT 1"),
      liveCtx,
      new vscode.CancellationTokenSource().token,
    );
    expect(items).toEqual([]);
  });

  it("does not throw and returns [] when service.suggest rejects", async () => {
    const suggest = vi.fn(async () => {
      throw new Error("boom");
    });
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const provider = new AiSqlCompletionProvider({
      service: svc,
      ...baseDeps(),
    });
    const items = await provider.provideInlineCompletionItems(
      makeDoc("SELECT 1"),
      posAtEnd("SELECT 1"),
      liveCtx,
      new vscode.CancellationTokenSource().token,
    );
    expect(items).toEqual([]);
  });
});

describe("AiSqlCompletionProvider — stale guard", () => {
  it("returns [] when the document version no longer matches the snapshot", async () => {
    const suggest = vi.fn(async () => {
      // Yield so the test can bump the version before the suffix lands.
      await new Promise((r) => setTimeout(r, 5));
      return "ers";
    });
    const svc = { suggest, cancel: vi.fn() } as unknown as SqlAutocompleteService;
    const provider = new AiSqlCompletionProvider({
      service: svc,
      ...baseDeps(),
    });
    const text = "SELECT * FROM us";
    const doc = makeDoc(text);
    const pos = posAtEnd(text);
    setTimeout(() => {
      (doc as unknown as { version: number }).version = 2;
    }, 1);
    const items = await provider.provideInlineCompletionItems(
      doc,
      pos,
      liveCtx,
      new vscode.CancellationTokenSource().token,
    );
    expect(items).toEqual([]);
  });
});
