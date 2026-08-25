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
import { createExportStructureTool } from "../ai/tools/schemaTools";
import type { AcpProcessHandle } from "../ai/omp/acpProcess";
import {
  buildDatabaseStructure,
  type ExportColumn,
} from "./exportStructure";
import type { TableInfo, ViewInfo, ColumnInfo, DbAdapter } from "../adapters/types";
import {
  type AcpServerRequest,
  type AcpNotification,
  type AcpReplayNotification,
  type AcpReplayBuffer,
  type AcpSessionListItem,
} from "../ai/omp/acp";
import {
  HISTORY_RENDER_CAP,
  type AiChatPanelHostMessage,
  type AiChatPanelWebviewMessage,
} from "./aiChatPanelMessages";
import { buildPermissionToolInfo } from "./permissionDetail";

const PANEL_ID = "vsdb.aiChatPanel";

const SCHEMA_CONTEXT_BUDGET = 12_000; // chars (tăng từ 8000)
const SCHEMA_CONTEXT_TABLE_LIMIT = 200; // objects (tăng từ 30)
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

/**
 * Per-turn input assembly — system prompt + history + user msg.
 *
 * Full-DB context injection (TASK-002): introspect every user schema
 * (tables + views), render DDL via `buildDatabaseStructure`, budget to a
 * 12_000-char ceiling cut at block boundaries, and footer-hint the model to
 * call `export_structure` for the rest. Factory null / introspection
 * failures → empty context, no crash (prompt stays minimal).
 *
 * `opts` is injectable so tests can verify the budget cut without paying
 * the cost of generating 12_000 chars of fixtures; production call sites
 * omit it and the production constants apply.
 */
/**
 * Schema-context cache entry (TASK-007 B9). `adapter` is the object
 * REFERENCE returned by the adapter factory, used as a minimal proxy for
 * "connection identity": `DbAdapter` has no explicit connection-id field,
 * but `ConnectionManager.getAdapter()` returns the SAME instance while the
 * active connection is unchanged and a NEW instance after a connection
 * switch — so reference equality is a valid cache key that self-invalidates
 * on connection change without any extra bookkeeping.
 */
export interface SchemaContextCacheEntry {
  adapter: DbAdapter;
  context: string;
}

