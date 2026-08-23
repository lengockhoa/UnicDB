// src/ai/omp/rpc.ts
// OmpRpcClient — JSONL RPC client theo giao thức THẬT của omp 18.x
// (live-probed 2026-08-23, xem docs/AI_HANDOFF/tasks/TASK-001.md §REAL protocol facts).
//
// Pure / injectable: không import vscode, không spawn process. Mọi I/O qua RpcTransport.

export interface RpcTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  close(): void;
}

interface PendingRequest {
  command: string;
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class OmpRpcClient {
  private readonly transport: RpcTransport;
  private readonly eventListeners: Array<(ev: Record<string, unknown>) => void> = [];
  private hostToolHandler:
    | ((call: { id: string; toolName: string; arguments: unknown }) => Promise<unknown>)
    | null = null;
  private pending: PendingRequest | null = null;
  private queue: Array<() => void> = [];
  private readyResolver:
    | ((info: Record<string, unknown>) => void)
    | null = null;
  private readyRejecter: ((err: Error) => void) | null = null;
  private readyTimeoutHandle: NodeJS.Timeout | null = null;
  private readyFrame: Record<string, unknown> | null = null;
  private disposed = false;
  private lineListener: ((line: string) => void) | null = null;

  constructor(transport: RpcTransport) {
    this.transport = transport;
    this.lineListener = (line: string) => {
      this.handleLine(line);
    };
    this.transport.onLine(this.lineListener);
  }

  /** Resolve khi frame type=ready (cached nếu ready đã đến trước). */
  waitReady(timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (this.readyFrame !== null) {
      return Promise.resolve(this.readyFrame);
    }
    if (this.disposed) {
      return Promise.reject(new Error("disposed"));
    }
    if (this.readyResolver !== null && this.readyRejecter !== null) {
      throw new Error("waitReady already called");
    }
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });
    if (timeoutMs > 0) {
      this.readyTimeoutHandle = setTimeout(() => {
        if (this.readyRejecter !== null) {
          const rejectFn = this.readyRejecter;
          this.readyResolver = null;
          this.readyRejecter = null;
          rejectFn(new Error(`waitReady timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }
    return promise;
  }

  /** Subscribe to mọi frame không phải ready/response. */
  onEvent(cb: (ev: Record<string, unknown>) => void): void {
    this.eventListeners.push(cb);
  }

  /** Register handler cho host_tool_call frames. */
  handleHostToolCall(
    handler: (call: { id: string; toolName: string; arguments: unknown }) => Promise<unknown>,
  ): void {
    this.hostToolHandler = handler;
  }

  /**
   * Send a command; serialize 1-in-flight; resolve với response.data khi
   * matching response arrived; reject nếu success=false hoặc disposed.
   */
  request(cmd: { type: string } & Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disposed) {
      return Promise.reject(new Error("disposed"));
    }
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const send = (): void => {
        if (this.disposed) {
          reject(new Error("disposed"));
          return;
        }
        this.pending = {
          command: cmd["type"] as string,
          resolve: (data) => {
            resolve(data);
          },
          reject,
        };
        this.transport.write(JSON.stringify(cmd) + "\n");
      };
      if (this.pending !== null) {
        this.queue.push(send);
      } else {
        send();
      }
    });
    return promise;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.readyTimeoutHandle !== null) {
      clearTimeout(this.readyTimeoutHandle);
      this.readyTimeoutHandle = null;
    }
    const rejectReady = this.readyRejecter;
    this.readyResolver = null;
    this.readyRejecter = null;
    if (rejectReady !== null) {
      rejectReady(new Error("disposed"));
    }
    if (this.pending !== null) {
      const pend = this.pending;
      this.pending = null;
      pend.reject(new Error("disposed"));
    }
    for (const send of this.queue) {
      try {
        send();
      } catch {
        /* swallow; dispose is best-effort */
      }
    }
    this.queue = [];
    try {
      this.transport.close();
    } catch {
      /* ignore */
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = frame["type"];

    if (type === "ready") {
      this.readyFrame = frame;
      if (this.readyResolver !== null && this.readyRejecter !== null) {
        const resolve = this.readyResolver;
        if (this.readyTimeoutHandle !== null) {
          clearTimeout(this.readyTimeoutHandle);
          this.readyTimeoutHandle = null;
        }
        this.readyResolver = null;
        this.readyRejecter = null;
        resolve(frame);
      }
      return;
    }

    if (type === "response") {
      const command = frame["command"] as string | undefined;
      const success = frame["success"] as boolean | undefined;
      if (this.pending !== null && command === this.pending.command) {
        const pend = this.pending;
        this.pending = null;
        if (success === true) {
          const data = (frame["data"] as Record<string, unknown> | undefined) ?? {};
          pend.resolve(data);
        } else {
          const errMsg = (frame["error"] as string | undefined) ?? `response command=${command} failed`;
          pend.reject(new Error(errMsg));
        }
        const next = this.queue.shift();
        if (next !== undefined) {
          next();
        }
      }
      // Responses when no pending → ignore.
      return;
    }

    if (type === "host_tool_call") {
      void this.handleHostToolCallFrame(frame);
      return;
    }

    // Mọi frame khác: gửi qua eventListeners.
    for (const cb of this.eventListeners) {
      try {
        cb(frame);
      } catch {
        /* listener errors must not break the line pump */
      }
    }
  }

  private async handleHostToolCallFrame(frame: Record<string, unknown>): Promise<void> {
    if (this.hostToolHandler === null) {
      return;
    }
    const id = frame["id"] as string;
    const toolName = frame["toolName"] as string;
    const args = frame["arguments"];
    let text: string;
    let isError = false;
    try {
      const result = await this.hostToolHandler({ id, toolName, arguments: args });
      text = String(result);
    } catch (err) {
      isError = true;
      const msg = err instanceof Error ? err.message : String(err);
      text = `Tool failed: ${msg}`;
    }
    if (this.disposed) {
      return;
    }
    const response = {
      type: "host_tool_result",
      id,
      result: { content: [{ type: "text", text }] },
      isError,
    };
    this.transport.write(JSON.stringify(response) + "\n");
  }
}