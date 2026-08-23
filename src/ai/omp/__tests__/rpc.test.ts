// src/ai/omp/__tests__/rpc.test.ts
// Unit tests cho src/ai/omp/rpc.ts (OmpRpcClient). TASK-001 §Test Cases #1..#7.
//
// Pure injectable tests — sử dụng FakeTransport ghi nhận các write/onLine
// thay vì spawn child process thật. Frames tuân theo §REAL protocol facts:
// - ready:  {"type":"ready","protocolVersion":1,...}
// - response: {"type":"response","command":"<cmd>","success":...,"data"?:...,"error"?:...}
// - host_tool_call: {"type":"host_tool_call","id":..., "toolName":..., "arguments":...}
import { describe, it, expect, beforeEach } from "vitest";
import { OmpRpcClient, type RpcTransport } from "../rpc";

// ---- Fake transport ----------------------------------------------------------

class FakeTransport implements RpcTransport {
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
    if (last === undefined) {
      throw new Error("no frames written");
    }
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

describe("OmpRpcClient", () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  // #1
  it("waitReady resolves with protocolVersion frame", async () => {
    const rpc = new OmpRpcClient(transport);
    const readyPromise = rpc.waitReady();
    transport.feed(JSON.stringify({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
    }));
    const info = await readyPromise;
    expect(info["protocolVersion"]).toBe(1);
    expect(info["supportedProtocolVersions"]).toEqual([1, 2]);
  });

  // #2
  it("request roundtrip: writes correct prompt frame and resolves on matching response", async () => {
    const rpc = new OmpRpcClient(transport);
    transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    await rpc.waitReady();

    const responsePromise = rpc.request({ type: "prompt", message: "hello" });
    const frame = transport.lastWritten();
    expect(frame["type"]).toBe("prompt");
    expect(frame["message"]).toBe("hello");

    transport.feed(JSON.stringify({
      type: "response",
      command: "prompt",
      success: true,
      data: { ok: true },
    }));

    const data = await responsePromise;
    expect(data).toEqual({ ok: true });
  });

  // #3
  it("rejects with Error(error) when response.success=false", async () => {
    const rpc = new OmpRpcClient(transport);
    transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    await rpc.waitReady();

    const promise = rpc.request({ type: "prompt", message: "x" });
    transport.feed(JSON.stringify({
      type: "response",
      command: "prompt",
      success: false,
      error: "boom",
    }));

    await expect(promise).rejects.toThrow("boom");
  });

  // #4
  it("serializes requests 1-in-flight: 2nd write waits for 1st response", async () => {
    const rpc = new OmpRpcClient(transport);
    transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    await rpc.waitReady();

    const p1 = rpc.request({ type: "prompt", message: "first" });
    expect(transport.written.length).toBe(1);

    const p2 = rpc.request({ type: "abort" });
    expect(transport.written.length).toBe(1);

    transport.feed(JSON.stringify({
      type: "response",
      command: "prompt",
      success: true,
      data: {},
    }));
    await p1;
    expect(transport.written.length).toBe(2);
    const second = transport.allWritten()[1];
    expect(second["type"]).toBe("abort");

    transport.feed(JSON.stringify({
      type: "response",
      command: "abort",
      success: true,
      data: {},
    }));
    await p2;
  });

  // #5
  it("ignores malformed lines and pending request stays pending", async () => {
    const rpc = new OmpRpcClient(transport);
    transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    await rpc.waitReady();

    const { promise, resolve, resolved } = Promise.withResolvers<Record<string, unknown>>();
    let done = false;
    void rpc.request({ type: "prompt", message: "x" }).then((d) => {
      done = true;
      resolve(d);
    });

    transport.feed("garbage{");
    await flushMicrotasks();
    expect(done).toBe(false);

    transport.feed(JSON.stringify({
      type: "response",
      command: "prompt",
      success: true,
      data: { ok: 1 },
    }));
    const result = await promise;
    expect(result).toEqual({ ok: 1 });
    expect(done).toBe(true);
    void resolved;
  });

  // #6
  it("handleHostToolCall: invokes handler with {id, toolName, arguments}; writes host_tool_result with content-array shape", async () => {
    const rpc = new OmpRpcClient(transport);
    transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    await rpc.waitReady();

    const seen: Array<{ id: string; toolName: string; arguments: unknown }> = [];
    rpc.handleHostToolCall(async (call) => {
      seen.push(call);
      return "done";
    });

    transport.feed(JSON.stringify({
      type: "host_tool_call",
      id: "call-1",
      toolName: "lookup",
      arguments: { q: "x" },
    }));

    await flushMicrotasks();

    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({ id: "call-1", toolName: "lookup", arguments: { q: "x" } });

    expect(transport.written.length).toBe(1);
    const frame = transport.lastWritten();
    expect(frame["type"]).toBe("host_tool_result");
    expect(frame["id"]).toBe("call-1");
    expect(frame["isError"]).toBe(false);
    expect(frame["result"]).toEqual({ content: [{ type: "text", text: "done" }] });
  });

  // #7
  it("handleHostToolCall: handler throws → isError=true, text 'Tool failed: ...'", async () => {
    const rpc = new OmpRpcClient(transport);
    transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    await rpc.waitReady();

    rpc.handleHostToolCall(async () => {
      throw new Error("kaboom");
    });

    transport.feed(JSON.stringify({
      type: "host_tool_call",
      id: "call-2",
      toolName: "broken",
      arguments: {},
    }));

    await flushMicrotasks();

    const frame = transport.lastWritten();
    expect(frame["type"]).toBe("host_tool_result");
    expect(frame["id"]).toBe("call-2");
    expect(frame["isError"]).toBe(true);
    expect(frame["result"]).toEqual({ content: [{ type: "text", text: "Tool failed: kaboom" }] });
  });
});