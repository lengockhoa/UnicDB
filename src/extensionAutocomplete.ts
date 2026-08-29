// src/extensionAutocomplete.ts — Cycle AIC TASK-AIC-005.

import * as vscode from "vscode";
import type { AiConfig } from "./ai/settings";
import type { SqlAutocompleteService } from "./ai/sqlAutocomplete";
import { AiSqlCompletionProvider } from "./ui/aiSqlCompletionProvider";

/** Surface needed to wire the AIC SQL autocomplete into VS Code + Console. */
export interface AutocompleteDeps {
  /** The AIC-002 service — single source of truth for debounce/cancel/cache. */
  service: SqlAutocompleteService;
  /** Resolves the AI config (null = unconfigured). */
  loadConfig: () => Promise<AiConfig | null>;
}

export interface AutocompleteRegistration {
  dispose: () => void;
  /**
   * The Console panel's onAutocomplete adapter. Routes through the AIC-002
   * service, scoped per Console tab so editor + console caches partition
   * cleanly (different callerScope).
   */
  consoleAutocomplete: (req: {
    tabId: string;
    requestId: string;
    cursorOffset: number;
    documentText: string;
    schemaFingerprint: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
}

export function registerSqlAutocomplete(deps: AutocompleteDeps): AutocompleteRegistration {
  const disposables: vscode.Disposable[] = [];

  if (typeof vscode.languages.registerInlineCompletionItemProvider === "function") {
    const provider = new AiSqlCompletionProvider({
      service: deps.service,
      loadConfig: deps.loadConfig,
    });
    const registration = vscode.languages.registerInlineCompletionItemProvider(
      { scheme: "file", language: "sql" },
      provider,
    );
    disposables.push(registration);
  }

  return {
    dispose: () => {
      for (const d of disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      disposables.length = 0;
    },
    consoleAutocomplete: async (req) => {
      const cfg = await deps.loadConfig();
      if (!cfg) return null;
      return deps.service.suggest(cfg, {
        callerScope: req.tabId,
        cursorOffset: req.cursorOffset,
        documentText: req.documentText,
        schemaFingerprint: req.schemaFingerprint,
        signal: req.signal,
      });
    },
  };
}