export async function buildMessages(
  factory: AdapterFactory,
  history: ChatMessage[],
  userMsg: ChatMessage,
  opts?: {
    contextBudgetChars?: number;
    contextTableLimit?: number;
    /** Optional mutable cache cell — populated/read by reference identity
     * of the resolved adapter. Only `AiChatPanel` instance call sites pass
     * this; bare test calls omit it and always re-introspect. */
    cache?: { current: SchemaContextCacheEntry | null };
  },
): Promise<ChatMessage[]> {
  const budget = opts?.contextBudgetChars ?? SCHEMA_CONTEXT_BUDGET;
  const limit = opts?.contextTableLimit ?? SCHEMA_CONTEXT_TABLE_LIMIT;
  let context = "";
  try {
    const adapter = await factory();
    if (adapter) {
      const cache = opts?.cache;
      if (cache?.current !== undefined && cache?.current !== null && cache.current.adapter === adapter) {
        // Cache hit — same connection identity as the last built context.
        context = cache.current.context;
      } else {
        const schemas = await adapter.listSchemas(false);
        const collected: Array<
          | { kind: "table"; schema: string; name: string }
          | { kind: "view"; schema: string; name: string }
        > = [];

        for (const s of schemas) {
          let schemaTables: TableInfo[] = [];
          try {
            schemaTables = await adapter.listTables(s.name);
          } catch {
            // Per-schema failure: skip schema, keep going.
            continue;
          }
          for (const t of schemaTables) {
            collected.push({ kind: "table", schema: t.schema, name: t.name });
          }
          let schemaViews: ViewInfo[] = [];
          try {
            schemaViews = await adapter.listViews(s.name);
          } catch {
            continue;
          }
          for (const v of schemaViews) {
            collected.push({ kind: "view", schema: v.schema, name: v.name });
          }
        }

        const total = collected.length;
        const kept = collected.slice(0, limit);
        const capDropped = total - kept.length;

        const tables: Array<{ schema: string; name: string }> = [];
        const views: Array<{ schema: string; name: string }> = [];
        const columns: Record<string, ExportColumn[]> = {};

        for (const obj of kept) {
          const key = `${obj.schema}.${obj.name}`;
          // Per-object listColumns failure: retain it with an empty column
          // list so its DDL (table name / schema) still surfaces in context.
          // Dropping the object entirely would hide a real table from the
          // model when introspection is flaky; missing columns is recoverable
          // (the model can call export_structure) but a missing table is not.
          let mapped: ExportColumn[] = [];
          try {
            const cols = await adapter.listColumns(obj.name, obj.schema);
            mapped = cols.map((c) => ({
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable,
              isPrimaryKey: c.isPrimaryKey,
            }));
          } catch {
            // Keep the object; columns default to [].
          }
          columns[key] = mapped;
          if (obj.kind === "table") {
            tables.push({ schema: obj.schema, name: obj.name });
          } else {
            views.push({ schema: obj.schema, name: obj.name });
          }
        }

        let ddl = buildDatabaseStructure({
          schemas,
          tables,
          views,
          columns,
        });
        // Budget cut at block boundaries (blocks = text between blank lines).
        // Tables AND views share ONE pool in render order; keep leading blocks
        // until the next one would push us over budget. The first block is
        // always kept even when it alone exceeds budget (oversize single-
        // table rule from review #4) — context stays non-empty.
        if (ddl.length > budget) {
          const blocks = ddl.split(/\n\n+/);
          const keptBlocks: string[] = [];
          let acc = 0;
          for (let i = 0; i < blocks.length; i++) {
            const piece = blocks[i] ?? "";
            const sep = keptBlocks.length > 0 ? 2 : 0;
            const next = acc + sep + piece.length;
            if (next > budget) {
              if (i === 0) {
                // First block alone exceeds budget — keep it anyway.
                keptBlocks.push(piece);
                acc = piece.length;
              }
              break;
            }
            keptBlocks.push(piece);
            acc = next;
          }
          const omitted = blocks.length - keptBlocks.length + capDropped;
          ddl = keptBlocks.join("\n\n");
          if (omitted > 0) {
            const footer = `\n\n-- (+${omitted} more objects omitted — call export_structure for full context)`;
            if (ddl.length + footer.length <= budget) ddl += footer;
          }
        }
        context = ddl;
        if (cache) {
          cache.current = { adapter, context };
        }
      }
    }
  } catch {
    // Introspection failure (factory rejection, listSchemas throw, …) →
    // empty context, no crash.
    context = "";
  }
  const systemPrompt = context.length === 0
    ? "You are VSDB's AI assistant. Help the user explore and query their database."
    : `You are VSDB's AI assistant. Help the user explore and query their database.\n\nDatabase structure (DDL):\n${context}\n\nYou can call the export_structure tool for the complete structure when truncated.`;
  return [{ role: "system", content: systemPrompt }, ...history, userMsg];
}

/** Engine state, computed lazily on first show. */
type EngineKind = "omp" | "builtin";

interface PendingPermission {
  serverId: unknown;
  requestId: string;
  optionIds: Set<string>;
  settled: boolean;
  timeoutHandle: NodeJS.Timeout;
}

export const RESUME_PICKER_CAP = 20;

