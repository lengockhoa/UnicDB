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
import {
  detectOmp,
  OMP_INSTALL_HINT,
  OMP_UPDATE_HINT,
  type OmpDetection,
} from "../ai/omp/detect";
import { OmpProcess } from "../ai/omp/process";
import type { OmpRpcClient } from "../ai/omp/rpc";
import {
  hostToolDefsFromRegistry,
  createHostToolExecutor,
} from "../ai/omp/hostTools";
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

/**
 * Optional omp engine dependencies. When provided, the panel will detect omp,
 * spawn an RPC session, and stream through it. When absent (or detection fails),
 * the panel falls back to the built-in agent loop exactly as cycle K specified.
 */
export interface OmpPanelDeps {
  detect: () => Promise<OmpDetection>;
  spawn: (cwd: string) => Promise<{
    rpc: OmpRpcClient;
    version: string;
    onExit(cb: (code: number | null) => void): void;
    kill(): void;
  }>;
  toolDefs: () => Record<string, unknown>[];
  toolExecutor: (name: string, args: unknown) => Promise<string>;
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
  /** Optional omp engine deps — see OmpPanelDeps. */
  omp?: OmpPanelDeps;
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

/** Resolved engine state, computed lazily on first show. */
type EngineKind = "omp" | "builtin";

interface OmpSession {
  rpc: OmpRpcClient;
  version: string;
  /** Accumulated assistant text for the current turn. */
  buffer: string;
  kill(): void;
}

export class AiChatPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** In-turn abort flag — flipped by `stop`; checked onStep + on settle. */
  private token: ChatAbortToken | null = null;
  /** History snapshot for replay; never holds apiKey (provider scrubbed). */
  private history: ChatMessage[] = [];
  /** Cached engine resolution — set on first show; reused on every turn. */
  private engine: EngineKind | null = null;
  /** Engine hint posted once on first ready. */
  private engineHint: string | null = null;
  /** Cached omp session — created on first omp-mode send. */
  private omp: OmpSession | null = null;
  /** Per-turn set_host_tools sent flag — sent exactly once per session lifetime. */
  private hostToolsSent = false;
  /** Set once per omp turn when done was posted (by exit handler or settle). */
  private turnDonePosted = false;
  /** Resolvers for in-flight omp turns — fired by agent_end or onExit. */
  private ompTurnResolvers: Array<() => void> = [];

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
        retainContextWhenHidden: true,
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
    this.killOmpSession();
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ---- Private -------------------------------------------------------------

  private async handleMessage(msg: AiChatPanelWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.handleReady();
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

  private async handleReady(): Promise<void> {
    if (this.engine === null) {
      await this.resolveEngine();
      const resolvedEngine: EngineKind = this.engine ?? "builtin";
      const hint = this.engineHint;
      this.post({
        type: "engine",
        name: resolvedEngine,
        hint: hint ?? undefined,
      });
    }
    this.post({ type: "init", hasHistory: this.history.length > 0 });
  }
  /**
   * Resolve engine on first ready. Cached in `this.engine` for the panel's
   * lifetime — re-detection only happens if user explicitly resets. Detection
   * never throws: a missing detect fn or a thrown detector → builtin.
   */
  private async resolveEngine(): Promise<void> {
    if (this.options.omp === undefined) {
      this.engine = "builtin";
      return;
    }
    let detection: OmpDetection;
    try {
      detection = await this.options.omp.detect();
    } catch {
      detection = { available: false, ok: false, reason: "spawn-failed" };
    }
    if (detection.ok) {
      this.engine = "omp";
      this.engineHint = null;
      return;
    }
    this.engine = "builtin";
    this.engineHint = engineHintFor(detection.reason);
  }

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // Fresh token for this turn.
    this.token = { aborted: false };
    this.turnDonePosted = false;

    const userMsg: ChatMessage = { role: "user", content: trimmed };

    if (this.engine === "omp") {
      await this.runOmpTurn(trimmed, userMsg);
      return;
    }

    // Per-turn registry — list_tables + describe_table + run_sql.
    const registry = createDbTools(this.options.adapterFactory);
    registry.register(createSqlTool(this.options.adapterFactory));

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

  private async runOmpTurn(
    text: string,
    userMsg: ChatMessage,
  ): Promise<void> {
    const omp = this.options.omp;
    if (omp === undefined) {
      // Shouldn't happen — engine is "omp" only when deps present — but degrade.
      this.engine = "builtin";
      this.post({ type: "error", message: "omp engine unavailable; falling back" });
      this.post({ type: "done" });
      return;
    }

    let session: OmpSession;
    try {
      session = await this.ensureOmpSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `omp session failed: ${message}` });
      this.post({ type: "done" });
      this.engine = "builtin";
      return;
    }
    const token = this.token;
    let aborted = false;

    // Reset per-turn buffer so this turn's assistant text doesn't accumulate
    // over previous turn's text (which would leak thinking across turns).
    session.buffer = "";

