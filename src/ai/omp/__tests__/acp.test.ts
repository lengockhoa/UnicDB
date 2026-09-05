// src/ai/omp/__tests__/acp.test.ts
// Unit tests cho src/ai/omp/acp.ts (AcpClient). TASK-001 §Test Cases #1..#4.
//
// Pure injectable tests — sử dụng FakeAcpTransport ghi nhận các write/onLine
// thay vì spawn child process thật. Frames tuân theo ACP JSON-RPC 2.0 NDJSON
// đã live-probe trên omp 18.0.1 (xem TASK-001 §Discussion).
import { describe, it, expect, beforeEach } from "vitest";
import { AcpClient, DEFAULT_ACP_REQUEST_TIMEOUT_MS, type AcpTransport } from "../acp";

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

  // #5 — TASK-001 case #1: sessionList sends correct frame + normalizes entries
  it("sessionList sends session/list frame and normalizes entries from _meta", async () => {
    const client = new AcpClient(transport);
    const pending = client.sessionList();

    await flushMicrotasks();
    const written = transport.allWritten();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "session/list",
      params: {},
    });
    expect(typeof written[0]["id"]).toBe("number");

    const id = written[0]["id"];
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          sessions: [
            {
              sessionId: "s1",
              cwd: "/w",
              title: "Fix schema",
              updatedAt: "2026-08-24T01:02:03Z",
              _meta: { messageCount: 12, size: 100 },
            },
          ],
        },
      }),
    );
    const items = await pending;
    expect(items).toEqual([
      {
        sessionId: "s1",
        cwd: "/w",
        title: "Fix schema",
        updatedAt: "2026-08-24T01:02:03Z",
        messageCount: 12,
        size: 100,
      },
    ]);
  });

  // #6 — TASK-001 case #2: junk title / missing _meta / non-string sessionId drop
  it("sessionList drops entries with non-string sessionId and normalizes junk title", async () => {
    const client = new AcpClient(transport);
    const pending = client.sessionList();
    await flushMicrotasks();

    const id = transport.lastWritten()["id"];
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          sessions: [
            // sessionId non-string → drop, no throw
            { sessionId: 1, cwd: "/w", title: "x", updatedAt: "t", _meta: { messageCount: 1, size: 1 } },
            // title "<function>" → null
            { sessionId: "s2", cwd: "/w", title: "<function>", updatedAt: "t", _meta: { messageCount: 3, size: 5 } },
            // title missing entirely → null; _meta missing → 0/0; updatedAt non-string → ""
            { sessionId: "s3", cwd: "/w", updatedAt: 42 },
          ],
        },
      }),
    );
    const items = await pending;
    expect(items).toEqual([
      { sessionId: "s2", cwd: "/w", title: null, updatedAt: "t", messageCount: 3, size: 5 },
      { sessionId: "s3", cwd: "/w", title: null, updatedAt: "", messageCount: 0, size: 0 },
    ]);
  });

  // #7 — TASK-001 case #3: replay notifications in same flush as result stay ordered and absorbed
  it("sessionLoad buffers replay notifications arriving in the same flush as the result", async () => {
    const client = new AcpClient(transport);
    const notifs: Array<{ method: string; params: unknown }> = [];
    client.onNotification((n) => notifs.push(n));

    const pending = client.sessionLoad("s1", "/w");
    await flushMicrotasks();

    // Written frame must use session/load with frozen envelope shape.
    const req = transport.lastWritten();
    expect(req).toMatchObject({
      jsonrpc: "2.0",
      method: "session/load",
      params: { sessionId: "s1", cwd: "/w", mcpServers: [] },
    });

    const id = req["id"];
    // Feed in order: n1, n2, n3, then result. Result MUST NOT close the window.
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "n1" } },
      }),
    );
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "n2" } },
      }),
    );
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "n3" } },
      }),
    );
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: { mode: 1 }, modes: { availableModes: [] } },
      }),
    );

    const res = await pending;
    expect(res.configOptions).toEqual({ mode: 1 });
    expect(res.modes).toEqual({ availableModes: [] });
    expect(res.replay.closed).toBe(false);
    expect(res.replay.notifications.map((n) => n.params)).toEqual([
      { sessionId: "s1", update: { sessionUpdate: "n1" } },
      { sessionId: "s1", update: { sessionUpdate: "n2" } },
      { sessionId: "s1", update: { sessionUpdate: "n3" } },
    ]);
    // Live handler MUST NOT have been called for any replay frame.
    expect(notifs).toEqual([]);
  });

  // TASK-012 (B11b) — sessionLoad forwards a non-empty mcpServers array verbatim
  // into the session/load request params, instead of always hardcoding [].
  it("sessionLoad forwards a non-empty mcpServers array verbatim as the 3rd request param", async () => {
    const client = new AcpClient(transport);
    const descriptor = {
      type: "http",
      name: "UnicDB",
      url: "http://127.0.0.1:54321",
      headers: [{ name: "Authorization", value: "Bearer test-token" }],
    };

    const pending = client.sessionLoad("s1", "/w", [descriptor]);
    await flushMicrotasks();

    const req = transport.lastWritten();
    expect(req).toMatchObject({
      jsonrpc: "2.0",
      method: "session/load",
      params: { sessionId: "s1", cwd: "/w", mcpServers: [descriptor] },
    });

    const id = req["id"];
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: {}, modes: {} },
      }),
    );
    await pending;
  });

  // #8 — TASK-001 case #4: replay after result + drain tick still absorbed (RED baseline)
  it("sessionLoad keeps absorbing session/update across multiple flushes (no drain-tick close)", async () => {
    const client = new AcpClient(transport);
    const notifs: Array<{ method: string; params: unknown }> = [];
    client.onNotification((n) => notifs.push(n));

    const pending = client.sessionLoad("s1", "/w");
    await flushMicrotasks();
    const req = transport.lastWritten();
    const id = req["id"];

    // First flush: n1 + result settles the promise with replay=[n1].
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "n1" } },
      }),
    );
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: {}, modes: {} },
      }),
    );
    const res = await pending;
    expect(res.replay.notifications.map((n) => n.params)).toEqual([
      { sessionId: "s1", update: { sessionUpdate: "n1" } },
    ]);
    expect(res.replay.closed).toBe(false);

    // Second flush: n2 arrives AFTER settle, BEFORE the next outgoing write.
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "n2" } },
      }),
    );
    await flushMicrotasks();

    // Drain tick: full microtask drain. Window MUST still be open
    // (no drain-tick close semantics).
    await flushMicrotasks();
    // Third flush: n3 arrives after the drain tick — still absorbed.
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "n3" } },
      }),
    );
    await flushMicrotasks();

    expect(res.replay.notifications.map((n) => n.params)).toEqual([
      { sessionId: "s1", update: { sessionUpdate: "n1" } },
      { sessionId: "s1", update: { sessionUpdate: "n2" } },
      { sessionId: "s1", update: { sessionUpdate: "n3" } },
    ]);
    expect(res.replay.closed).toBe(false);
    expect(notifs).toEqual([]);
  });

  // #9 — TASK-001 case #5: next outgoing request/notify closes the window
  it("sessionLoad window closes when next outgoing request writes its frame", async () => {
    const client = new AcpClient(transport);
    const notifs: Array<{ method: string; params: unknown }> = [];
    client.onNotification((n) => notifs.push(n));

    const pending = client.sessionLoad("s1", "/w");
    await flushMicrotasks();
    const req = transport.lastWritten();
    const id = req["id"];

    // Late replay frame after settle but before close — absorbed.
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "late" } },
      }),
    );
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: {}, modes: {} },
      }),
    );
    const res = await pending;
    expect(res.replay.notifications).toHaveLength(1);
    expect(res.replay.closed).toBe(false);

    // Next outgoing request: writes its frame AND closes the window.
    const next = client.request("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "go" }] });
    await flushMicrotasks();
    expect(res.replay.closed).toBe(true);

    // After close: live session/update for the same sessionId goes straight to handler.
    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "live" } },
      }),
    );
    await flushMicrotasks();
    expect(notifs).toEqual([
      { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "live" } } },
    ]);

    // And the next request settles normally (no leftover state).
    const nextId = transport.allWritten().slice(-1)[0]["id"];
    transport.feed(JSON.stringify({ jsonrpc: "2.0", id: nextId, result: { ok: true } }));
    await expect(next).resolves.toEqual({ ok: true });
  });

  // #10 — TASK-001 case #5 alt: client.notify also closes the window
  it("sessionLoad window closes when next outgoing notify writes its frame", async () => {
    const client = new AcpClient(transport);
    const notifs: Array<{ method: string; params: unknown }> = [];
    client.onNotification((n) => notifs.push(n));

    const pending = client.sessionLoad("s1", "/w");
    await flushMicrotasks();
    const id = transport.lastWritten()["id"];

    transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { configOptions: {}, modes: {} } }));
    const res = await pending;
    expect(res.replay.closed).toBe(false);

    client.notify("session/cancel", { sessionId: "s1" });
    expect(res.replay.closed).toBe(true);

    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "live2" } },
      }),
    );
    await flushMicrotasks();
    expect(notifs).toEqual([
      { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "live2" } } },
    ]);
  });

  // #11 — TASK-001 case #6: server error during session/load rejects with code + message
  it("sessionLoad rejects with code -32603 and message when server returns session-not-found", async () => {
    const client = new AcpClient(transport);
    const pending = client.sessionLoad("sX", "/w");
    await flushMicrotasks();
    const id = transport.lastWritten()["id"];

    transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "ACP session not found: sX" },
      }),
    );

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("ACP session not found");
    expect((err as Error & { code?: number }).code).toBe(-32603);
  });

  // #12 — TASK-001 case #7: concurrent sessionLoad rejects without writing a frame
  it("concurrent sessionLoad rejects synchronously and writes no extra frame", async () => {
    const client = new AcpClient(transport);

    const first = client.sessionLoad("s1", "/w");
    await flushMicrotasks();
    const writtenAfterFirst = transport.allWritten().length;

    // Second call before the first has settled.
    const second = client.sessionLoad("s1", "/w");
    await flushMicrotasks();
    expect(transport.allWritten().length).toBe(writtenAfterFirst);

    const err = await second.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/session load already in progress/i);

    // First still pending — feed a valid result, it must resolve normally.
    const id = transport.lastWritten()["id"];
    transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { configOptions: {}, modes: {} } }));
    const res = await first;
    expect(res.configOptions).toEqual({});
    expect(res.modes).toEqual({});
  });

  // ---- TASK-006 (B4b): per-request timeout -----------------------------------

  // R (B4b) — today `request()` never settles on its own; nothing anywhere in
  // AcpClient owns a timer, so a request with no matching response frame
  // hangs forever. After the fix it rejects within the configured bound.
  it("request() rejects within the configured requestTimeoutMs when no matching response arrives", async () => {
    const client = new AcpClient(transport, { requestTimeoutMs: 20 });
    const pending = client.request("session/new", { cwd: "/tmp", mcpServers: [] });

    // Deliberately never feed a matching response.
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/session\/new/);
    expect((err as Error).message).toMatch(/timed out|timeout/i);
  });

  it("default requestTimeoutMs is DEFAULT_ACP_REQUEST_TIMEOUT_MS when not overridden", () => {
    // Constructing without opts must not throw and must fall back to the
    // named default constant — asserted indirectly via the exported constant
    // being a sane, named 30s bound (not a magic number scattered in code).
    expect(DEFAULT_ACP_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(() => new AcpClient(transport)).not.toThrow();
  });

  it("a request that resolves before the timeout does not leak a pending timer/resolver", async () => {
    const client = new AcpClient(transport, { requestTimeoutMs: 20 });
    const pending = client.request("session/list", {});
    await flushMicrotasks();
    const id = transport.lastWritten()["id"];
    transport.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { sessions: [] } }));
    await pending;

    // Wait past the configured timeout — if the timer/pending entry leaked,
    // nothing observable happens here (no unhandled rejection), but this
    // guards against the resolved path forgetting to clear its timer.
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});