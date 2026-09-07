// src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts
// TDD tests for src/ai/claudeCode/claudeCodeChatEngine.ts — TASK-009.
//
// Chat-level glue that adapts a TASK-005 `ClaudeCodeProcessHandle` to the
// panel's seven-callback event surface. Injectable process + HostMcp let
// tests assert: input wiring, callback ordering, error/dedupe, base64 redaction,
// lifecycle idempotency, and the unsupported-resume contract.

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createClaudeCodeChatEngine,
  type ClaudeCodeChatEngine,
  type ClaudeCodeChatEngineOptions,
  type ClaudeCodeChatEvents,
} from "../claudeCodeChatEngine";
import type {
  ClaudeCodeProcessEvents,
  ClaudeCodeProcessHandle,
  ClaudeCodeTurnInput,
} from "../claudeCodeProcess";

// ---- Fakes ------------------------------------------------------------------

/**
 * Callback collector — records the order in which each chat-level callback
 * fired so test #1 (ordering) and test #4 (error-once, no-done) can assert
 * exact sequences. `withTrace: true` opts in to `onTrace` subscription
 * (default off so test #1's order assertion is a clean callback sequence).
 */
function createCollector(opts?: { withTrace?: boolean }): ClaudeCodeChatEvents & {
  order: string[];
  errors: string[];
  deltas: string[];
  thoughts: string[];
  toolStarts: string[];
  toolEnds: Array<{ name: string; result: string; isError: boolean }>;
  traces: Array<{ kind: string; payload: unknown }>;
} {
  const order: string[] = [];
  const errors: string[] = [];
  const deltas: string[] = [];
  const thoughts: string[] = [];
  const toolStarts: string[] = [];
  const toolEnds: Array<{ name: string; result: string; isError: boolean }> = [];
  const traces: Array<{ kind: string; payload: unknown }> = [];

  const events: ClaudeCodeChatEvents = {
    onDelta: (d) => {
      order.push("onDelta");
      deltas.push(d);
    },
    onThought: (c) => {
      order.push("onThought");
      thoughts.push(c);
    },
    onToolStart: (name) => {
      order.push("onToolStart");
      toolStarts.push(name);
    },
    onToolEnd: (name, result, isError) => {
      order.push("onToolEnd");
      toolEnds.push({ name, result, isError });
    },
    onError: (message) => {
      order.push("onError");
      errors.push(message);
    },
    onDone: () => {
      order.push("onDone");
    },
  };
  if (opts?.withTrace) {
    events.onTrace = (event) => {
      order.push("onTrace");
      traces.push({ kind: event.kind, payload: event.payload });
    };
  }
  return Object.assign(events, {
    order,
    errors,
    deltas,
    thoughts,
    toolStarts,
    toolEnds,
    traces,
  });
}

/** Minimal stand-in for the process handle. `emit` lets each test compose
 *  the event sequence the fake fires during `send`. */
interface FakeProcess {
  receivedInputs: ClaudeCodeTurnInput[];
  receivedEvents: ClaudeCodeProcessEvents[];
  send: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>;
  getStderrTail: ReturnType<typeof vi.fn>;
}

function createFakeProcess(emit?: (evts: ClaudeCodeProcessEvents) => void): FakeProcess {
  const receivedInputs: ClaudeCodeTurnInput[] = [];
  const receivedEvents: ClaudeCodeProcessEvents[] = [];
  const send = vi.fn(async (input: ClaudeCodeTurnInput, evts: ClaudeCodeProcessEvents) => {
    receivedInputs.push(input);
    receivedEvents.push(evts);
    if (emit) emit(evts);
  });
  const fake: FakeProcess = {
    receivedInputs,
    receivedEvents,
    send,
    cancel: vi.fn(),
    dispose: vi.fn(async () => {
      /* no-op */
    }),
    state: vi.fn(() => "ready" as const),
    getStderrTail: vi.fn(() => ""),
  };
  return fake;
}