interface AcpSession {
  handle: AcpProcessHandle;
  /** Active session id used by `session/prompt`. Starts as the handle's
   * sessionId; updated to the loaded id after `resume_pick`. */
  sessionId: string;
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
  /** Per-turn AbortController for the built-in engine. Created in
   * handleSend and aborted in handleStop so the streaming path sees the
   * signal flip exactly when the user clicks Stop. ACP path ignores this. */
  private currentAbort: AbortController | null = null;
  private permissionTimeoutMs: number;
  /** Drop-guard (F1 belt): true between `resume_pick` settle and the next
   * `session/prompt` write. While set, `session/update` notifications for
   * the loaded sessionId are absorbed silently (AcpReplayBuffer is the
   * primary defense; this guard is defense-in-depth). */
  private dropReplayFrames = false;
  /** Set while a `resume_list` round-trip is in flight, so the webview
   * can post a fresh `resume_list` only after the previous list resolves. */
  private resumeListInFlight = false;
  /** Schema-context cache cell (TASK-007 B9) — shared by builtin and ACP
   * turns, keyed by adapter object-reference identity. See
   * `SchemaContextCacheEntry` for why reference equality is a valid,
   * self-invalidating "connection identity" proxy. */
  private schemaCacheRef: { current: SchemaContextCacheEntry | null } = {
    current: null,
  };

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
        // TASK-007 B7: closing the webview tab is a SEPARATE code path from
        // the explicit AiChatPanel.dispose() method below — it must tear
        // down the ACP session and cancel pending permissions the same way,
        // or the omp child process (and its permission timers) leaks.
        this.cancelAllPending();
        this.disposeAcpSession();
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
      case "resume_list":
        await this.handleResumeList();
        return;
      case "resume_pick":
        await this.handleResumePick(msg.sessionId);
        return;
      case "resume_cancel":
        this.handleResumeCancel();
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
    // Per-turn AbortController for the builtin engine — `signal` flows
    // straight through runAgent → deps.streamComplete so a mid-stream Stop
    // cancels the SSE read. Aborted by handleStop().
    this.currentAbort = new AbortController();

    const userMsg: ChatMessage = { role: "user", content: trimmed };

    if (this.engine === "builtin") {
      await this.runBuiltinTurn(userMsg);
      return;
    }

