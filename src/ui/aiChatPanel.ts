// src/ui/aiChatPanel.ts — TASK-004 ACP permission coordinator + panel
// session wiring.
//
// AiChatPanel — single-instance webview panel that hosts a multi-turn chat
// against the AI agent. The webview only sends: ready, send, stop, clear,
// permission_response. The host builds the message list (system prompt +
// history + user msg), wires the tool registry (createDbTools +
// register(createSqlTool)), and runs runAgent with a ChatAbortToken gating
// final-assistant posting.
//
// Engine modes:
//   - "builtin" — runAgent via direct provider. Used when no acp deps or
//     when the ACP session has terminated (fallback per spec).
//   - "acp"     — spawn omp acp; stream session/update.agent_message_chunk
//                 as assistant deltas; surface server-side
//                 session/request_permission as opaque-ID host requests and
//                 reply with one ACP result per server request.
//
// Stop / dispose / replacement / process exit / timeout semantics:
//   - Incoming `stop` flips ChatAbortToken and cancels every pending
//     permission request with a one-shot cancelled ACP result.
//   - Panel dispose, replacement send, process exit, and the per-request
//     timeout all do the same: every outstanding opaque ID is settled
//     exactly once with `outcome:"cancelled"`.
//
// Permission security contract (TASK-003 + TASK-004):
//   - requestId is host-generated opaque; never derived from server data.
//   - To allow, the webview must echo the SAME requestId AND a listed
//     optionId. Anything else (unknown requestId, unlisted optionId,
//     duplicate response, late response) is treated as deny.
//   - Tool/detail/option text is rendered verbatim as plain text — no
//     innerHTML, no markdown.
//   - apiKey never crosses either direction of the wire.
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
import type { AcpProcessHandle } from "../ai/omp/acpProcess";
import {
  type AcpServerRequest,
  type AcpNotification,
} from "../ai/omp/acp";
import type {
  AiChatPanelHostMessage,
  AiChatPanelWebviewMessage,
} from "./aiChatPanelMessages";

const PANEL_ID = "vsdb.aiChatPanel";

const SCHEMA_CONTEXT_BUDGET = 8000; // chars
const SCHEMA_CONTEXT_TABLE_LIMIT = 30;
const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

/** Optional second constructor arg used by tests to control permission timeout. */
export interface AiChatPanelTuning {
  /** Per-permission timeout (ms). Defaults to 60_000. */
  permissionTimeoutMs?: number;
}

export interface ChatAbortToken {
  aborted: boolean;
}

/**
 * ACP engine dependencies. When provided, the panel spawns `omp acp` via
 * `start()`, streams assistant message chunks as deltas, and surfaces server
 * permission requests as host `permission_request` messages keyed by opaque
 * IDs. When absent (or `start()` rejects), the panel falls back to the
 * built-in agent loop.
 */
export interface AcpPanelDeps {
  start(ompPath: string, cwd: string): Promise<AcpProcessHandle>;
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
  /** Optional ACP engine deps. When absent, panel runs builtin only. */
  acp?: AcpPanelDeps;
  /** Optional tuning for tests (permission timeout, etc). */
  tuning?: AiChatPanelTuning;
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

/** Engine state, computed lazily on first show. */
type EngineKind = "omp" | "builtin";

interface PendingPermission {
  serverId: unknown;
  requestId: string;
  optionIds: Set<string>;
  /** Settled exactly once. Prevents duplicate / late ACP writes. */
  settled: boolean;
  timeoutHandle: NodeJS.Timeout;
}

interface AcpSession {
  handle: AcpProcessHandle;
  /** Accumulated assistant text for the current turn. */
  buffer: string;
  /** Active permission requests keyed by host requestId. */
  pending: Map<string, PendingPermission>;
  /** Monotonic counter for host-generated opaque requestIds. */
  bumpRequestSeq(): number;
  /** Disposal teardown — cancels timers + drops references. */
  dispose(): void;
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
  /** Cached ACP session — created on first acp-mode send. */
  private acpSession: AcpSession | null = null;
  /** Set once per ACP turn when done was posted. */
  private turnDonePosted = false;
  /** Resolvers for in-flight ACP turns — fired by settle path. */
  private acpTurnResolvers: Array<() => void> = [];
  private permissionTimeoutMs: number;

  constructor(
    private readonly options: AiChatPanelOptions,
    tuning: AiChatPanelTuning = {},
  ) {
    this.permissionTimeoutMs =
      tuning.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

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
    // Cancel every pending permission request with one cancelled ACP
    // result per server request before tearing the session down.
    this.cancelAllPending();
    this.disposeAcpSession();
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
      case "permission_response":
        this.handlePermissionResponse(msg.requestId, msg.optionId);
        return;
    }
  }

