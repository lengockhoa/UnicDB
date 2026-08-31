// src/ai/omp/__tests__/ompChatEngine.test.ts
//
// RED tests for src/ai/omp/ompChatEngine.ts (cycle AE TASK-002).
//
// These tests pin the chat-level glue that sits on top of an `omp` ACP session
// and the in-process HostMcp server. They mock both `./acp` (acp session API)
// and `./hostMcp` (the MCP HTTP bridge), exercising the event surface
// OmpChatEngine must emit (onDelta / onThought / onToolStart / onToolEnd /
// onError / onDone) and the JSON-RPC frames OmpChatEngine must write to the
// running omp child.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Type contracts (mirrors of the production surfaces) ------------------

import type { AcpSession } from "../ompChatEngine";
import type { HostMcp } from "../ompChatEngine";

// ---- Mocks ----------------------------------------------------------------

const fakeAcp: AcpSession = {
  sessionNew: vi.fn(),
  sessionPrompt: vi.fn(),
  sessionLoad: vi.fn(),
  onNotification: vi.fn(),
  onClose: vi.fn(),
  dispose: vi.fn(),
  notify: vi.fn(),
};

const fakeHostMcp: HostMcp = {
  port: 41234,
  url: "http://127.0.0.1:41234",
  sessionId: "mcp-session-id",
  start: vi.fn(),
  stop: vi.fn(),
  call: vi.fn(),
};

vi.mock("../acp", async () => {
  const actual = await vi.importActual<typeof import("../acp")>("../acp");
  return {
    ...actual,
    createAcpSession: () => fakeAcp,
  };
});

vi.mock("../hostMcp", () => ({
  createHostMcp: () => fakeHostMcp,
}));

import { createOmpChatEngine, type OmpChatEngine } from "../ompChatEngine";

beforeEach(() => {
  fakeAcp.sessionNew.mockReset();
  fakeAcp.sessionPrompt.mockReset();
  fakeAcp.sessionLoad.mockReset();
  fakeAcp.onNotification.mockReset();
  fakeAcp.onClose.mockReset();
  fakeAcp.dispose.mockReset();
  fakeAcp.notify.mockReset();
  fakeHostMcp.call.mockReset();
});