    await this.runAcpTurn(trimmed, userMsg);
  }

  /**
   * Built-in engine turn.
   * Wires the per-turn AbortController signal into runAgent (which routes
   * to deps.streamComplete). Posts {type:"delta"}
   * for each onText fragment;
   * the existing finalize-on-not-aborted branch
   * suppresses the final assistant message when the user clicked Stop.
   * onStreamFallback mirrors agent's fallback notice to the webview with
   * the literal "stream fallback" label so the UI surfaces why streaming
   * wasn't used (provider offline / model doesn't support SSE).
   */
  private async runBuiltinTurn(userMsg: ChatMessage): Promise<void> {
    const registry = createDbTools(this.options.adapterFactory);
    registry.register(createSqlTool(this.options.adapterFactory));
    registry.register(createExportStructureTool(this.options.adapterFactory));

    const messages = await buildMessages(
      this.options.adapterFactory,
      this.history,
      userMsg,
      { cache: this.schemaCacheRef },
    );
    const token = this.token;
    const signal = this.currentAbort?.signal;
    const callbacks: AgentCallbacks = {
      onStep: (step) => this.onStep(step),
      onText: (text) => {
        // Gate at the boundary: a token flip in mid-stream means the user
        // hit Stop — drop pending deltas so the bubble doesn't keep
        // growing after we already committed to aborting.
        if (token?.aborted) return;
        this.post({ type: "delta", text });
      },
      onStreamFallback: () => {
        // Panel owns the literal fallback label (no shared const with
        // agent.ts — see TASK-003 §Interfaces). Rendered through the
        // existing webview `step` case.
        this.post({ type: "step", label: "stream fallback" });
      },
      onToolCall: (call) => {
        // TASK-002: live per-tool step line. Fires BEFORE the tool
        // executes so the UI shows progress on multi-tool turns. The
        // abort-token gate is at the boundary — aborting suppresses
        // further posts. Per spec, agent loop fires regardless of
        // abort state; gating belongs to the consumer.
        if (token?.aborted) return;
        this.post({ type: "step", label: call.name || "tool" });
      },
    };

    try {
      const result = await runAgent(
        { messages, tools: registry },
        this.options.deps,
        callbacks,
        signal,
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
      const aborted =
        this.token?.aborted ||
        (err instanceof Error && err.name === "AbortError");
      if (aborted) {
        // User-driven stop (token flipped) or upstream provider AbortError:
        // the stop UX already surfaces a quiet "stopped" state via the
        // webview's done/de-stream path. Never post an error bubble here.
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // TASK-003 D3: when AI is not configured mid-session, the literal
      // provider error "AI is not configured" is not actionable on its
      // own — the user has to know where to set baseUrl/model/API key.
      // Enrich with the menu path. Other errors surface as-is (provider
      // / stream errors carry "stream" naturally; the webview error
      // case is a thin wrapper around the string).
      const enriched =
        message === "AI is not configured"
          ? "AI is not configured — open VSDB: Open AI Settings to configure baseUrl/model/API key"
          : message;
      this.post({ type: "error", message: enriched });
    } finally {
      this.post({ type: "done" });
      this.currentAbort = null;
      // TASK-007 B6: reset on every turn exit path (success, error, abort)
      // so the resume guards (`token !== null`) don't permanently swallow
      // resume_list/resume_pick after the first message.
      this.token = null;
    }
  }

  private onStep(_step: AgentStep): void {
    // TASK-002: live step lines are posted via onToolCall (fires per
    // call, before execution). onStep still fires for end-of-step
    // notification but no longer drives a webview post here — every
    // call would have already posted via onToolCall.
  }

  /**
   * ACP engine turn (TASK-007 rewrite — B1/B5/B6/B9).
   *
   * Completion: real ACP has no terminal `session/update` notification kind
   * (no `agent_end`/`turn_complete`) — the turn settles on the
   * `session/prompt` JSON-RPC RESPONSE itself, carrying
   * `{stopReason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | ...}`
   * (B1). `acpTurnResolvers` is repurposed as a "belt": Stop/dispose push a
   * resolver there to force early settlement of a turn whose response may
   * never arrive, without hanging indefinitely. `turnDonePosted` remains the
   * single guard against double-posting `assistant`/`done`, whichever path
   * settles first.
   */
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
      this.token = null;
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
      this.token = null;
      return;
    }
    const token = this.token;

    // Reset per-turn buffer so this turn's assistant text doesn't accumulate
    // over previous turn's text (which would leak thinking across turns).
    session.buffer = "";

    try {
      // The drop-guard (F1 belt) is cleared RIGHT BEFORE the outgoing
      // session/prompt write — see AcpClient.request closing the replay
      // window. Any session/update frame for the loaded sessionId that
      // leaked into the handler between load-settle and this write was
      // silently dropped. From here on, agent_message_chunk streams as
      // deltas normally.
      this.dropReplayFrames = false;

      // B9: the ACP prompt previously carried only the raw user text,
      // discarding schema context entirely. Build (or reuse the cached)
      // schema context the same way the builtin engine does and prepend it.
      const contextMessages = await buildMessages(
        this.options.adapterFactory,
        [],
        userMsg,
        { cache: this.schemaCacheRef },
      );
      const systemMsg = contextMessages.find((m) => m.role === "system");
      const promptText =
        systemMsg && systemMsg.content.length > 0
          ? `${systemMsg.content}\n\n${text}`
          : text;

      const requestPromise = session.handle.acp.request<
        { stopReason?: unknown } | undefined
      >("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: promptText }],
      });

      // Primary settlement path: the session/prompt RESPONSE. This wrapper
      // is engineered to NEVER reject (both branches resolve normally) so
      // it can safely race the forced-settlement belt below without an
      // unhandled-rejection warning.
      let stopReason: string | undefined;
      const responseSettled: Promise<void> = requestPromise.then(
        (result) => {
          const r = result?.stopReason;
          if (typeof r === "string") stopReason = r;
        },
        () => undefined,
      );

      // Belt: Stop/dispose push a resolver here (see handleStop /
      // disposeAcpSession) to force early settlement of a turn that may
      // never receive a response (hung/killed process).
      let forced = false;
      let myResolve: () => void = () => {};
      const forcedSettled: Promise<void> = new Promise((resolve) => {
        myResolve = () => {
          forced = true;
          resolve();
        };
        this.acpTurnResolvers.push(myResolve);
      });

      await Promise.race([responseSettled, forcedSettled]);
      const idx = this.acpTurnResolvers.indexOf(myResolve);
      if (idx !== -1) this.acpTurnResolvers.splice(idx, 1);

      const userAborted = token?.aborted === true;

      // Every stopReason is handled explicitly — no silent fallthrough.
      let postAssistant: boolean;
      if (forced || userAborted) {
        // Stop/dispose forced early settlement — never surface a (possibly
        // partial) assistant bubble for a turn the user cancelled.
        postAssistant = false;
      } else {
        switch (stopReason) {
          case "end_turn":
          case "max_tokens":
            // Real model content — surface it even when max_tokens
            // truncated it.
            postAssistant = true;
            break;
          case "cancelled":
          case "refusal":
            // Server-side cancel or refusal carries no usable final text.
            postAssistant = false;
            break;
          default:
            // Unrecognized/missing stopReason — conservatively surface
            // whatever text streamed rather than losing it silently.
            postAssistant = true;
            break;
        }
      }

      if (!this.turnDonePosted) {
        if (postAssistant && session.buffer.length > 0) {
          const finalText = session.buffer;
          this.post({ type: "assistant", text: finalText, markdown: true });
          this.history = [
            ...this.history,
            userMsg,
            { role: "assistant", content: finalText },
          ];
        }
        this.post({ type: "done" });
        this.turnDonePosted = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message });
      if (!this.turnDonePosted) {
        this.post({ type: "done" });
        this.turnDonePosted = true;
      }
    } finally {
      // TASK-007 B6: reset on every turn exit path (success, error, abort)
      // so the resume guards (`token !== null`) don't permanently swallow
      // resume_list/resume_pick after the first message.
      this.token = null;
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
      sessionId: handle.sessionId,
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
    // Drop-guard (F1 belt): between resume_pick settle and the next
    // session/prompt write, ignore session/update for the loaded sessionId.
    // AcpReplayBuffer is the primary defense (server-originated frames
    // for the loaded id are absorbed there); this is belt + suspenders.
    if (
      this.dropReplayFrames &&
      (params as { sessionId?: unknown }).sessionId === session.sessionId
    ) {
      return;
    }
    const update = (params as { update?: unknown }).update;
    if (update === null || typeof update !== "object") return;
    const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
    if (sessionUpdate === "agent_message_chunk") {
      if (this.token?.aborted) return;
      // TASK-007 B2: ACP `agent_message_chunk` carries
      // `content: {type:"text", text}` — the SAME envelope
      // `user_message_chunk` already uses. There is no `delta` field.
      const content = (update as { content?: unknown }).content;
      let text: string | undefined;
      if (content !== null && typeof content === "object") {
        const t = (content as { text?: unknown }).text;
        if (typeof t === "string") text = t;
      }
      if (typeof text === "string" && text.length > 0) {
        session.buffer += text;
        this.post({ type: "delta", text });
      }
      return;
    }
    // agent_thought_chunk + every other update kind (including the stale
    // cycle-L `agent_end`/`turn_complete` names, which real ACP never
    // emits — see runAcpTurn's response-based settlement, TASK-007 B1):
    // deliberately ignored. agent_thought_chunk must never render or
    // surface (TASK-004 §3).
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
    const options = Array.isArray(p.options) ? p.options : [];
    const toolCall = p.toolCall;
    const toolInfo = buildPermissionToolInfo(toolCall);
    const toolId = toolInfo.id;
    const toolName = toolInfo.name;
    const toolDetail = toolInfo.detail;
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
    if (this.engine === "builtin") {
      // Flip the per-turn signal so any in-flight streamComplete sees the
      // abort and stops reading from the SSE body. Agent-side emits the
      // bare AbortError which onText-on-the-host-side won't get to handle
      // (we suppress when token.aborted is true); the agent's runStep
      // rethrows it so the runBuiltinTurn catch is skipped.
      this.currentAbort?.abort();
    }
    if (this.engine === "omp" && this.acpSession !== null) {
      this.cancelAllPending();
      // TASK-007 B5: previously Stop never resolved `acpTurnResolvers`,
      // never posted `done`, and never told the server to stop generating
      // — the UI stayed busy forever and omp kept running. Best-effort
      // fire-and-forget `session/cancel` notification (no response
      // expected — see AcpClient.notify), then force the belt so
      // runAcpTurn's Promise.race settles immediately instead of waiting
      // on a response that may never distinguish this as a cancel.
      try {
        this.acpSession.handle.acp.notify("session/cancel", {
          sessionId: this.acpSession.sessionId,
        });
      } catch {
        // Best-effort — process may already be gone.
      }
      const resolvers = this.acpTurnResolvers.splice(0);
      for (const r of resolvers) r();
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
    // Full turn reset: Clear giữa turn đang stream phải hủy turn + trả UI
    // về idle. Không reset token/currentAbort → webview busy mãi (D2).
    this.token = null;
    this.currentAbort?.abort();      // hủy SSE đang đọc (builtin)
    this.currentAbort = null;
    this.turnDonePosted = false;
    this.cancelAllPending();          // ACP pending → cancelled (giữ pattern stop)
    this.history = [];
    this.post({ type: "init", hasHistory: false });
    this.post({ type: "done" });      // belt: webview busy flag về false
  }

  /** Workspace cwd used to filter session/list entries. */
  private workspaceCwd(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    );
  }

  /** Compare two entries for sort-by-updatedAt-desc with a raw-string
   * fallback (TASK-003 F2): if Date.parse yields NaN for either side, fall
   * back to lexicographic comparison of the raw strings. */
  private static compareUpdatedAtDesc(
    a: AcpSessionListItem,
    b: AcpSessionListItem,
  ): number {
    const pa = Date.parse(a.updatedAt);
    const pb = Date.parse(b.updatedAt);
    if (Number.isNaN(pa) && Number.isNaN(pb)) {
      if (a.updatedAt < b.updatedAt) return 1;
      if (a.updatedAt > b.updatedAt) return -1;
      return 0;
    }
    if (Number.isNaN(pa)) return 1; // NaN last
    if (Number.isNaN(pb)) return -1;
    return pb - pa;
  }

  /** Pure helper: derive ordered history items from a replay buffer.
   * - agent_thought_chunk NEVER renders (TASK-003 §3)
   * - user_message_chunk: kind "user", text = content.text
   * - agent_message_chunk: kind "assistant", text = delta
   * - tool_call: kind "tool", text = title || name || toolCallId || "tool"
   * - cap: HISTORY_RENDER_CAP items; older items dropped, truncatedCount set.
   * - malformed entries (missing content/tool fields, unknown sessionUpdate)
   *   are skipped silently — derive NEVER throws. */
  static deriveHistoryFromReplay(
    notifications: readonly AcpReplayNotification[],
  ): {
    items: Array<{ kind: "user" | "assistant" | "tool"; text: string }>;
    truncated: boolean;
    truncatedCount: number;
  } {
    const items: Array<{ kind: "user" | "assistant" | "tool"; text: string }> = [];
    for (const n of notifications) {
      if (n.method !== "session/update") continue;
      const params = n.params;
      if (params === null || typeof params !== "object") continue;
      const update = (params as { update?: unknown }).update;
      if (update === null || typeof update !== "object") continue;
      const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
      if (sessionUpdate === "agent_message_chunk") {
        // TASK-007 B2: same envelope as user_message_chunk below —
        // `content: {type:"text", text}`, not a `delta` field.
        const content = (update as { content?: unknown }).content;
        if (content === null || typeof content !== "object") continue;
        const text = (content as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          items.push({ kind: "assistant", text });
        }
        continue;
      }
      if (sessionUpdate === "user_message_chunk") {
        const content = (update as { content?: unknown }).content;
        if (content === null || typeof content !== "object") continue;
        const text = (content as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          items.push({ kind: "user", text });
        }
        continue;
      }
      if (sessionUpdate === "tool_call") {
        const title = (update as { title?: unknown }).title;
        const name = (update as { name?: unknown }).name;
        const toolCallId = (update as { toolCallId?: unknown }).toolCallId;
        const label =
          (typeof title === "string" && title.length > 0 && title) ||
          (typeof name === "string" && name.length > 0 && name) ||
          (typeof toolCallId === "string" && toolCallId.length > 0 && toolCallId) ||
          "tool";
        items.push({ kind: "tool", text: label });
        continue;
      }
      // agent_thought_chunk, unknown kinds: skipped silently.
    }
    const total = items.length;
    if (total <= HISTORY_RENDER_CAP) {
      return { items, truncated: false, truncatedCount: 0 };
    }
    const drop = total - HISTORY_RENDER_CAP;
    return {
      items: items.slice(drop),
      truncated: true,
      truncatedCount: drop,
    };
  }

  private async handleResumeList(): Promise<void> {
    // Guard: builtin engine has no session persistence — error inline.
    if (this.engine !== "omp") {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    // Guard: another list already in flight — drop silently.
    if (this.resumeListInFlight) return;
    const acp = this.options.acp;
    if (acp === undefined) {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    // Guard: while a turn is streaming, do not spawn a list round-trip.
    if (this.token !== null) return;
    this.resumeListInFlight = true;
    try {
      const session = await this.ensureAcpSession();
      const handle = session.handle;
      const cwd = this.workspaceCwd();
      const all = await handle.acp.sessionList();
      const ownSessionId = session.sessionId;
      const filtered = all
        .filter((e: AcpSessionListItem) => e.cwd === cwd)
        .filter((e: AcpSessionListItem) => e.sessionId !== ownSessionId)
        .slice()
        .sort(AiChatPanel.compareUpdatedAtDesc)
        .slice(0, RESUME_PICKER_CAP);
      this.post({
        type: "resume_sessions",
        sessions: filtered.map((e: AcpSessionListItem) => ({
          sessionId: e.sessionId,
          label:
            e.title !== null && e.title.length > 0 && e.title !== "<function>"
              ? e.title
              : "(untitled)",
          detail: `${e.messageCount} messages`,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `Resume list failed: ${message}` });
    } finally {
      this.resumeListInFlight = false;
    }
  }

  private async handleResumePick(sessionId: string): Promise<void> {
    if (this.engine !== "omp") {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    // Guard (R5): while a turn is streaming, ignore resume_pick. Re-basing
    // sessionId mid-turn would let the in-flight agent_end arrive for the
    // OLD sessionId while session.sessionId is already the NEW one —
    // acpTurnResolvers never settles and the panel streams forever.
    if (this.token !== null) return;
    const acp = this.options.acp;
    if (acp === undefined) {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    try {
      const acpSession = await this.ensureAcpSession();
      const handle = acpSession.handle;
      // sessionLoad opens the replay window on the AcpClient. We arm the
      // panel-side drop-guard BEFORE awaiting so any in-flight frame that
      // races the load settles into the guard instead of leaking to the
      // delta path.
      this.dropReplayFrames = true;
      const cwd = this.workspaceCwd();
      const result = await handle.acp.sessionLoad(sessionId, cwd);
      const { items, truncated, truncatedCount } =
        AiChatPanel.deriveHistoryFromReplay(result.replay.notifications);
      // Re-base the active sessionId BEFORE posting the history batch so
      // the webview can immediately send a follow-up prompt. Both the
      // AcpProcessHandle AND the cached AcpSession must be updated so
      // runAcpTurn reads the new id when it next issues session/prompt.
      handle.sessionId = sessionId;
      acpSession.sessionId = sessionId;
      this.post({ type: "history", items, truncated, truncatedCount });
      // dropReplayFrames stays armed until the next session/prompt write
      // (see runAcpTurn) — that write is what closes the AcpClient's
      // replay window, and the guard mirrors that lifecycle exactly.
    } catch (err) {
      this.dropReplayFrames = false;
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: "error",
        message: `Resume failed: ${message}`,
      });
    }
  }

  private handleResumeCancel(): void {
    // Nothing to cancel on the host side today — the webview closes the
    // picker. Reserved hook for a future in-flight load tracker.
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
