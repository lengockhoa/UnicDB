// src/ai/omp/__tests__/acp.test.ts
// Unit tests cho src/ai/omp/acp.ts (AcpClient). TASK-001 §Test Cases #1..#4.
//
// Pure injectable tests — sử dụng FakeAcpTransport ghi nhận các write/onLine
// thay vì spawn child process thật. Frames tuân theo ACP JSON-RPC 2.0 NDJSON
// đã live-probe trên omp 18.0.1 (xem TASK-001 §Discussion).
import { describe, it, expect, beforeEach } from "vitest";
import { AcpClient, type AcpTransport } from "../acp";

// ---- Fake transport ----------------------------------------------------------

class FakeAcpTransport implements AcpTransport {
  written: string[] = [];
  private listeners: Array<(line: string) => void> = [];

  write(line: string): void {
    this.written.push(line);
  }
  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }
  close(): void {
    /* noop */
  }

  /** Convenience: drive a single frame through every registered listener. */
  feed(line: string): void {
    for (const cb of this.listeners) {
      cb(line);
    }
  }

  /** Helper: parse the last written JSON frame. */
  lastWritten(): Record<string, unknown> {
    const last = this.written[this.written.length - 1];
    return JSON.parse(last) as Record<string, unknown>;
  }

  allWritten(): Array<Record<string, unknown>> {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

/** Drain microtasks until the queue is empty (no real wall-clock delay). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("AcpClient", () => {
  let transport: FakeAcpTransport;

  beforeEach(() => {
    transport = new FakeAcpTransport();
  });

  // #1 — client request writes JSON-RPC and resolves matching response
  it("client request writes JSON-RPC request and resolves matching response", async () => {
    const client = new AcpClient(transport);

    const pending = client.request("session/new", { cwd: "/tmp", mcpServers: [] });

    // Allow the synchronous write to flush.
    await flushMicrotasks();
    const written = transport.allWritten();
    expect(written).toHaveLength(1);
    const req = written[0];
    expect(req["jsonrpc"]).toBe("2.0");
    expect(req["method"]).toBe("session/new");
    expect(req["params"]).toEqual({ cwd: "/tmp", mcpServers: [] });
    expect(typeof req["id"]).toBe("number");

    // Feed the matching JSON-RPC response with same id.
    const id = req["id"];
    transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "abc" } }));
    const result = await pending;
    expect(result).toEqual({ sessionId: "abc" });
  });

  // #2 — malformed/unknown JSON-RPC frame is ignored; pending stays pending
  it("ignores malformed lines; pending client request stays pending", async () => {
    const client = new AcpClient(transport);
    const pending = client.request("session/new", { cwd: "/tmp", mcpServers: [] });

    // Garbage lines that must not settle anything.
    transport.feed("not-json");
    transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { unrelated: true } }));
    await flushMicrotasks();

    // Pending still pending: must not have resolved yet.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    // Now feed the real response with the same id written by the request.
    const id = transport.lastWritten()["id"];
    transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "xyz" } }));
    const result = await pending;
    expect(result).toEqual({ sessionId: "xyz" });
  });

  // #3 — two incoming session/request_permission calls are correlated
  it("two incoming server requests each dispatch to handler with their own id", async () => {
    const client = new AcpClient(transport);
    const seen: Array<{ id: unknown; method: string; params: unknown }> = [];
    client.onServerRequest((call) => {
      seen.push({ id: call.id, method: call.method, params: call.params });
      // Resolve each one.
      call.respond({ outcome: { outcome: "selected", optionId: "opt-1" } });
    });

    // Server sends two permission requests with different ids.
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srv-1",
        method: "session/request_permission",
        params: { sessionId: "s1", toolCall: { toolName: "bash" }, options: [] },
      }),
    );
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srv-2",
        method: "session/request_permission",
        params: { sessionId: "s1", toolCall: { toolName: "edit" }, options: [] },
      }),
    );

    await flushMicrotasks();

    expect(seen).toHaveLength(2);
    expect(seen[0].id).toBe("srv-1");
    expect(seen[1].id).toBe("srv-2");
    expect(seen[0].method).toBe("session/request_permission");
    expect(seen[1].method).toBe("session/request_permission");

    // Two correlated JSON-RPC results written, keyed by original server IDs.
    const written = transport.allWritten();
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "srv-1",
      result: { outcome: { outcome: "selected", optionId: "opt-1" } },
    });
    expect(written[1]).toMatchObject({
      jsonrpc: "2.0",
      id: "srv-2",
      result: { outcome: { outcome: "selected", optionId: "opt-1" } },
    });
  });

  // #4 — handler error writes correlated JSON-RPC error keyed by server ID
  it("handler reject writes correlated JSON-RPC error keyed by original server id", async () => {
    const client = new AcpClient(transport);
    client.onServerRequest((call) => {
      call.respondError(-32603, "denied by user");
    });

    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srv-err",
        method: "session/request_permission",
        params: { sessionId: "s1", toolCall: { toolName: "edit" }, options: [] },
      }),
    );
    await flushMicrotasks();

    const written = transport.allWritten();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "srv-err",
      error: { code: -32603, message: "denied by user" },
    });
  });

  // Bonus — notifications dispatched separately (no id, must not be confused with server requests)
  it("server notification (no id) routes to onNotification, not to onServerRequest", async () => {
    const client = new AcpClient(transport);
    const notifs: Array<{ method: string; params: unknown }> = [];
    const reqs: unknown[] = [];
    client.onNotification((n) => notifs.push(n));
    client.onServerRequest((r) => reqs.push(r));

    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
    );
    await flushMicrotasks();

    expect(notifs).toHaveLength(1);
    expect(notifs[0].method).toBe("session/update");
    expect(reqs).toHaveLength(0);
  });

  // Bonus — client notification writes JSON-RPC notification without id
  it("client.notify writes JSON-RPC notification without id", () => {
    const client = new AcpClient(transport);
    client.notify("initialized", {});
    expect(transport.allWritten()).toEqual([
      { jsonrpc: "2.0", method: "initialized", params: {} },
    ]);
  });
});