    try {
      if (!this.hostToolsSent) {
        await session.rpc.request({ type: "set_host_tools", tools: omp.toolDefs() });
        this.hostToolsSent = true;
      }
      await session.rpc.request({ type: "prompt", message: text });
      // The turn ends on agent_end event (isTerminal !== false) — handled
      // by the event listener installed in ensureOmpSession. Nothing to
      // await here: the listener will post {assistant, done}.
      // We DO need to keep this method alive until the listener fires; the
      // listener resolves `turnDone` once terminal arrives.
      await new Promise<void>((resolve) => {
        this.ompTurnResolvers.push(() => {
          aborted = token?.aborted === true;
          resolve();
        });
      });

      // Even when aborted, post the partial assistant + done so the webview
      // re-enables Send. History is NOT extended in that case — the partial
      // turn is discarded.
      if (!this.turnDonePosted) {
        const finalText = session.buffer;
        this.post({ type: "assistant", text: finalText, markdown: true });
        if (!aborted) {
          this.history = [
            ...this.history,
            userMsg,
            { role: "assistant", content: finalText },
          ];
        }
      }
      if (!this.turnDonePosted) {
        this.post({ type: "done" });
        this.turnDonePosted = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message });
    } finally {
      if (!this.turnDonePosted) {
        this.post({ type: "done" });
        this.turnDonePosted = true;
      }
    }
  }

  private async ensureOmpSession(): Promise<OmpSession> {
    if (this.omp !== null) return this.omp;
    const omp = this.options.omp;
    if (omp === undefined) {
      throw new Error("omp deps not configured");
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const handle = await omp.spawn(cwd);
    const session: OmpSession = {
      rpc: handle.rpc,
      version: handle.version,
      buffer: "",
      kill: () => handle.kill(),
    };
    // Register exit listener — single source of truth for crash handling.
    handle.onExit((code) => {
      if (this.omp !== session) return;
      this.omp = null;
      this.hostToolsSent = false;
      this.engine = "builtin";
      // If a turn is in flight, settle it. Mark turnDonePosted BEFORE firing
      // resolvers so runOmpTurn's `if (!this.turnDonePosted)` guards don't
      // re-post a stale assistant bubble + a second `done` on top of the
      // error + done we just posted.
      this.turnDonePosted = true;
      const resolvers = this.ompTurnResolvers.splice(0);
      this.post({
        type: "error",
        message: `omp session ended (code ${code ?? "unknown"})`,
      });
      this.post({ type: "done" });
      // Spec: onExit also surfaces the engine fallback so the webview learns
      // omp mode ended; without this, the panel's engine state and the
      // webview's displayed banner drift apart.
      this.post({ type: "engine", name: "builtin" });
      for (const r of resolvers) r();
    });

    // Subscribe to all non-response events.
    handle.rpc.onEvent((ev) => this.handleOmpEvent(session, ev));

    // Wire host-tool call handler.
    const toolExecutor = omp.toolExecutor;
    handle.rpc.handleHostToolCall(async (call) => {
      return await toolExecutor(call.toolName, call.arguments);
    });

    this.omp = session;
    return session;
  }

  private handleOmpEvent(session: OmpSession, ev: Record<string, unknown>): void {
    const type = ev["type"];
    if (type === "message_update") {
      if (this.token?.aborted) return;
      const inner = ev["assistantMessageEvent"] as
        | { type?: string; delta?: string }
        | undefined;
      // ONLY `text_delta` is rendered. omp emits `thinking_delta` (chain-of-
      // thought) with the same shape; that MUST never appear in the assistant
      // stream — reasoning is internal model state, not user-facing text.
      if (inner?.type !== "text_delta") return;
      const delta = inner.delta;
      if (typeof delta === "string" && delta.length > 0) {
        session.buffer += delta;
        this.post({ type: "delta", text: delta });
      }
      return;
    }
    if (type === "agent_end") {
      // isTerminal === false → not a real turn end; just an interim checkpoint.
      if (ev["isTerminal"] === false) return;
      // Settle the in-flight turn.
      const resolvers = this.ompTurnResolvers.splice(0);
      // Final assistant + done are posted by runOmpTurn on settle; we only
      // unblock here.
      for (const r of resolvers) r();
      return;
    }
    // Other events (step, etc.) ignored — handled via host_tool_call for tools.
  }

  private handleStop(): void {
    if (this.token) this.token.aborted = true;
    if (this.engine === "omp" && this.omp !== null) {
      // Fire-and-forget abort — error during send is non-fatal.
      void this.omp.rpc.request({ type: "abort" }).catch(() => undefined);
    }
  }

  private killOmpSession(): void {
    if (this.omp !== null) {
      try {
        this.omp.kill();
      } catch {
        /* ignore */
      }
      this.omp = null;
      this.hostToolsSent = false;
    }
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

function engineHintFor(reason: string | undefined): string {
  if (reason === "version-too-old") {
    return `omp installed but version too old. Update with: \`${OMP_UPDATE_HINT}\`.`;
  }
  if (reason === "version-unknown") {
    return `omp version unknown. Update with: \`${OMP_UPDATE_HINT}\`.`;
  }
  if (reason === "spawn-failed") {
    return `omp found but failed to run. Update or reinstall: \`${OMP_UPDATE_HINT}\`.`;
  }
  // not-installed (default)
  return `omp is not installed. Install with: \`${OMP_INSTALL_HINT}\`.`;
}

