// src/ai/codex/__tests__/codexChatEngine.test.ts
//
// RED tests for src/ai/codex/codexChatEngine.ts (TASK-010).
//
// Pin the chat-level adapter that sits on top of TASK-006's
// `CodexProcessHandle`. Mirrors the OmpChatEngine shape (acceptance
// criterion 1 — panel consumes both engines through one set of callbacks),
// but stays independent of TASK-009 (no shared agent-engine abstraction
// introduced here — the OmpChatEngine shape is duplicated locally).
//
// Five tests from TASK-010 §Test Cases:
//   1. happy        — text send maps a complete Codex turn (all 7 callbacks)
//   2. edge empty   — text-only invocation does NOT create image payload
//   3. edge image   — multiple (up to 4) image attachments preserve order
//   4. edge error   — protocol/process error becomes one onError + settles
//   5. edge dispose — idempotent dispose; later send does not spawn

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createCodexChatEngine,
  type CodexChatEngine,
  type CodexChatEvents,
  type CodexProcessHandle,
  type CodexHostMcp,
} from "../codexChatEngine";
import { TraceRecorder } from "../../trace";

// ---------------------------------------------------------------------------
// Fake process handle — minimal surface for engine unit tests.
// ---------------------------------------------------------------------------

interface FakeProcessEvents {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
}

interface CapturedInput {
  text: string;
  attachments?: ReadonlyArray<{ mime: string; base64: string }>;
}

class FakeProcessHandle {
  public readonly disposeCalls: number[] = [];
  public readonly cancelCalls: number[] = [];
  public capturedInput: CapturedInput | undefined;
  private events: FakeProcessEvents | undefined;
  /** Set true to have .send() reject (test 4). */
  private rejectMode: { message: string } | undefined;
  /** Programmable sequence of emitters fired during .send(). */
  private script: Array<(ev: FakeProcessEvents) => void> = [];

  constructor(public readonly sessionId: string = "codex-sess-1") {}

  setReject(message: string): void {
    this.rejectMode = { message };
  }

  enqueue(fn: (ev: FakeProcessEvents) => void): void {
    this.script.push(fn);
  }

  state(): string {
    return "ready";
  }
  cancel(): void {
    this.cancelCalls.push(Date.now());
  }
  async dispose(): Promise<void> {
    this.disposeCalls.push(Date.now());
  }
  getStderrTail(): string {
    return "";
  }
  async send(
    input: { text: string; attachments?: ReadonlyArray<{ mime: string; base64: string }> },
    events: FakeProcessEvents,
  ): Promise<void> {
    // Capture the input the engine sent — this is the contract under test.
    this.capturedInput = {
      text: input.text,
      attachments: input.attachments,
    };
    this.events = events;
    if (this.rejectMode !== undefined) {
      throw new Error(this.rejectMode.message);
    }
    for (const step of this.script) {
      step(events);
    }
  }
}

// ---------------------------------------------------------------------------
// Fake HostMcp — minimal start/stop surface (the engine only touches those).
// ---------------------------------------------------------------------------

class FakeHostMcp {
  public startCalls = 0;
  public stopCalls = 0;
  /** When true, start() rejects with a known error. */
  public failStart = false;

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.failStart) throw new Error("hostmcp-start-fail");
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

// ---------------------------------------------------------------------------
// Fixture builder.
// ---------------------------------------------------------------------------

interface Harness {
  engine: CodexChatEngine;
  process: FakeProcessHandle;
  hostMcp: FakeHostMcp;
}

function makeHarness(opts?: {
  recorder?: TraceRecorder;
  rejectStart?: boolean;
  process?: FakeProcessHandle;
}): Harness {
  const process = opts?.process ?? new FakeProcessHandle();
  const hostMcp = new FakeHostMcp();
  if (opts?.rejectStart === true) hostMcp.failStart = true;
  const engine = createCodexChatEngine({
    createProcess: async () => process,
    hostMcp,
    trace: opts?.recorder,
  });
  return { engine, process, hostMcp };
}

