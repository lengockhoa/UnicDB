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

export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly pending = new Map<number, PendingRequest>();
  private serverRequestHandler: AcpServerRequestHandler | null = null;
  private notificationHandler: AcpNotificationHandler | null = null;
  private readonly closeListeners: AcpCloseListener[] = [];
  private nextClientId = 1;
  private disposed = false;
  private lineListener: ((line: string) => void) | null = null;

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
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
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
    const cb = this.notificationHandler;
    if (cb === null) return;
    const method = typeof frame["method"] === "string" ? (frame["method"] as string) : "";
    try {
      cb({ method, params: frame["params"] });
    } catch {
      /* listener errors must not break the line pump */
    }
  }
}