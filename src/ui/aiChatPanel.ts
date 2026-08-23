// src/ui/aiChatPanel.ts — TASK-003
// AiChatPanel — single-instance webview panel that hosts a multi-turn chat
// against the AI agent. The webview only sends: ready, send, stop, clear.
// The host builds the message list (system prompt + history + user msg),
// wires the tool registry (createDbTools + register(createSqlTool)), and
// runs runAgent with a ChatAbortToken gating final-assistant posting.
//
// Stop semantics: per spec F4, we do NOT pass AbortController to runAgent
// because the agent loop doesn't accept one. Instead the host holds a
// `ChatAbortToken { aborted }` per turn:
//   - stop message → token.aborted = true
//   - runAgent onStep: if token.aborted → drop the step
//   - runAgent settle: if token.aborted → skip assistant final; always
//     post {type:"done"} to close the turn.
//   - runAgent rejection due to abort: swallowed (already covered by the
//     explicit error path / the done post).
//
// Mirror pattern (aiSettingsForm / newTableForm): CSP strict, reveal-on-
// reshow, dispose parity, no apiKey ever sent to webview.
import * as vscode from "vscode";
import {
  runAgent,
  type AgentDeps,
  type AgentStep,
  type AgentCallbacks,
  type ToolRegistry,
} from "../ai/agent";
import type { ChatMessage } from "../ai/provider";
import type { AdapterFactory } from "../ai/tools/types";
import { createDbTools } from "../ai/tools/registry";
import { createSqlTool } from "../ai/tools/sqlTool";
import { formatSchemaContext } from "../ai/tools/schemaContext";
import type { TableInfo, TableDetail } from "../adapters/types";
import type {
  AiChatPanelHostMessage,
  AiChatPanelWebviewMessage,
} from "./aiChatPanelMessages";

const PANEL_ID = "vsdb.aiChatPanel";

const SCHEMA_CONTEXT_BUDGET = 8000; // chars
const SCHEMA_CONTEXT_TABLE_LIMIT = 30;

export interface ChatAbortToken {
  aborted: boolean;
}

export interface AiChatPanelOptions {
  extensionUri: vscode.Uri;
  /**
   * AI provider/agent deps — loadConfig + complete. Injected so host tests
   * can swap a fake without depending on the full vscode-bound stack.
   */
  deps: AgentDeps;
  /**
   * Async factory for the active DB adapter. May resolve to null (no active
   * connection). Spec: factory null → context is empty, no throw.
   */
  adapterFactory: AdapterFactory;
}

/** Per-turn input assembly — system prompt + history + user msg. */
async function buildMessages(
  factory: AdapterFactory,
  history: ChatMessage[],
  userMsg: ChatMessage,
): Promise<ChatMessage[]> {
  let context = "";
  try {
    const adapter = await factory();
    if (adapter) {
      const tables = await adapter.listTables();
      const limited: TableInfo[] = tables.slice(0, SCHEMA_CONTEXT_TABLE_LIMIT);
      const details: TableDetail[] = [];
      for (const t of limited) {
        try {
          details.push(await adapter.listTableDetail(t.schema, t.name));
        } catch {
          // Skip a single failed table detail; others still render.
          details.push({ columns: [], constraints: [] });
        }
      }
      context = formatSchemaContext(limited, details, SCHEMA_CONTEXT_BUDGET);
    }
  } catch {
    // Introspection failure (or factory rejection) → empty context, no crash.
    context = "";
  }
  const systemPrompt = context.length === 0
    ? "You are VSDB's AI assistant. Help the user explore and query their database."
    : `You are VSDB's AI assistant. Help the user explore and query their database.\n\nDatabase schema:\n${context}`;
  return [{ role: "system", content: systemPrompt }, ...history, userMsg];
}

export class AiChatPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** In-turn abort flag — flipped by `stop`; checked onStep + on settle. */
  private token: ChatAbortToken | null = null;
  /** History snapshot for replay; never holds apiKey (provider scrubbed). */
  private history: ChatMessage[] = [];

  constructor(private readonly options: AiChatPanelOptions) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      "VSDB AI Chat",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(this.options.extensionUri, "dist"),
        ],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        (msg: AiChatPanelWebviewMessage) => this.handleMessage(msg),
      ),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.panel = null;
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
      }),
    );
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ---- Private -------------------------------------------------------------

  private async handleMessage(msg: AiChatPanelWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.handleReady();
        return;
      case "send":
        await this.handleSend(msg.text);
        return;
      case "stop":
        this.handleStop();
        return;
      case "clear":
        this.handleClear();
        return;
    }
  }

  private handleReady(): void {
    this.post({ type: "init", hasHistory: this.history.length > 0 });
  }

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // Per-turn registry — list_tables + describe_table + run_sql.
    const registry = createDbTools(this.options.adapterFactory);
    registry.register(createSqlTool(this.options.adapterFactory));

    // Fresh token for this turn.
    this.token = { aborted: false };

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const messages = await buildMessages(
      this.options.adapterFactory,
      this.history,
      userMsg,
    );

    const callbacks: AgentCallbacks = {
      onStep: (step) => this.onStep(step),
    };

    await this.runTurn(messages, registry, callbacks, userMsg);
  }

  private async runTurn(
    messages: ChatMessage[],
    registry: ToolRegistry,
    callbacks: AgentCallbacks,
    userMsg: ChatMessage,
  ): Promise<void> {
    const token = this.token;
    try {
      const result = await runAgent(
        { messages, tools: registry },
        this.options.deps,
        callbacks,
      );
      if (!token?.aborted) {
        this.post({
          type: "assistant",
          text: result.finalText,
          markdown: true,
        });
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: result.finalText,
        };
        this.history = [...this.history, userMsg, assistantMsg];
      }
      // If aborted, history is intentionally NOT extended — the partial
      // turn is discarded so a fresh user prompt can be issued.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message });
    } finally {
      // Always close the turn; webview re-enables Send on done.
      this.post({ type: "done" });
    }
  }

  private onStep(step: AgentStep): void {
    if (this.token?.aborted) return;
    const assistantMsg = step.messages.find((m) => m.role === "assistant");
    const toolCall = assistantMsg?.toolCalls?.[0];
    if (toolCall) {
      this.post({ type: "step", label: toolCall.name });
    }
  }

  private handleStop(): void {
    if (this.token) this.token.aborted = true;
  }

  private handleClear(): void {
    this.history = [];
    this.post({ type: "init", hasHistory: false });
  }

  private post(msg: AiChatPanelHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "aiChatPanel.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview.css"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>VSDB AI Chat</title>
</head>
<body class="vsdb-form-body">
  <div id="vsdb-root" class="vsdb-chat"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
