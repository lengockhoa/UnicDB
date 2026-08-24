// src/ai/omp/acp.ts
// AcpClient — typed JSON-RPC 2.0 NDJSON client for the ACP protocol.
// Live-probed against omp 18.0.1 (see docs/AI_HANDOFF/tasks/TASK-001.md).
//
// Pure / injectable: không import vscode, không spawn process. Mọi I/O
// đi qua AcpTransport. Server-originated frames are dispatched to either
// onNotification (no `id`) or onServerRequest (has `id`). Client-originated
// requests are correlated by monotonically increasing client IDs.
//
// Scope intentionally narrow:
// - No timeout/cancellation ownership. Reserved for TASK-004 panel state.
// - No envelope invention. Method names and parameter shapes are derived
//   from live evidence in docs/AI_HANDOFF/queue/ACP-APPROVAL-research.md.

export interface AcpTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  close(): void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** Server-originated request with correlation ID for reply. */
export interface AcpServerRequest {
  id: unknown;
  method: string;
  params: unknown;
  /** Write a successful JSON-RPC result keyed by the original server `id`. */
  respond(result: unknown): void;
  /** Write a JSON-RPC error response keyed by the original server `id`. */
  respondError(code: number, message: string, data?: unknown): void;
}

/** Server-originated notification (no `id`). */
export interface AcpNotification {
  method: string;
  params: unknown;
}

/** Listener invoked when the underlying transport closes / the client disposes. */
export type AcpCloseListener = () => void;

export type AcpServerRequestHandler = (call: AcpServerRequest) => void | Promise<void>;
export type AcpNotificationHandler = (n: AcpNotification) => void;

/** Normalized entry from `session/list`. Title is null when missing/non-string/<function>. */
export interface AcpSessionListItem {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
  size: number;
}

/** A single absorbed replay notification. */
export interface AcpReplayNotification {
  method: string;
  params: unknown;
}

/**
 * LIVE buffer of session/update notifications absorbed during a session/load
 * window. The promise from sessionLoad() settles when the load result arrives,
 * but the buffer may keep growing until the next outgoing request/notify
 * closes the window. After close, subsequent session/update frames for the
 * same sessionId flow to the registered onNotification handler.
 */
export interface AcpReplayBuffer {
  readonly notifications: readonly AcpReplayNotification[];
  readonly closed: boolean;
}

/** Result of sessionLoad(): the load result payload + the LIVE replay buffer. */
export interface AcpSessionLoadResult {
  configOptions: unknown;
  modes: unknown;
  replay: AcpReplayBuffer;
}