/** Drain microtasks until the queue is empty (no real wall-clock delay). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexChatEngine.send (TASK-010 #1 happy)", () => {
  it("forwards a complete turn: text routed to process, all 7 callbacks fired in order", async () => {
    const rec = new TraceRecorder();
    const { engine, process } = makeHarness({ recorder: rec });

    const onDelta = vi.fn();
    const onThought = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    const onTrace = vi.fn();
    const events: CodexChatEvents = {
      onDelta,
      onThought,
      onToolStart,
      onToolEnd,
      onError,
      onDone,
      onTrace,
    };

    // Program the fake process to emit a complete turn.
    process.enqueue((ev) => ev.onDelta?.("alpha"));
    process.enqueue((ev) => ev.onDelta?.("beta"));
    process.enqueue((ev) => ev.onThought?.("reasoning"));
    process.enqueue((ev) => ev.onToolStart?.("count_rows"));
    process.enqueue((ev) => ev.onToolEnd?.("count_rows", "42", false));
    process.enqueue((ev) => ev.onDone?.());

    await engine.send("explain query", events);

    // 1. Input frame: text preserved, no attachment payload (this test is text-only).
    expect(process.capturedInput).toBeDefined();
    expect(process.capturedInput!.text).toBe("explain query");
    expect(process.capturedInput!.attachments).toBeUndefined();

    // 2. Process emit order → callback forward order.
    expect(onDelta.mock.calls.map((c) => c[0])).toEqual(["alpha", "beta"]);
    expect(onThought).toHaveBeenCalledWith("reasoning");
    expect(onToolStart).toHaveBeenCalledWith("count_rows");
    expect(onToolEnd).toHaveBeenCalledWith("count_rows", "42", false);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    // 3. Trace records every kind in order.
    const kinds = rec.events().map((e) => e.kind);
    expect(kinds).toEqual([
      "prompt",
      "delta",
      "delta",
      "thought",
      "tool_start",
      "tool_end",
      "done",
    ]);

    // 4. onTrace fires for every recorded event (7 callbacks total).
    expect(onTrace).toHaveBeenCalledTimes(kinds.length);
    const traceKinds = onTrace.mock.calls.map((c) => c[0].kind);
    expect(traceKinds).toEqual(kinds);
  });
});

describe("CodexChatEngine.send (TASK-010 #2 edge empty)", () => {
  it("text-only invocation does not create an image payload (attachments: undefined)", async () => {
    const { engine, process } = makeHarness();
    await engine.send("hello", {
      onDelta: () => undefined,
      onDone: () => undefined,
    });
    expect(process.capturedInput).toBeDefined();
    expect(process.capturedInput!.text).toBe("hello");
    // HARD RULE: empty attachments MUST be `undefined`, never `[]`.
    expect(process.capturedInput!.attachments).toBeUndefined();
  });

  it("omitting attachments argument also yields undefined (never [])", async () => {
    const { engine, process } = makeHarness();
    await engine.send("plain text", {});
    expect(process.capturedInput!.text).toBe("plain text");
    expect(process.capturedInput!.attachments).toBeUndefined();
  });
});

describe("CodexChatEngine.send (TASK-010 #3 edge image boundary)", () => {
  it("preserves the input order of up-to-4 {mime,base64} attachments alongside the text", async () => {
    const { engine, process } = makeHarness();
    const a1 = { mime: "image/png", base64: "AAA" };
    const a2 = { mime: "image/jpeg", base64: "BBB" };
    const a3 = { mime: "image/webp", base64: "CCC" };
    const a4 = { mime: "image/gif", base64: "DDD" };
    await engine.send(
      "describe these",
      { onDone: () => undefined },
      [a1, a2, a3, a4],
    );

    expect(process.capturedInput).toBeDefined();
    expect(process.capturedInput!.text).toBe("describe these");
    const atts = process.capturedInput!.attachments;
    expect(atts).toBeDefined();
    expect(atts!.length).toBe(4);
    // Order preserved.
    expect(atts![0]).toBe(a1);
    expect(atts![1]).toBe(a2);
    expect(atts![2]).toBe(a3);
    expect(atts![3]).toBe(a4);
    // Each block carries the structured {mime, base64} pair — never
    // base64 appended into the user text.
    for (let i = 0; i < atts!.length; i++) {
      expect(atts![i]).toHaveProperty("mime");
      expect(atts![i]).toHaveProperty("base64");
      expect(process.capturedInput!.text).not.toContain(atts![i]!.base64);
    }
  });

  it("base64 is NEVER serialized into trace payloads (privacy invariant)", async () => {
    const rec = new TraceRecorder();
    const { engine, process } = makeHarness({ recorder: rec });
    const secretBase64 =
      "thisIsASecretBase64RunThatLooksLikeAVeryLongOpaqueString1234567890";
    await engine.send(
      "see image",
      { onDone: () => undefined },
      [{ mime: "image/png", base64: secretBase64 }],
    );

    // The recorded prompt payload must contain only `{ text }` — the
    // attachment list must NOT be carried into the trace (which would
    // leak base64 into the audit log).
    const promptEv = rec.events().find((e) => e.kind === "prompt");
    expect(promptEv).toBeTruthy();
    const payloadStr = JSON.stringify(promptEv!.payload);
    expect(payloadStr).not.toContain(secretBase64);
    expect(payloadStr).not.toContain("base64");
    // And the process received the attachment — the redacted string above
    // is the ONLY place the base64 ever travels (the stdin wire frame).
    expect(process.capturedInput!.attachments![0]!.base64).toBe(secretBase64);
  });
});

describe("CodexChatEngine.send (TASK-010 #4 edge error path)", () => {
  it("protocol/process error becomes one onError and resolves (no throw)", async () => {
    const { engine, process, hostMcp } = makeHarness();
    process.setReject("codex-process-crashed");

    const onError = vi.fn();
    const onDone = vi.fn();
    await expect(
      engine.send("hi", { onError, onDone }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatch(/codex-process-crashed/);
    expect(onDone).not.toHaveBeenCalled();
    // Process was still disposed (the engine owns its teardown even on error).
    expect(process.disposeCalls.length).toBe(1);
    // hostMcp.stop has NOT been called yet — disposal is the engine's job.
    expect(hostMcp.stopCalls).toBe(0);
  });

  it("no hostMcp leak: subsequent dispose() stops HostMcp exactly once", async () => {
    const { engine, process, hostMcp } = makeHarness();
    process.setReject("crash");

    await engine.send("hi", { onError: () => undefined });

    // Dispose after the errored turn — hostMcp.stop must fire exactly once.
    await engine.dispose();
    await engine.dispose();
    expect(hostMcp.stopCalls).toBe(1);
  });

  it("onError message text passes the redact() long-run scrub (no echo of base64)", async () => {
    const rec = new TraceRecorder();
    const { engine, process } = makeHarness({ recorder: rec });
    process.setReject("the-token-is-abc123def456ghi789jkl012mno345pqr");

    const onError = vi.fn();
    await engine.send("hi", { onError });

    // The onError text the caller sees is the raw reject message — the
    // engine only redacts the TRACE copy, not the caller-visible one.
    expect(onError).toHaveBeenCalledWith(
      "the-token-is-abc123def456ghi789jkl012mno345pqr",
    );
    // But the trace payload must be scrubbed.
    const errEv = rec.events().find((e) => e.kind === "error");
    expect(errEv).toBeTruthy();
    expect(JSON.stringify(errEv!.payload)).toContain("<redacted>");
    expect(JSON.stringify(errEv!.payload)).not.toContain(
      "abc123def456ghi789jkl012mno345pqr",
    );
  });
});

describe("CodexChatEngine.send (TASK-010 #5 edge lifecycle)", () => {
  it("idempotent dispose stops hostMcp exactly once; later send emits disposed error and does not spawn", async () => {
    let spawnCount = 0;
    const process = new FakeProcessHandle();
    const hostMcp = new FakeHostMcp();
    const engine = createCodexChatEngine({
      createProcess: async () => {
        spawnCount += 1;
        return process;
      },
      hostMcp,
    });

    // Two dispose() calls — hostMcp.stop called exactly once.
    await engine.dispose();
    await engine.dispose();
    expect(hostMcp.stopCalls).toBe(1);
    expect(process.disposeCalls.length).toBe(0); // no turn ever ran

    // Send after dispose: must NOT spawn a process, MUST emit disposed error.
    const onError = vi.fn();
    const onDone = vi.fn();
    await engine.send("late send", { onError, onDone });
    expect(spawnCount).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe("disposed");
    expect(onDone).not.toHaveBeenCalled();
    // And hostMcp.start is NOT called on a disposed engine.
    expect(hostMcp.startCalls).toBe(0);
  });

  it("dispose then send: process/HostMcp remain disposed exactly once across the lifecycle", async () => {
    const process = new FakeProcessHandle();
    const hostMcp = new FakeHostMcp();
    const engine = createCodexChatEngine({
      createProcess: async () => process,
      hostMcp,
    });

    // First dispose.
    await engine.dispose();
    expect(hostMcp.stopCalls).toBe(1);
    // Second dispose — idempotent.
    await engine.dispose();
    expect(hostMcp.stopCalls).toBe(1);
  });
});

describe("CodexChatEngine.resume (TASK-010 acceptance — TASK-006 noted unverified)", () => {
  it("emits onError('Codex session resume is unavailable') without spawning a process", async () => {
    let spawnCount = 0;
    const process = new FakeProcessHandle();
    const engine = createCodexChatEngine({
      createProcess: async () => {
        spawnCount += 1;
        return process;
      },
    });

    const onError = vi.fn();
    const onDone = vi.fn();
    await engine.resume("codex-thread-1", { onError, onDone });

    expect(spawnCount).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(
      "Codex session resume is unavailable",
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});