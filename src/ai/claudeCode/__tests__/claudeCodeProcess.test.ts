// src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts
// TDD tests for src/ai/claudeCode/claudeCodeProcess.ts — TASK-005.
//
// Injectable spawn — không chạy `claude` thật. Pure unit tests verify:
//   1. Spawn args use the supplied claudePath (NEVER bare "claude"), include
//      `--print --input-format stream-json --output-format stream-json
//       --verbose` and default-deny permission flags. onDelta("hello") fires
//      for a valid assistant stream event.
//   2. Malformed JSON line on stdout is ignored; adapter does NOT throw,
//      kill the child, or hang.
//   3. dispose() while a turn is in flight: SIGTERM, then SIGKILL at
//      CLAUDE_CODE_DISPOSE_TIMEOUT_MS (2000ms); second dispose() is a no-op.
//   4. Process failure: child error + >8 KiB stderr → bounded (≤8 KiB)
//      stderr tail on onError; NEVER include base64/secret content.
//   5. Image + text input: stdin frame is a single JSON object whose
//      message.content has both text and image blocks intact; no base64
//      appears in any error/log callback.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";

import {
  CLAUDE_CODE_DISPOSE_TIMEOUT_MS,
  createClaudeCodeProcess,
  type ClaudeCodeEngineState,
  type ClaudeCodeProcessEvents,
  type ClaudeCodeProcessOptions,
  type ClaudeCodeSpawnFn,
  type ClaudeCodeTurnInput,
} from "../claudeCodeProcess";

// ---- Fakes ------------------------------------------------------------------

interface CapturedSpawn {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
}

/**
 * Minimal stand-in cho ChildProcessWithoutNullStreams. PassThrough-backed
 * stdio keeps encoding/data events realistic; EventEmitter carries parent
 * signals. `stdinChunks` records what the adapter writes so test #5 can
 * introspect the JSON frame.
 */
class FakeChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed = false;
  killSignals: string[] = [];
  stdinChunks: string[] = [];

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdout.setEncoding("utf8");
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => {
      this.stdinChunks.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    });
  }

  override kill(signal?: NodeJS.Signals | string): boolean {
    this.killSignals.push(signal ?? "");
    this.killed = true;
    return true;
  }

  feedStdout(chunk: string): void {
    (this.stdout as PassThrough).write(chunk);
  }

  feedStderr(chunk: string): void {
    (this.stderr as PassThrough).write(chunk);
  }

  emitSpawnError(err: Error): void {
    this.emit("error", err);
  }

  emitChildExit(code: number | null): void {
    this.emit("exit", code);
  }

  /**
   * Surface a stdin-stream error (e.g. EPIPE) as the real Node stdio
   * would — by emitting `error` on the stdin PassThrough. The adapter's
   * stdin error listener should catch this and route through failTurn.
   */
  emitStdinError(err: Error): void {
    (this.stdin as PassThrough).emit("error", err);
  }
}

function captureSpawn(
  child: FakeChildProcess,
  captured: CapturedSpawn,
): ClaudeCodeSpawnFn {
  return (command, args, options) => {
    captured.command = command;
    captured.args = [...args];
    captured.options = options;
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

const FAKE_CLAUDE_PATH = "/usr/local/bin/claude";

function makeOptions(
  overrides?: Partial<ClaudeCodeProcessOptions>,
): ClaudeCodeProcessOptions {
  return {
    claudePath: FAKE_CLAUDE_PATH,
    cwd: "/workspace/proj",
    spawnFn: undefined, // replaced per-test via `withSpawn(...)`
    ...overrides,
  };
}

/** Inject a captured spawnFn into the options. */
function withSpawn(
  base: ClaudeCodeProcessOptions,
  child: FakeChildProcess,
  captured: CapturedSpawn,
): ClaudeCodeProcessOptions {
  return { ...base, spawnFn: captureSpawn(child, captured) };
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Emit a `assistant` stream-json chunk carrying the given text content.
 */
function assistantChunk(text: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    }) + "\n"
  );
}

/** Emit a `result` stream-json frame marking the turn complete. */
function resultChunk(
  subtype: "success" | "error",
  extra?: Record<string, unknown>,
): string {
  return (
    JSON.stringify({
      type: "result",
      subtype,
      is_error: subtype === "error",
      duration_ms: 10,
      ...extra,
    }) + "\n"
  );
}