/** Drain microtasks until the queue is empty (no real wall-clock delay). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// Capture notification handlers registered by the engine.
function registeredNotificationHandler(): (n: {
    method: string;
    params: unknown;
  }) => void {
  expect(fakeAcp.onNotification).toHaveBeenCalledTimes(1);
  return fakeAcp.onNotification.mock.calls[0][0] as (
    n: { method: string; params: unknown },
  ) => void;
}

// ---- Tests ----------------------------------------------------------------

describe("OmpChatEngine.send", () => {
  it("spawns session/new with the in-process MCP server URL, then issues session/prompt with the user text", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-1" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const engine: OmpChatEngine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onDone = vi.fn();
    await engine.send("hello world", { onDone });

    expect(fakeAcp.sessionNew).toHaveBeenCalledTimes(1);
    expect(fakeAcp.sessionNew).toHaveBeenCalledWith({
      cwd: "/workspace",
      mcpServers: [
        {
          type: "http",
          name: "vsdb",
          url: "http://127.0.0.1:41234",
          headers: [],
        },
      ],
    });
    expect(fakeAcp.sessionPrompt).toHaveBeenCalledTimes(1);
    expect(fakeAcp.sessionPrompt).toHaveBeenCalledWith("sess-1", "hello world");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("forwards session/update agent_message_chunk → onDelta with the text", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-2" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onDelta = vi.fn();
    await engine.send("hi", {
      onDelta,
      onDone: () => {
        /* noop */
      },
    });

    const handler = registeredNotificationHandler();
    handler({
      method: "session/update",
      params: {
        sessionId: "sess-2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "streamed reply" },
        },
      },
    });

    expect(onDelta).toHaveBeenCalledWith("streamed reply");
  });

  it("forwards session/update agent_thought_chunk → onThought with the chunk", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-3" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onThought = vi.fn();
    await engine.send("hi", {
      onThought,
      onDone: () => {
        /* noop */
      },
    });

    const handler = registeredNotificationHandler();
    handler({
      method: "session/update",
      params: {
        sessionId: "sess-3",
        update: { sessionUpdate: "agent_thought_chunk", chunk: "reasoning" },
      },
    });

    expect(onThought).toHaveBeenCalledWith("reasoning");
  });

  it("forwards tool_call (toolCallStart) → hostMcp.call and fires onToolStart", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-4" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });
    fakeHostMcp.call.mockResolvedValue({ result: "tool-output", isError: false });

    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    await engine.send("hi", {
      onToolStart,
      onToolEnd,
      onDone: () => {
        /* noop */
      },
    });

    const handler = registeredNotificationHandler();
    handler({
      method: "session/update",
      params: {
        sessionId: "sess-4",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          name: "count_rows",
          args: { schema: "public", table: "users" },
        },
      },
    });

    // dispatchNotification is async (hostMcp.call returns a Promise);
    // wait for the microtask queue to drain before asserting onToolEnd.
    await flushMicrotasks();

    expect(onToolStart).toHaveBeenCalledWith("count_rows");
    expect(fakeHostMcp.call).toHaveBeenCalledWith("count_rows", {
      schema: "public",
      table: "users",
    });
    expect(onToolEnd).toHaveBeenCalledWith("count_rows", "tool-output", false);
  });

  it("forwards tool_call_update (toolCallEnd) → onToolEnd with the latest result and isError", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-5" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });
    fakeHostMcp.call.mockResolvedValue({ result: "denied", isError: true });

    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    await engine.send("hi", {
      onToolStart,
      onToolEnd,
      onDone: () => {
        /* noop */
      },
    });

    const handler = registeredNotificationHandler();
    handler({
      method: "session/update",
      params: {
        sessionId: "sess-5",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          name: "count_rows",
          result: "denied",
          isError: true,
        },
      },
    });

    expect(onToolStart).not.toHaveBeenCalled();
    expect(onToolEnd).toHaveBeenCalledWith("count_rows", "denied", true);
  });

  it("crash mid-turn → onError fires once, send resolves (does not throw)", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-6" });
    fakeAcp.sessionPrompt.mockRejectedValue(new Error("omp crashed"));

    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onError = vi.fn();
    const onDone = vi.fn();
    await expect(
      engine.send("hi", {
        onError,
        onDone,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/crashed/);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("OmpChatEngine.resume", () => {
  it("calls sessionLoad with the sessionId, replays notifications through the registered handler", async () => {
    fakeAcp.sessionLoad.mockResolvedValue({
      sessionId: "resumed-1",
      replay: { notifications: [], closed: true },
    });

    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });

    const onDone = vi.fn();
    await engine.resume("orig-7", { onDone });

    expect(fakeAcp.sessionLoad).toHaveBeenCalledTimes(1);
    expect(fakeAcp.sessionLoad).toHaveBeenCalledWith(
      "orig-7",
      "/workspace",
      expect.arrayContaining([
        expect.objectContaining({
          type: "http",
          name: "vsdb",
          url: "http://127.0.0.1:41234",
        }),
      ]),
    );
  });
});
// ---- AIX-05: cancel() contract ---------------------------------------------

// ---- AIX-05: dispatchNotification robustness --------------------------------

describe("dispatchNotification (AIX-05 protocol robustness)", () => {
  it("drop unknown method without throwing; turn still streams next valid frame", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-robust-1" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const deltas: string[] = [];
    await engine.send("hi", { onDelta: (d) => deltas.push(d) });
    const handler = registeredNotificationHandler();
    // Unknown method — must be dropped.
    expect(() =>
      handler({ method: "totally/unknown", params: { whatever: 1 } }),
    ).not.toThrow();
    // Malformed params (null) — must be dropped.
    expect(() => handler({ method: "session/update", params: null })).not.toThrow();
    // Valid frame after the malformed ones — must still stream.
    handler({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "still alive" },
        },
      },
    });
    expect(deltas).toContain("still alive");
  });

  it("tool_call without name does not call hostMcp; does not throw", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-robust-2" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const toolStarts: string[] = [];
    await engine.send("hi", { onToolStart: (n) => toolStarts.push(n) });
    const handler = registeredNotificationHandler();
    handler({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1" } },
    });
    expect(fakeHostMcp.call).not.toHaveBeenCalled();
    expect(toolStarts).toHaveLength(0);
  });

  it("tool_call_update without toolCallId is dropped (no orphan onToolEnd)", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-robust-3" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const toolEnds: Array<{ name: string; result: string; isError: boolean }> = [];
    await engine.send("hi", {
      onToolEnd: (n, r, e) => toolEnds.push({ name: n, result: r, isError: e }),
    });
    const handler = registeredNotificationHandler();
    handler({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call_update", name: "orphan", result: "x" },
      },
    });
    expect(toolEnds).toHaveLength(0);
  });
});