/** Minimal stand-in for the in-process MCP server. */
interface FakeHostMcp {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function createFakeHostMcp(): FakeHostMcp {
  return {
    start: vi.fn(async () => {
      /* no-op */
    }),
    stop: vi.fn(async () => {
      /* no-op */
    }),
  };
}

function makeEngine(
  proc: FakeProcess,
  hostMcp: FakeHostMcp,
  extra?: Partial<ClaudeCodeChatEngineOptions>,
): ClaudeCodeChatEngine {
  return createClaudeCodeChatEngine({
    process: proc as unknown as ClaudeCodeProcessHandle,
    hostMcp: hostMcp as unknown as ClaudeCodeChatEngineOptions["hostMcp"],
    ...extra,
  });
}

// ---- Tests ------------------------------------------------------------------

describe("createClaudeCodeChatEngine — TASK-009", () => {
  let proc: FakeProcess;
  let hostMcp: FakeHostMcp;

  beforeEach(() => {
    proc = createFakeProcess();
    hostMcp = createFakeHostMcp();
  });

  // Case #1 — happy: send text creates a turn and forwards every callback in order
  it("send text creates a turn and forwards every normalized callback in order", async () => {
    // Rebuild the fake with an `emit` callback so the default `send` keeps
    // its receivedInputs push (mockImplementationOnce would shadow that
    // side-effect). This fires the full sequence: text delta → thought →
    // tool start → tool end → done.
    proc = createFakeProcess((evts) => {
      evts.onDelta?.("listing ");
      evts.onThought?.("thinking");
      evts.onToolStart?.("Bash");
      evts.onToolEnd?.("Bash", "ok", false);
      evts.onDone?.();
    });

    const events = createCollector();
    const engine = makeEngine(proc, hostMcp);

    await engine.send("list tables", events);

    // The process received the text exactly.
    expect(proc.receivedInputs).toHaveLength(1);
    expect(proc.receivedInputs[0]?.text).toBe("list tables");

    // Every callback landed in the documented order.
    expect(events.order).toEqual([
      "onDelta",
      "onThought",
      "onToolStart",
      "onToolEnd",
      "onDone",
    ]);
    expect(events.deltas).toEqual(["listing "]);
    expect(events.thoughts).toEqual(["thinking"]);
    expect(events.toolStarts).toEqual(["Bash"]);
    expect(events.toolEnds).toEqual([{ name: "Bash", result: "ok", isError: false }]);
    expect(events.errors).toEqual([]);
  });

  // Case #2 — edge (empty): no attachments → process input has `attachments: undefined`
  it("send with no attachments forwards `attachments: undefined` (never an empty array)", async () => {
    const events = createCollector();
    const engine = makeEngine(proc, hostMcp);

    // Two flavours of "no attachments" must both end up as `undefined` on the
    // wire so the TASK-005 process emits the legacy text-only stream-json frame.
    await engine.send("hello", events);

    expect(proc.receivedInputs).toHaveLength(1);
    const input = proc.receivedInputs[0]!;
    expect(input.text).toBe("hello");
    // Strict: `undefined`, not `[]`. An empty array would push the process
    // through the image branch and emit a malformed JSON frame.
    expect("attachments" in input ? input.attachments : undefined).toBeUndefined();

    // Also verify the explicit empty-array path lands on the same shape.
    await engine.send("again", events, []);
    expect(proc.receivedInputs).toHaveLength(2);
    const input2 = proc.receivedInputs[1]!;
    expect("attachments" in input2 ? input2.attachments : undefined).toBeUndefined();
    expect(input2.text).toBe("again");
  });

  // Case #3 — edge (image boundary): image + text retains binary fields; no base64 in trace
  it("send with an image attachment forwards text + image block; no base64 ever appears in trace or error", async () => {
    // A recognisable long base64 payload — if it ever leaks, the test fails
    // immediately. Length is well over the redact() 24-char long-run threshold.
    const SECRET_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const events = createCollector({ withTrace: true });
    const engine = makeEngine(proc, hostMcp);

    await engine.send(
      "What is in this PNG?",
      events,
      [{ mime: "image/png", base64: SECRET_BASE64 }],
    );

    // The process received both blocks in order.
    expect(proc.receivedInputs).toHaveLength(1);
    const input = proc.receivedInputs[0]!;
    expect(input.text).toBe("What is in this PNG?");
    expect(input.attachments).toEqual([{ mime: "image/png", base64: SECRET_BASE64 }]);
    expect(input.attachments?.[0]?.base64).toBe(SECRET_BASE64);

    // No error fired for a successful image turn.
    expect(events.errors).toEqual([]);

    // CRITICAL: no trace payload, anywhere in the turn, contains the base64
    // string in full. The chat engine never serialises attachments into
    // trace payloads; redact() is the second line of defence.
    const blob = JSON.stringify(events.traces);
    expect(blob).not.toContain(SECRET_BASE64);
  });

  // Case #4 — edge (error path): process reports error → onError exactly once, no onDone
  it("process error fires onError exactly once; onDone does NOT follow unless the process contract emits it", async () => {
    // Two flavours of error path:
    //   (a) process fires onError and resolves — no onDone.
    //   (b) process fires onError twice (some upstream paths do this) — engine
    //       must dedupe so the panel sees exactly one error bubble.
    proc.send.mockImplementationOnce(async (_input, evts) => {
      evts.onError?.("claude failed: exit code 1");
    });

    const events = createCollector();
    const engine = makeEngine(proc, hostMcp);

    await engine.send("anything", events);

    expect(events.errors).toEqual(["claude failed: exit code 1"]);
    // The process contract: error path does NOT emit onDone. The engine
    // forwards exactly what the process emits and never invents onDone.
    expect(events.order).not.toContain("onDone");

    // Case (b): a second turn where the process double-fires onError. The
    // engine must collapse to a single bubble for the panel.
    proc.send.mockImplementationOnce(async (_input, evts) => {
      evts.onError?.("first");
      evts.onError?.("second");
    });

    const events2 = createCollector();
    await engine.send("anything2", events2);

    expect(events2.errors).toEqual(["first"]);
    expect(events2.order).not.toContain("onDone");
  });

  // Case #5 — edge (lifecycle): dispose twice is idempotent; send after dispose is a no-spawn error
  it("dispose is idempotent and stops hostMcp + process exactly once each; send after dispose fires a deterministic onError with no spawn", async () => {
    const events = createCollector();
    const engine = makeEngine(proc, hostMcp);

    // First dispose — both teardown hooks fire exactly once.
    await engine.dispose();
    expect(hostMcp.stop).toHaveBeenCalledTimes(1);
    expect(proc.dispose).toHaveBeenCalledTimes(1);

    // Second dispose — still exactly once each. Idempotent contract.
    await engine.dispose();
    expect(hostMcp.stop).toHaveBeenCalledTimes(1);
    expect(proc.dispose).toHaveBeenCalledTimes(1);

    // Send after dispose: deterministic disposed message, no spawn.
    proc.send.mockClear();
    hostMcp.start.mockClear();
    const eventsAfter = createCollector();
    await engine.send("hello", eventsAfter);

    expect(eventsAfter.errors).toHaveLength(1);
    expect(eventsAfter.errors[0]).toBe("claude code chat engine is disposed");
    // No spawn, no hostMcp.start — the engine refused without doing any work.
    expect(proc.send).not.toHaveBeenCalled();
    expect(hostMcp.start).not.toHaveBeenCalled();
    // The post-dispose send must not settle with onDone.
    expect(eventsAfter.order).not.toContain("onDone");
  });

  // Case #6 — edge (resume): TASK-005 did not verify --resume, so the engine
  // surfaces a deterministic unsupported error without spawning a child.
  it("resume fires onError('Claude Code session resume is unavailable') without spawning a child", async () => {
    const events = createCollector();
    const engine = makeEngine(proc, hostMcp);

    await engine.resume("any-session-id", events);

    expect(events.errors).toEqual(["Claude Code session resume is unavailable"]);
    // Hard guarantee: no spawn, no hostMcp.start — the engine refused to
    // gamble on an unverified CLI flag.
    expect(proc.send).not.toHaveBeenCalled();
    expect(hostMcp.start).not.toHaveBeenCalled();
  });

  // Case #7 — bonus: lifecycle ordering — hostMcp.start runs BEFORE process.send
  it("send awaits hostMcp.start() BEFORE calling process.send", async () => {
    const order: string[] = [];
    hostMcp.start.mockImplementationOnce(async () => {
      order.push("hostMcp.start");
    });
    proc.send.mockImplementationOnce(async (_input, _evts) => {
      order.push("process.send");
    });

    const engine = makeEngine(proc, hostMcp);
    await engine.send("hi", createCollector());

    expect(order).toEqual(["hostMcp.start", "process.send"]);
  });
});
