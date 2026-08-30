// src/ui/aiSqlCompletionProvider.ts
// Cycle AIC TASK-AIC-003 — native VS Code InlineCompletionItemProvider that
// delegates to the AIC-002 SqlAutocompleteService and returns ghost-text
// without touching the existing deterministic SqlCompletionProvider.
//
// Contract (PLAN §5; TASK-AIC-003 §Goal / §Acceptance):
//   - Implements vscode.InlineCompletionItemProvider.
//   - No vscode calls except the constructor parameter typing. The provider
//     is registered by AIC-005, not here.
//   - One service per instance, no second debounce/cache/controller.
//   - CancellationToken → AbortSignal forwarded; the service owns the rest.
//   - Document/connection change → late result is dropped (stale guard).
//   - All silent failure modes return [] and never throw or notify.

import * as vscode from "vscode";
import type { AiConfig } from "../ai/settings";
import type {
  SqlAutocompleteRequest,
  SqlAutocompleteService,
} from "../ai/sqlAutocomplete";

/** Build the AIC-002 service request from a (document, position) pair. */
export type BuildRequestFn = (
  doc: vscode.TextDocument,
  position: vscode.Position,
) => SqlAutocompleteRequest;

/** Optional stale-guard override. Default: compare current document
 *  version + position to the snapshot captured at request time. */
export type IsStaleFn = (args: {
  doc: vscode.TextDocument;
  pos: vscode.Position;
  snapshot: { version: number; cursorOffset: number };
}) => boolean;

export interface AiSqlCompletionProviderDeps {
  service: SqlAutocompleteService;
  /** Resolves the current AI config. Null means unconfigured. */
  loadConfig: () => Promise<AiConfig | null>;
  /** Build the AIC-002 request. Default: callerScope = doc.uri, cursor =
   *  full-document offset (doc.offsetAt), documentText = full text,
   *  fingerprint = "v1". */
  buildRequest?: BuildRequestFn;
  /** Optional stale-guard override. Default uses version+cursor comparison. */
  isStale?: IsStaleFn;
}

const defaultBuildRequest: BuildRequestFn = (doc, position) => ({
  callerScope: doc.uri.toString(),
  cursorOffset: doc.offsetAt(position),
  documentText: doc.getText(),
  schemaFingerprint: "v1",
});

const defaultIsStale: IsStaleFn = ({ doc, pos, snapshot }) =>
  doc.version !== snapshot.version ||
  doc.offsetAt(pos) !== snapshot.cursorOffset;

export class AiSqlCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly service: SqlAutocompleteService;
  private readonly loadConfig: () => Promise<AiConfig | null>;
  private readonly buildRequest: BuildRequestFn;
  private readonly isStale: IsStaleFn;

  constructor(deps: AiSqlCompletionProviderDeps) {
    this.service = deps.service;
    this.loadConfig = deps.loadConfig;
    this.buildRequest = deps.buildRequest ?? defaultBuildRequest;
    this.isStale = deps.isStale ?? defaultIsStale;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const cfg = await this.loadConfig();
    if (!cfg) return [];
    if (!cfg.models.autocomplete.modelId.trim()) return [];
    if (token.isCancellationRequested) return [];

    const req = this.buildRequest(document, position);
    const controller = new AbortController();
    const snapshot = { version: document.version, cursorOffset: document.offsetAt(position) };

    const onCancel = token.onCancellationRequested(() => controller.abort());
    try {
      const suffix = await this.service.suggest(cfg, { ...req, signal: controller.signal });
      onCancel.dispose();
      if (!suffix) return [];
      if (this.isStale({ doc: document, pos: position, snapshot })) return [];
      if (controller.signal.aborted) return [];
      if (token.isCancellationRequested) return [];
      return [new vscode.InlineCompletionItem(suffix)];
    } catch {
      onCancel.dispose();
      return [];
    } finally {
      controller.abort();
    }
  }
}