describe("OmpChatEngine.cancel (AIX-05)", () => {
  it("sends session/cancel with the active sessionId mid-turn", async () => {
    let resolvePrompt: (v: { stopReason?: string }) => void = () => undefined;
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-cancel-1" });
    fakeAcp.sessionPrompt.mockImplementation(
      () => new Promise<{ stopReason?: string }>((res) => {
        resolvePrompt = res;
      }),
    );
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const sendPromise = engine.send("hi", {});
    await flushMicrotasks();
    engine.cancel();
    expect(fakeAcp.notify).toHaveBeenCalledTimes(1);
    expect(fakeAcp.notify).toHaveBeenCalledWith("session/cancel", {
      sessionId: "sess-cancel-1",
    });
    resolvePrompt({ stopReason: "end_turn" });
    await sendPromise;
  });

  it("double-cancel sends exactly one notify per turn (idempotent)", async () => {
    let resolvePrompt: (v: { stopReason?: string }) => void = () => undefined;
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-cancel-2" });
    fakeAcp.sessionPrompt.mockImplementation(
      () => new Promise<{ stopReason?: string }>((res) => {
        resolvePrompt = res;
      }),
    );
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const sendPromise = engine.send("hi", {});
    await flushMicrotasks();
    engine.cancel();
    engine.cancel();
    engine.cancel();
    expect(fakeAcp.notify).toHaveBeenCalledTimes(1);
    resolvePrompt({ stopReason: "end_turn" });
    await sendPromise;
  });

  it("no-op when no turn is in flight", () => {
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    engine.cancel();
    expect(fakeAcp.notify).not.toHaveBeenCalled();
  });

  it("send → cancel → send creates a fresh session (no reuse of cancelled id)", async () => {
    fakeAcp.sessionNew.mockResolvedValueOnce({ sessionId: "sess-A" });
    fakeAcp.sessionPrompt.mockImplementationOnce(() => Promise.resolve({ stopReason: "end_turn" }));
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    await engine.send("hi", {});
    expect(fakeAcp.sessionNew).toHaveBeenCalledTimes(1);
    expect(fakeAcp.notify).not.toHaveBeenCalled();

    // Second turn: arrange a new pending prompt so cancel addresses sess-B.
    let resolveSecond: (v: { stopReason?: string }) => void = () => undefined;
    fakeAcp.sessionNew.mockResolvedValueOnce({ sessionId: "sess-B" });
    fakeAcp.sessionPrompt.mockImplementationOnce(
      () => new Promise<{ stopReason?: string }>((res) => {
        resolveSecond = res;
      }),
    );
    const second = engine.send("next", {});
    await flushMicrotasks();
    engine.cancel();
    expect(fakeAcp.notify).toHaveBeenLastCalledWith("session/cancel", {
      sessionId: "sess-B",
    });
    resolveSecond({ stopReason: "end_turn" });
    await second;
    expect(fakeAcp.sessionNew).toHaveBeenCalledTimes(2);
  });

  it("crash mid-turn clears currentSessionId so the next send opens a fresh session", async () => {
    fakeAcp.sessionNew.mockResolvedValueOnce({ sessionId: "sess-X" });
    fakeAcp.sessionPrompt.mockImplementationOnce(() =>
      Promise.reject(new Error("crash")),
    );
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    await engine.send("first", { onError: () => undefined });
    // After crash, no active session — cancel must be a no-op.
    engine.cancel();
    expect(fakeAcp.notify).not.toHaveBeenCalled();
    // Next send opens a fresh session.
    fakeAcp.sessionNew.mockResolvedValueOnce({ sessionId: "sess-Y" });
    fakeAcp.sessionPrompt.mockImplementationOnce(() =>
      Promise.resolve({ stopReason: "end_turn" }),
    );
    await engine.send("second", {});
    expect(fakeAcp.sessionNew).toHaveBeenCalledTimes(2);
    expect(fakeAcp.sessionNew.mock.calls[1]?.[0]?.cwd).toBe("/workspace");
  });

  it("cancel() called while session/new is pending fires notify with the sessionId returned by session/new", async () => {
    let resolveNew: (v: { sessionId: string }) => void = () => undefined;
    fakeAcp.sessionNew.mockImplementation(
      () => new Promise<{ sessionId: string }>((res) => {
        resolveNew = res;
      }),
    );
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const errors: string[] = [];
    const sendPromise = engine.send("hi", { onError: (m) => errors.push(m) });
    // cancel BEFORE session/new resolves.
    engine.cancel();
    expect(fakeAcp.notify).not.toHaveBeenCalled();
    // Now resolve session/new — pending cancel drains as a notify.
    resolveNew({ sessionId: "sess-pending-1" });
    await flushMicrotasks();
    expect(fakeAcp.notify).toHaveBeenCalledTimes(1);
    expect(fakeAcp.notify).toHaveBeenCalledWith("session/cancel", {
      sessionId: "sess-pending-1",
    });
    await sendPromise;
  });

  it("idle cancel() (no turn) is a true no-op and does NOT cancel the next send", async () => {
    fakeAcp.sessionNew.mockResolvedValue({ sessionId: "sess-idle" });
    fakeAcp.sessionPrompt.mockResolvedValue({ stopReason: "end_turn" });
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    // Cancel with no turn in flight — must NOT set pendingCancel.
    engine.cancel();
    expect(fakeAcp.notify).not.toHaveBeenCalled();
    // Next send should run to completion.
    await engine.send("hi", {});
    expect(fakeAcp.sessionPrompt).toHaveBeenCalledTimes(1);
    expect(fakeAcp.sessionPrompt).toHaveBeenCalledWith("sess-idle", "hi");
    expect(fakeAcp.notify).not.toHaveBeenCalled();
  });

  it("after pendingCancel drains, a subsequent cancel() is a no-op (no duplicate notify)", async () => {
    let resolveNew: (v: { sessionId: string }) => void = () => undefined;
    fakeAcp.sessionNew.mockImplementation(
      () => new Promise<{ sessionId: string }>((res) => {
        resolveNew = res;
      }),
    );
    const engine = createOmpChatEngine({
      acp: fakeAcp,
      hostMcp: fakeHostMcp,
      cwd: "/workspace",
    });
    const sendPromise = engine.send("hi", { onError: () => undefined });
    engine.cancel(); // sets pendingCancel
    resolveNew({ sessionId: "sess-pending-2" });
    await flushMicrotasks();
    // First notify fired by drain.
    expect(fakeAcp.notify).toHaveBeenCalledTimes(1);
    // A second cancel() with no active turn must NOT notify again.
    engine.cancel();
    expect(fakeAcp.notify).toHaveBeenCalledTimes(1);
    await sendPromise;
  });
});
