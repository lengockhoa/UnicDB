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