  private async handleReady(): Promise<void> {
    if (this.engine === null) {
      // Default to builtin if no acp deps — keeps the regression path.
      const wireEngine: "omp" | "builtin" = this.options.acp === undefined ? "builtin" : "omp";
      this.engine = this.options.acp === undefined ? "builtin" : "omp";
      this.post({ type: "engine", name: wireEngine });
    }
    this.post({ type: "init", hasHistory: this.history.length > 0 });
  }

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // Fresh token for this turn. Also: a replacement send cancels any
    // outstanding permission requests from the previous turn before we
    // start the new one. Default-deny is mandatory.
    this.cancelAllPending();
    this.token = { aborted: false };
    this.turnDonePosted = false;

    const userMsg: ChatMessage = { role: "user", content: trimmed };

    if (this.engine === "builtin") {
      await this.runBuiltinTurn(userMsg);
      return;
    }

    await this.runAcpTurn(trimmed, userMsg);
  }

  private async runBuiltinTurn(userMsg: ChatMessage): Promise<void> {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message });
    } finally {
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

  private async runAcpTurn(
    text: string,
    userMsg: ChatMessage,
  ): Promise<void> {
    const acp = this.options.acp;
    if (acp === undefined) {
      // Shouldn't happen — engine is "acp" only when deps present — but degrade.
      this.engine = "builtin";
      this.post({ type: "error", message: "ACP engine unavailable; falling back" });
      this.post({ type: "done" });
      return;
    }

    let session: AcpSession;
    try {
      session = await this.ensureAcpSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `ACP session failed: ${message}` });
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
      await session.handle.acp.request("session/prompt", {
        sessionId: session.handle.sessionId,
        prompt: [{ type: "text", text }],
      });
      await new Promise<void>((resolve) => {
        this.acpTurnResolvers.push(() => {
          aborted = token?.aborted === true;
          resolve();
        });
      });

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

  private async ensureAcpSession(): Promise<AcpSession> {
    if (this.acpSession !== null) return this.acpSession;
    const acp = this.options.acp;
    if (acp === undefined) {
      throw new Error("acp deps not configured");
    }
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const handle = await acp.start("omp", cwd);
    const pending = new Map<string, PendingPermission>();
    let nextRequestSeq = 0;
    const session: AcpSession = {
      handle,
      buffer: "",
      pending,
      bumpRequestSeq: () => ++nextRequestSeq,
      dispose: () => {
        // Cancel timers + drop references; do NOT cancel the server requests
        // here — that's cancelAllPending()'s job. This is the "tear down
        // local bookkeeping" hook.
        for (const p of pending.values()) {
          clearTimeout(p.timeoutHandle);
        }
        pending.clear();
      },
    };
    // Wire notification handler — session/update streams assistant text.
    handle.acp.onNotification((n: AcpNotification) =>
      this.handleAcpNotification(session, n),
    );
    // Wire server request handler — every session/request_permission is
    // mirrored to the webview as a host permission_request with an opaque
    // ID; responses are correlated by that opaque ID.
    handle.acp.onServerRequest((call: AcpServerRequest) =>
      this.handleAcpServerRequest(session, call),
    );
    // Process-exit signal: AcpClient exposes an `onClose(cb)` hook that fires
    // when the underlying transport closes / the client is disposed. On that
    // signal we cancel every pending request with a cancelled result.
    const acpClient = handle.acp as unknown as {
      onClose?: (cb: () => void) => void;
    };
    if (typeof acpClient.onClose === "function") {
      acpClient.onClose.call(handle.acp, () => {
        if (this.acpSession !== session) return;
        this.cancelAllPending();
      });
    }
    this.acpSession = session;
    return session;
  }

  private handleAcpNotification(
    session: AcpSession,
    n: AcpNotification,
  ): void {
    if (n.method !== "session/update") return;
    const params = n.params;
    if (params === null || typeof params !== "object") return;
    const update = (params as { update?: unknown }).update;
    if (update === null || typeof update !== "object") return;
    const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
    if (sessionUpdate === "agent_message_chunk") {
      if (this.token?.aborted) return;
      const delta = (update as { delta?: unknown }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        session.buffer += delta;
        this.post({ type: "delta", text: delta });
      }
      return;
    }
    // agent_thought_chunk + every other update kind: deliberately ignored
    // (TASK-004 §3: agent_thought_chunk must never render or surface).
    if (sessionUpdate === "agent_thought_chunk") return;
    if (sessionUpdate === "agent_end" || sessionUpdate === "turn_complete") {
      // Terminal marker — settle in-flight turn.
      const resolvers = this.acpTurnResolvers.splice(0);
      for (const r of resolvers) r();
      return;
    }
    // Other update kinds: ignore.
  }

  private handleAcpServerRequest(
    session: AcpSession,
    call: AcpServerRequest,
  ): void {
    if (call.method !== "session/request_permission") {
      // Unknown server request — reply with a JSON-RPC method-not-found so
      // the server can move on without waiting on us.
      call.respondError(-32601, `unsupported server request: ${call.method}`);
      return;
    }
    const params = call.params;
    if (params === null || typeof params !== "object") {
      call.respondError(-32602, "session/request_permission params required");
      return;
    }
    const p = params as {
      sessionId?: unknown;
      toolCall?: { id?: unknown; name?: unknown; detail?: unknown };
      options?: Array<{ optionId?: unknown; label?: unknown }>;
    };
    const toolCall = p.toolCall;
    const options = Array.isArray(p.options) ? p.options : [];
    const toolName = typeof toolCall?.name === "string" ? toolCall.name : "";
    const toolId = typeof toolCall?.id === "string" ? toolCall.id : "";
    const toolDetail =
      typeof toolCall?.detail === "string" ? toolCall.detail : "";
    const optionEntries: Array<{ optionId: string; label: string }> = [];
    const optionIdSet = new Set<string>();
    for (const opt of options) {
      const id = typeof opt.optionId === "string" ? opt.optionId : "";
      const label = typeof opt.label === "string" ? opt.label : "";
      if (id.length === 0) continue;
      optionEntries.push({ optionId: id, label });
      optionIdSet.add(id);
    }

    const seq = session.bumpRequestSeq();
    const requestId = `req-${Date.now().toString(36)}-${seq.toString(36)}`;
    const pending: PendingPermission = {
      serverId: call.id,
      requestId,
      optionIds: optionIdSet,
      settled: false,
      timeoutHandle: setTimeout(() => {
        // Default-deny on timeout — one cancelled ACP result.
        this.cancelPending(requestId);
      }, this.permissionTimeoutMs),
    };
    session.pending.set(requestId, pending);

    this.post({
      type: "permission_request",
      requestId,
      tool: { id: toolId, name: toolName, detail: toolDetail },
      options: optionEntries,
    });
  }

  /**
   * Apply a single webview permission response. Only one ACP result is
   * written per pending entry — duplicate / late / unknown / unlisted-option
   * responses are ignored.
   */
  private handlePermissionResponse(
    requestId: string,
    optionId: string | undefined,
  ): void {
    const session = this.acpSession;
    if (session === null) return;
    const pending = session.pending.get(requestId);
    if (pending === undefined || pending.settled) return;
    // Settle exactly once. We mark settled BEFORE writing to be safe in
    // case the write triggers a re-entrant path.
    pending.settled = true;
    clearTimeout(pending.timeoutHandle);
    const serverId = pending.serverId;
    session.pending.delete(requestId);

    // Allow requires a listed optionId; anything else (no optionId, unknown
    // optionId) is treated as deny — both paths write exactly one result.
    const isAllow =
      typeof optionId === "string" && pending.optionIds.has(optionId);
    if (isAllow) {
      session.handle.acp.respond(serverId, {
        outcome: { outcome: "selected", optionId: optionId as string },
      });
      return;
    }
    session.handle.acp.respond(serverId, {
      outcome: { outcome: "cancelled" },
    });
  }

  /**
   * Cancel every pending permission request with a one-shot cancelled ACP
   * result. Used on stop, dispose, replacement, and process exit. Each
   * pending entry writes at most one result (idempotent).
   */
  private cancelAllPending(): void {
    const session = this.acpSession;
    if (session === null) return;
    for (const requestId of Array.from(session.pending.keys())) {
      this.cancelPending(requestId);
    }
  }

  private cancelPending(requestId: string): void {
    const session = this.acpSession;
    if (session === null) return;
    const pending = session.pending.get(requestId);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timeoutHandle);
    const serverId = pending.serverId;
    session.pending.delete(requestId);
    try {
      session.handle.acp.respond(serverId, {
        outcome: { outcome: "cancelled" },
      });
    } catch {
      // Process may have exited; the cancelled result is best-effort.
    }
  }

  private handleStop(): void {
    if (this.token) this.token.aborted = true;
    if (this.engine === "omp" && this.acpSession !== null) {
      this.cancelAllPending();
    }
  }

  private disposeAcpSession(): void {
    if (this.acpSession !== null) {
      try {
        this.acpSession.dispose();
      } catch {
        /* ignore */
      }
      try {
        this.acpSession.handle.dispose();
      } catch {
        /* ignore */
      }
      this.acpSession = null;
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