/** Drain N microtask cycles so the line pump / state observer settle. */
async function drainMicrotasks(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ---- Tests ------------------------------------------------------------------

describe("createClaudeCodeProcess — TASK-005", () => {
  let child: FakeChildProcess;
  let captured: CapturedSpawn;

  beforeEach(() => {
    child = new FakeChildProcess();
    captured = {};
  });

  // Case #1 — happy: spawn args, onDelta for valid assistant stream event
  it("spawns a text prompt turn and maps a valid assistant stream event", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const states: ClaudeCodeEngineState[] = [];
    handle.state; // touch — read-only
    const deltas: string[] = [];
    let done = false;

    const sendPromise = handle.send(
      { text: "say hello" },
      {
        onDelta: (d) => deltas.push(d),
        onDone: () => {
          done = true;
        },
        onStateChange: (s) => states.push(s),
      },
    );

    // Drain microtasks so spawn fires and the state observer settles.
    await drainMicrotasks();

    // ---- Spawn arg assertions (Acceptance Criterion 1-3) -----------------
    expect(captured.command).toBe(FAKE_CLAUDE_PATH);
    expect(captured.options?.cwd).toBe("/workspace/proj");
    expect(captured.options?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    const args = captured.args ?? [];
    expect(args).toContain("--print");
    // --input-format stream-json
    const inputIdx = args.indexOf("--input-format");
    expect(inputIdx).toBeGreaterThanOrEqual(0);
    expect(args[inputIdx + 1]).toBe("stream-json");
    // --output-format stream-json
    const outputIdx = args.indexOf("--output-format");
    expect(outputIdx).toBeGreaterThanOrEqual(0);
    expect(args[outputIdx + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    // Default-deny semantics: never bypass.
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    for (const a of args) {
      // No mode that auto-bypasses permission prompts.
      expect(a).not.toBe("bypassPermissions");
      expect(a).not.toBe("auto");
      expect(a).not.toBe("dontAsk");
    }

    // ---- Drive a turn: emit assistant chunk + success result --------------
    child.feedStdout(assistantChunk("hello"));
    await drainMicrotasks();
    child.feedStdout(resultChunk("success"));
    child.emitChildExit(0);
    await sendPromise;

    expect(deltas).toContain("hello");
    expect(done).toBe(true);
    // Normal completion path: states observed during a successful turn.
    expect(states[0]).toBe("starting");
    expect(states).toContain("ready");
    // Final state after a clean completion is "stopped" (per-turn semantics).
    expect(handle.state()).toBe("stopped");
  });

  // Case #2 — edge: malformed JSON line on stdout
  it("malformed JSON line on stdout is ignored; adapter does not throw, kill, or hang", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const deltas: string[] = [];
    const errors: string[] = [];

    const sendPromise = handle.send(
      { text: "echo" },
      {
        onDelta: (d) => deltas.push(d),
        onError: (m) => errors.push(m),
      },
    );

    await drainMicrotasks();

    // Garbage line first, then a valid assistant chunk + success result.
    child.feedStdout("{bad-json}\n");
    await drainMicrotasks();
    child.feedStdout(assistantChunk("hi"));
    await drainMicrotasks();
    child.feedStdout(resultChunk("success"));
    child.emitChildExit(0);

    await sendPromise;

    expect(deltas).toContain("hi");
    // Malformed frame must not surface as an error event.
    expect(errors).toEqual([]);
    // Child must NOT have been killed by the malformed line.
    expect(child.killSignals).toEqual([]);
    expect(handle.state()).toBe("stopped");
  });

  // Case #3 — edge: dispose while a turn is in flight (bounded reap + idempotent)
  it("dispose() while a turn is in flight: SIGTERM, escalates to SIGKILL at CLAUDE_CODE_DISPOSE_TIMEOUT_MS, second dispose() no-ops", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const sendPromise = handle.send({ text: "long" }, {});
    await drainMicrotasks();

    // Child is alive in "ready"; hasn't exited yet.
    expect(child.killSignals).toEqual([]);

    // Use fake timers so the 2000ms reap bound is testable.
    vi.useFakeTimers();
    const disposePromise = handle.dispose();
    // First kill is SIGTERM sent immediately.
    expect(child.killSignals).toEqual(["SIGTERM"]);

    // Advance just under the timeout: no SIGKILL yet.
    await vi.advanceTimersByTimeAsync(1500);
    expect(child.killSignals).toEqual(["SIGTERM"]);

    // Second dispose() while timer is pending: must NOT add a second SIGTERM.
    const secondDispose = handle.dispose();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(secondDispose).toBe(disposePromise);

    // Advance past the timeout: SIGKILL is sent; the dispose promise resolves.
    await vi.advanceTimersByTimeAsync(CLAUDE_CODE_DISPOSE_TIMEOUT_MS);
    await disposePromise;
    await drainMicrotasks();
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(handle.state()).toBe("stopped");

    // Now simulate the child actually exiting so the in-flight send()
    // promise can settle (fake child does not auto-emit exit on kill).
    child.emitChildExit(0);
    await drainMicrotasks();
    // The send() promise also settles (with rejection / onError), no hang.
    await sendPromise.catch(() => {
      /* expected: turn aborted by dispose */
    });

    vi.useRealTimers();
  });

  // Case #4 — edge: process failure with >8 KiB stderr → bounded tail, no base64 leak
  it("child error / non-zero exit surfaces bounded stderr tail on onError; no base64 / secret content leaks", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const errors: string[] = [];
    const secretMarker = "Z9K3SECRET-TOKEN-PNG-DATA-XYZ";
    const base64Marker = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAA";

    const sendPromise = handle.send({ text: "go" }, {
      onError: (m) => errors.push(m),
    });

    await drainMicrotasks();

    // 9 KiB of stderr — the secret/base64 markers are placed in the
    // head (first ~1 KiB) so the bounded slice window DROPS them. After
    // truncation, the retained 8 KiB tail contains ONLY the post-head
    // filler bytes; this is what makes the test actually exercise the
    // bounded tail (rather than just checking the markers survived).
    const headLen = 1024;
    const markers = `${secretMarker}${base64Marker}`; // 77 chars
    const head = `${markers}${"x".repeat(headLen - markers.length)}`;
    const rest = "x".repeat(9 * 1024 - headLen);
    child.feedStderr(`${head}${rest}\n`);
    child.emitSpawnError(new Error("claude exited unexpectedly"));
    child.emitChildExit(2);

    // Wait for the send() to settle (rejection or onError).
    await sendPromise.catch(() => {
      /* error path is the expected one */
    });
    await drainMicrotasks();

    // onError was called exactly once.
    expect(errors.length).toBe(1);
    const errText = errors[0] ?? "";
    // The bounded tail is at most STDERR_TAIL_LIMIT (8 KiB). The earliest
    // bytes (including both markers) were truncated by the slice; either
    // the secret OR the base64 marker may or may not be present depending
    // on which side of the slice window they fell. The hard guarantee is:
    //   - The leaked text is bounded (length is sane).
    //   - The base64 marker never leaks into the error text in full.
    // The secret marker is configurable per-call; it must not be in the
    // error if the test placed it AFTER the slice window. We assert that
    // the tail length is bounded, and assert that base64-like content is
    // not present.
    expect(errText.length).toBeLessThanOrEqual(8 * 1024 + 256);
    // A full base64 string (the marker) must NEVER appear in error/log.
    expect(errText).not.toContain(base64Marker);

    // Mandated by Test Plan §Test Cases #4: the retained stderr tail MUST
    // be bounded (≤ 8 KiB) and exposed via getStderrTail(). The 9 KiB
    // fixture's head bytes — including the secret marker — were truncated
    // by the slice window, so neither marker survives in the tail.
    const tail = handle.getStderrTail?.() ?? "";
    expect(typeof tail).toBe("string");
    expect(tail.length).toBeLessThanOrEqual(8 * 1024);
    expect(tail).not.toContain(secretMarker);
    expect(tail).not.toContain(base64Marker);

    // Final state: crashed → fallback-builtin (terminal).
    expect(handle.state()).toBe("fallback-builtin");
  });

  // Case #6 (R4.5 important #1) — error / result-error frames fire onError
  // exactly ONCE. The pre-fire at lines 728/745 plus the fire inside
  // failTurn() would otherwise double-fire for the same failure.
  it("result-error frame fires onError exactly once (no double-fire)", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const errors: string[] = [];

    const sendPromise = handle.send({ text: "go" }, {
      onError: (m) => errors.push(m),
    });

    await drainMicrotasks();

    // Drive a result frame with subtype:"error" — the path under test.
    child.feedStdout(
      resultChunk("error", {
        error: { message: "model refused" },
      }),
    );
    await sendPromise.catch(() => {
      /* expected rejection */
    });
    await drainMicrotasks();

    // Dedup contract: exactly one onError regardless of which path
    // (result-error frame vs. failTurn) originally fired.
    expect(errors.length).toBe(1);
    expect(errors[0]).toBe("model refused");
    expect(handle.state()).toBe("fallback-builtin");
  });

  // Case #7 (R4.5 important #1) — top-level "error" frames also dedupe.
  it("top-level error frame fires onError exactly once (no double-fire)", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const errors: string[] = [];

    const sendPromise = handle.send({ text: "go" }, {
      onError: (m) => errors.push(m),
    });

    await drainMicrotasks();

    child.feedStdout(
      JSON.stringify({ type: "error", message: "stream blew up" }) + "\n",
    );
    await sendPromise.catch(() => {
      /* expected rejection */
    });
    await drainMicrotasks();

    expect(errors.length).toBe(1);
    expect(errors[0]).toBe("stream blew up");
    expect(handle.state()).toBe("fallback-builtin");
  });

  // Case #8 (R4.5 important #3) — child exits before we can write stdin;
  // EPIPE on the subsequent stdin.write/end must NOT become an uncaught
  // exception. The adapter must route it through failTurn.
  it("EPIPE on stdin write (child died early) does not throw uncaught; routes through failTurn", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const errors: string[] = [];
    // Capture any unhandled rejections that escape the adapter — those
    // would crash the extension host in production.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const sendPromise = handle.send({ text: "go" }, {
        onError: (m) => errors.push(m),
      });

      await drainMicrotasks();

      // Make the child die BEFORE consuming stdin — simulates a child
      // that crashed before reading. Then surface an EPIPE error on
      // stdin like Node would.
      child.emitChildExit(1);
      child.emitStdinError(new Error("EPIPE"));

      await sendPromise.catch(() => {
        /* expected rejection */
      });
      await drainMicrotasks();

      // No unhandled rejection escaped to the process — the adapter
      // owns the EPIPE and routes it through failTurn / onError.
      expect(unhandled.length).toBe(0);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(handle.state()).toBe("fallback-builtin");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // Case #5 — edge: image + text boundary in stream-json input
  it("prompt with image + text emits one valid JSON stdin frame with both blocks; no base64 in error/log", async () => {
    const handle = createClaudeCodeProcess(
      withSpawn(makeOptions(), child, captured),
    );

    const errors: string[] = [];
    const secretBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const input: ClaudeCodeTurnInput = {
      text: "What is in this PNG?",
      attachments: [{ mime: "image/png", base64: secretBase64 }],
    };

    const sendPromise = handle.send(input, {
      onError: (m) => errors.push(m),
    });

    await drainMicrotasks();

    // Stdin must contain at least one JSON frame that holds BOTH blocks.
    const stdinBlob = child.stdinChunks.join("");
    const lines = stdinBlob.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // The frame is newline-delimited JSON: parse the first valid one.
    let parsed: Record<string, unknown> | null = null;
    for (const line of lines) {
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
        break;
      } catch {
        continue;
      }
    }
    expect(parsed).not.toBeNull();
    // Shape: { type: "user", message: { role: "user", content: [...] } }
    expect(parsed!["type"]).toBe("user");
    const message = parsed!["message"] as Record<string, unknown>;
    expect(message["role"]).toBe("user");
    const content = message["content"] as ReadonlyArray<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(2);
    // Text block intact.
    const textBlock = content[0]!;
    expect(textBlock["type"]).toBe("text");
    expect(textBlock["text"]).toBe("What is in this PNG?");
    // Image block intact — base64 payload present, mime preserved.
    const imageBlock = content[1]!;
    expect(imageBlock["type"]).toBe("image");
    const source = imageBlock["source"] as Record<string, unknown>;
    expect(source["type"]).toBe("base64");
    expect(source["media_type"]).toBe("image/png");
    expect(source["data"]).toBe(secretBase64);

    // Complete the turn so send() settles cleanly.
    child.feedStdout(assistantChunk("ok"));
    await drainMicrotasks();
    child.feedStdout(resultChunk("success"));
    child.emitChildExit(0);
    await sendPromise;

    // No base64 leaked into any error/log callback (no error fired).
    expect(errors).toEqual([]);
  });
});