export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly pending = new Map<number, PendingRequest>();
  private serverRequestHandler: AcpServerRequestHandler | null = null;
  private notificationHandler: AcpNotificationHandler | null = null;
  private readonly closeListeners: AcpCloseListener[] = [];
  private nextClientId = 1;
  private disposed = false;
  private lineListener: ((line: string) => void) | null = null;
  /**
   * Active session/load replay window. When non-null, incoming
   * `session/update` notifications for the matching sessionId are absorbed
   * into `notifications` instead of being delivered to onNotification.
   * The window opens when sessionLoad() writes its request frame and closes
   * when the next outgoing request/notify writes its frame (absorb-then-flush
   * ordering: close is marked BEFORE the outgoing write, so any replay
   * frames still arriving up to that point have already been appended).
   */
  private replayState: {
    sessionId: string;
    buffer: { notifications: AcpReplayNotification[]; closed: boolean };
  } | null = null;
  /** Set to the sessionId while a session/load request is outstanding. */
  private loadInFlight: string | null = null;

  constructor(transport: AcpTransport) {
    this.transport = transport;
    this.lineListener = (line: string) => {
      this.handleLine(line);
    };
    this.transport.onLine(this.lineListener);
  }

  /**
   * Send a JSON-RPC request. Writes `{jsonrpc:"2.0", id, method, params}` and
   * resolves with the matching `result`, or rejects with the matching `error`.
   * No timeout/cancellation is owned by this client — see TASK-004.
   */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("disposed"));
    }
    // Close any open replay window BEFORE the outgoing write (absorb-then-flush).
    this.closeReplayWindow();
    return this.requestRaw<T>(method, params);
  }

  /**
   * Write a request frame and return the matching result promise. Does NOT
   * close the replay window — used by sessionLoad(), which opens the window
   * around its own write.
   */
  private requestRaw<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextClientId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject: (err: Error) => {
          reject(err);
        },
      });
      this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /**
   * Send a JSON-RPC notification (no `id`). The server cannot reply.
   * Used for `initialized`, cancellation hints, etc.
   */
  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    this.closeReplayWindow();
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /**
   * List persisted sessions via `session/list` (params `{}`). Returns a
   * normalized array; entries with non-string sessionId are dropped,
   * junk title (`<function>` / missing / non-string) becomes null, missing
   * `_meta` defaults messageCount/size to 0, non-string updatedAt becomes "".
   */
  async sessionList(): Promise<AcpSessionListItem[]> {
    const raw = (await this.request<unknown>("session/list", {})) as { sessions?: unknown } | undefined;
    const sessions = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
    const out: AcpSessionListItem[] = [];
    for (const entry of sessions) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e["sessionId"] !== "string") continue;
      const titleRaw = e["title"];
      const title: string | null =
        typeof titleRaw === "string" && titleRaw !== "<function>" ? titleRaw : null;
      const updatedAtRaw = e["updatedAt"];
      const updatedAt: string = typeof updatedAtRaw === "string" ? updatedAtRaw : "";
      const cwdRaw = e["cwd"];
      const cwd: string = typeof cwdRaw === "string" ? cwdRaw : "";
      const metaRaw = e["_meta"];
      const meta = metaRaw !== null && typeof metaRaw === "object" ? (metaRaw as Record<string, unknown>) : null;
      const messageCount =
        meta !== null && typeof meta["messageCount"] === "number" ? (meta["messageCount"] as number) : 0;
      const size = meta !== null && typeof meta["size"] === "number" ? (meta["size"] as number) : 0;
      out.push({ sessionId: e["sessionId"] as string, cwd, title, updatedAt, messageCount, size });
    }
    return out;
  }

  /**
   * Load a session via `session/load` (params `{sessionId, cwd, mcpServers: []}`)
   * and return the load result plus a LIVE replay buffer. The replay window is
   * OPEN at the moment this call's request frame is written, and CLOSED by the
   * next outgoing request()/notify() write. While open, incoming `session/update`
   * notifications whose params.sessionId equals `sessionId` are absorbed into
   * the buffer (in arrival order) instead of being delivered to onNotification.
   * Concurrent calls (before the first settles) reject synchronously.
   */
  async sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult> {
    if (this.loadInFlight !== null) {
      throw new Error("session load already in progress");
    }
    this.loadInFlight = sessionId;
    // Open the window BEFORE the request write so that notifications arriving
    // in the same NDJSON flush as the request frame are also absorbed.
    const buffer: { notifications: AcpReplayNotification[]; closed: boolean } = {
      notifications: [],
      closed: false,
    };
    this.replayState = { sessionId, buffer };
    let result: unknown;
    try {
      result = await this.requestRaw<unknown>("session/load", {
        sessionId,
        cwd,
        mcpServers: [],
      });
    } finally {
      this.loadInFlight = null;
    }
    const obj = (result ?? {}) as { configOptions?: unknown; modes?: unknown };
    return {
      configOptions: obj.configOptions,
      modes: obj.modes,
      replay: {
        get notifications() {
          return buffer.notifications as readonly AcpReplayNotification[];
        },
        get closed() {
          return buffer.closed;
        },
      },
    };
  }

  /** Mark the current replay window closed and drop the reference. */
  private closeReplayWindow(): void {
    if (this.replayState === null) return;
    this.replayState.buffer.closed = true;
    this.replayState = null;
  }

  /**
   * Write a successful JSON-RPC result to the transport, keyed by the given
   * server-originated request ID. Used by the panel's permission coordinator
   * to settle `session/request_permission` with `{outcome: "selected", optionId}`
   * or `{outcome: "cancelled"}`.
   */
  respond(id: unknown, result: unknown): void {
    this.writeResponse(id, { jsonrpc: "2.0", id, result });
  }

  /** Register handler for server-originated requests (frames with an `id`). */
  onServerRequest(handler: AcpServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }
  /** Register handler for server-originated notifications (frames with no `id`). */
  onNotification(handler: AcpNotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Register a listener that fires when the underlying transport closes or
   * the client disposes. Used by the panel to detect process exit and
   * default-deny any pending permission requests before the writer is gone.
   * Listeners fire at most once per registration.
   */
  onClose(listener: AcpCloseListener): void {
    if (this.disposed) {
      // Already closed — fire immediately on a microtask so callers can
      // register safely from within their setup path.
      queueMicrotask(listener);
      return;
    }
    this.closeListeners.push(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    // Drain close listeners BEFORE marking the client disposed. Listeners
    // (e.g. the panel's permission coordinator) need to write final
    // responses on the transport — once `disposed` is true, writeResponse
    // silently drops every write.
    const listeners = this.closeListeners.splice(0);
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        /* listener errors must not break the close path */
      }
    }
    this.disposed = true;
    for (const pend of this.pending.values()) {
      pend.reject(new Error("disposed"));
    }
    this.pending.clear();
    try {
      this.transport.close();
    } catch {
      /* ignore */
    }
    this.lineListener = null;
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame["jsonrpc"] !== "2.0") {
      // Malformed/unknown JSON-RPC frame — ignored.
      return;
    }

    const hasId = "id" in frame;
    const isResponse = hasId && ("result" in frame || "error" in frame);

    if (isResponse) {
      this.dispatchResponse(frame);
      return;
    }

    if (hasId) {
      void this.dispatchServerRequest(frame);
      return;
    }

    this.dispatchNotification(frame);
  }

  private dispatchResponse(frame: Record<string, unknown>): void {
    const id = frame["id"];
    if (typeof id !== "number") {
      // Correlation key is a client-side integer. Ignore non-matching IDs.
      return;
    }
    const pend = this.pending.get(id);
    if (pend === undefined) return;
    this.pending.delete(id);
    if ("error" in frame) {
      const err = frame["error"] as { code?: number; message?: string; data?: unknown };
      const message = err.message ?? `JSON-RPC error ${err.code ?? "unknown"}`;
      const wrapped = new Error(`ACP error ${err.code ?? "?"}: ${message}`);
      (wrapped as Error & { data?: unknown; code?: number }).code = err.code;
      (wrapped as Error & { data?: unknown; code?: number }).data = err.data;
      pend.reject(wrapped);
      return;
    }
    pend.resolve(frame["result"]);
  }

  private async dispatchServerRequest(frame: Record<string, unknown>): Promise<void> {
    if (this.serverRequestHandler === null) {
      // No handler registered — server request goes unanswered. The server's
      // own timeout policy governs. We do not invent responses.
      return;
    }
    const id = frame["id"];
    const method = typeof frame["method"] === "string" ? (frame["method"] as string) : "";
    const params = frame["params"];

    const call: AcpServerRequest = {
      id,
      method,
      params,
      respond: (result: unknown) => {
        this.writeResponse(id, { jsonrpc: "2.0", id, result });
      },
      respondError: (code: number, message: string, data?: unknown) => {
        const err: { code: number; message: string; data?: unknown } = { code, message };
        if (data !== undefined) err.data = data;
        this.writeResponse(id, { jsonrpc: "2.0", id, error: err });
      },
    };

    try {
      await this.serverRequestHandler(call);
    } catch (err) {
      // Handler rejected — surface as correlated JSON-RPC error.
      const message = err instanceof Error ? err.message : String(err);
      call.respondError(-32603, message);
    }
  }

  private writeResponse(_id: unknown, frame: Record<string, unknown>): void {
    if (this.disposed) return;
    this.transport.write(JSON.stringify(frame) + "\n");
  }

  private dispatchNotification(frame: Record<string, unknown>): void {
    const method = typeof frame["method"] === "string" ? (frame["method"] as string) : "";
    const params = frame["params"];
    // Replay window is open: absorb `session/update` whose sessionId matches.
    if (
      this.replayState !== null &&
      method === "session/update" &&
      params !== null &&
      typeof params === "object" &&
      (params as Record<string, unknown>)["sessionId"] === this.replayState.sessionId
    ) {
      this.replayState.buffer.notifications.push({ method, params });
      return;
    }
    const cb = this.notificationHandler;
    if (cb === null) return;
    try {
      cb({ method, params });
    } catch {
      /* listener errors must not break the line pump */
    }
  }
}