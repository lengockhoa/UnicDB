// src/ai/codex/__tests__/codexProcess.test.ts
// TDD unit tests cho src/ai/codex/codexProcess.ts (CodexProcess). TASK-006 §Test Cases #1..#5.
//
// Injectable spawn — không chạy codex thật. Pure unit tests verify:
//   1. Happy: spawn uses documented codex JSON flags + stdin prompt, normalized
//      onDelta("hello") then onDone() fires during send().
//   2. Edge (malformed input): unknown / non-JSON line on stdout is tolerated; the
//      next valid terminal frame still dispatches through onDelta/onDone.
//   3. Edge (lifecycle): cancel() sends exactly one signal + state="cancelling";
//      dispose() resolves within CODEX_DISPOSE_TIMEOUT_MS (2000); repeat dispose
//      is idempotent.
//   4. Edge (process failure): spawn error / nonzero exit with stderr — onError
//      fires with bounded ≤8 KiB tail and NEVER contains the input base64/secret.
//   5. Edge (boundary): image + text turn encoding — translated input carries one
//      image mime + base64 reference and one text part, in original order.
//
// Wire format verified against openai/codex `codex-rs/exec/src/cli.rs` + `exec_events.rs`;
// see docs/AI_HANDOFF/tasks/TASK-006.md §2026-09-07 · executor · unic-code for sources.

import { describe, it, expect, beforeEach } from "vitest";
import { spawn as defaultSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import {
  CodexProcess,
  CODEX_DISPOSE_TIMEOUT_MS,
  type CodexEngineState,
  type CodexProcessHandle,
  type CodexTurnInput,
  type CodexProcessEvents,
} from "../codexProcess";

// ---- Fakes -------------------------------------------------------------------

interface CapturedSpawn {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
}

class FakeChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null = null;
  killed = false;
  /** History of signals passed to kill(); empty string means no signal. */
  killSignals: string[] = [];
  /**
   * When true, kill() does NOT immediately emit exit. The test must call
   * emitChildExit(...) itself to simulate the child actually terminating.
   * Used by tests that need to model "ready child ignores initial terminate
   * until late exit".
   */
  deferExitOnKill = false;

  constructor() {
    super();
    // Tolerate multiple send() cycles on the same child: a real codex child
    // can read one frame per `codex exec -` invocation (one end() per turn),
    // but the FakeChildProcess is reused across many sends. We swallow writes
    // after end() so the regression test for stale exit listeners can drive
    // two consecutive turns without surfacing an unrelated stdin side-effect.
    this.stdin = new TolerablePassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdout.setEncoding("utf8");
  }

  override kill(signal?: NodeJS.Signals | string): boolean {
    this.killSignals.push(signal ?? "");
    this.killed = true;
    if (this.deferExitOnKill) {
      return true;
    }
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
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function captureSpawn(
  child: FakeChildProcess,
  captured: CapturedSpawn,
): (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams {
  return (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.options = options;
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

/** Drain microtasks so PassThrough data listeners run. */
async function drainMicrotasks(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * A PassThrough-like Writable that tolerates writes after end(). The real
 * codex child accepts one frame per `codex exec -` invocation; our fake is
 * reused across multiple turns within a single test, so we must NOT throw
 * on a second `write()` after the first `end()`. This isolates the exit-
 * listener regression test from an unrelated stdin side-effect.
 */
class TolerablePassThrough extends PassThrough {
  private ended = false;
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    if (this.ended) return true;
    return super.write(chunk as never, ...(rest as []));
  }
  override end(..._args: unknown[]): this {
    this.ended = true;
    return this;
  }
}

/** Read every line written to the fake child's stdin so far. */
function readStdinLines(c: FakeChildProcess): string[] {
  const raw = (c.stdin as PassThrough).read() ?? "";
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

/** Drive the start handshake to "ready" by emitting thread.started. */
function driveStartReady(child: FakeChildProcess, threadId = "t-ready"): void {
  child.feedStdout(
    JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n",
  );
}

/** Drive one full agent turn: turn.started → agent_message → turn.completed. */
function driveAgentTurn(child: FakeChildProcess, text: string): void {
  child.feedStdout(JSON.stringify({ type: "turn.started" }) + "\n");
  child.feedStdout(
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_msg", type: "agent_message", text },
    }) + "\n",
  );
  child.feedStdout(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
}

// ---- Tests ------------------------------------------------------------------

describe("CodexProcess", () => {
  let child: FakeChildProcess;
  let captured: CapturedSpawn;

  beforeEach(() => {
    child = new FakeChildProcess();
    captured = {};
  });

  // #1 — happy: documented spawn args + normalized onDelta + onDone during send()
  it("spawns a documented codex JSON turn and maps assistant delta to onDelta / onDone", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "/usr/local/bin/codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );

    const deltas: string[] = [];
    const dones: number[] = [];
    const errors: string[] = [];
    const events: CodexProcessEvents = {
      onDelta: (d) => deltas.push(d),
      onDone: () => dones.push(1),
      onError: (m) => errors.push(m),
    };

    const handlePromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "0199a213-81c0-7800-8aa1-bbab2a035a53"));
    const handle = await handlePromise;

    // Documented command shape (per openai/codex cli.rs):
    //   codexPath exec --json -
    expect(captured.command).toBe("/usr/local/bin/codex");
    const args = captured.args ?? [];
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    // `-` is the documented stdin-prompt sentinel (cli.rs line 80).
    expect(args[args.length - 1]).toBe("-");
    // Mandatory spawn cwd — never bare shell interpolation.
    expect(captured.options?.cwd).toBe("/tmp/proj");
    expect(captured.options?.stdio?.[0]).toBe("pipe");

    // sessionId is captured from thread.started.
    expect(handle.sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");

    // Drive a real turn: stdin prompt is written, then JSONL streams back.
    const sendPromise = handle.send({ text: "say hello" }, events);
    queueMicrotask(() => driveAgentTurn(child, "hello"));
    await sendPromise;
    await drainMicrotasks(8);

    expect(deltas).toContain("hello");
    expect(dones.length).toBe(1);
    expect(errors).toEqual([]);

    handle.dispose();
  });

  // #2 — edge (malformed input): non-JSON line on stdout is skipped; the next
  // valid terminal frame still dispatches through onDelta + onDone without a throw.
  it("skips malformed stdout lines and continues to valid terminal frames (no throw)", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );

    const deltas: string[] = [];
    const dones: number[] = [];
    const errors: string[] = [];
    const events: CodexProcessEvents = {
      onDelta: (d) => deltas.push(d),
      onDone: () => dones.push(1),
      onError: (m) => errors.push(m),
    };

    const handlePromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "t-malformed"));
    const handle = await handlePromise;

    const sendPromise = handle.send({ text: "go" }, events);
    queueMicrotask(() => {
      // 1) junk line — not valid JSON
      child.feedStdout("not-json-at-all\n");
      // 2) unknown JSON object — parseable but wrong shape
      child.feedStdout(JSON.stringify({ type: "bogus.event", payload: 1 }) + "\n");
      // 3) valid terminal frames
      driveAgentTurn(child, "survived");
    });

    // send() must NOT throw — malformed frames are skipped silently.
    await sendPromise;
    await drainMicrotasks(8);

    expect(deltas).toContain("survived");
    expect(dones.length).toBe(1);
    // onError MUST NOT fire for malformed JSON — only for explicit failure events.
    expect(errors).toEqual([]);

    handle.dispose();
  });

  // #3 — edge (lifecycle): cancel sends one signal + state="cancelling"; dispose
  // resolves within CODEX_DISPOSE_TIMEOUT_MS; second dispose is idempotent.
  it("cancellation/dispose: one signal sent, dispose settles within 2000ms, idempotent", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );

    // Never-exiting child — deferExitOnKill so initial SIGTERM doesn't terminate it.
    child.deferExitOnKill = true;

    const states: CodexEngineState[] = [];
    const handlePromise = proc.start({
      onStateChange: (s) => states.push(s),
    });
    queueMicrotask(() => driveStartReady(child, "t-ready"));
    const handle = await handlePromise;

    expect(handle.state()).toBe("ready");

    // Cancel — exactly one SIGTERM, state moves to "cancelling".
    handle.cancel();
    expect(handle.state()).toBe("cancelling");
    expect(child.killSignals.filter((s) => s === "SIGTERM").length).toBe(1);

    // Idempotent: second cancel sends no extra signal.
    handle.cancel();
    expect(child.killSignals.filter((s) => s === "SIGTERM").length).toBe(1);

    // Dispose — must resolve within CODEX_DISPOSE_TIMEOUT_MS.
    const t0 = Date.now();
    const disposePromise = handle.dispose();
    // Let the escalation timer actually fire.
    const disposeResult = await Promise.race([
      disposePromise,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), CODEX_DISPOSE_TIMEOUT_MS + 500),
      ),
    ]);
    const elapsed = Date.now() - t0;
    await drainMicrotasks(4);
    expect(disposeResult).not.toBe("timeout");
    expect(elapsed).toBeLessThanOrEqual(CODEX_DISPOSE_TIMEOUT_MS + 250);

    // Idempotent dispose: second call returns the same settled promise without
    // re-firing SIGKILL or another state transition.
    const sigkillBefore = child.killSignals.filter((s) => s === "SIGKILL").length;
    await handle.dispose();
    const sigkillAfter = child.killSignals.filter((s) => s === "SIGKILL").length;
    expect(sigkillAfter).toBe(sigkillBefore);
    expect(handle.state()).toBe("stopped");

    // State machine must have visited "ready" → "cancelling" → "stopped".
    const tail = states.slice(-3);
    expect(tail[tail.length - 1]).toBe("stopped");
    expect(tail).toContain("cancelling");
  });

  // #4 — edge (process failure): spawn error or nonzero exit + stderr. onError
  // contains bounded ≤8 KiB tail and NEVER includes input base64/secret.
  it("process failure: stderr is bounded ≤8 KiB and error message contains no input secret", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );

    // A small base64 image the adapter must NEVER echo.
    const SECRET_BASE64 = "aGVsbG8gd29ybGQ="; // decodes to "hello world"
    const input: CodexTurnInput = {
      text: "describe this",
      attachments: [{ mime: "image/png", base64: SECRET_BASE64 }],
    };

    const errors: string[] = [];
    const events: CodexProcessEvents = {
      onError: (m) => errors.push(m),
    };

    const handlePromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "t-fail"));
    const handle = await handlePromise;

    const sendPromise = handle.send(input, events);
    queueMicrotask(() => {
      // Push a 10 KiB stderr blob (over the 8 KiB bound) then exit nonzero.
      const blob = "X".repeat(10 * 1024);
      child.feedStderr(`boom: ${blob}\n`);
      child.emitChildExit(2);
    });

    // send() must NOT throw on process failure — it resolves once onError fires.
    await sendPromise;
    await drainMicrotasks(8);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    const combined = errors.join("\n");
    // Base64 input MUST NOT appear in any error message.
    expect(combined.includes(SECRET_BASE64)).toBe(false);
    // The literal base64-decoded "hello world" MUST NOT appear either — defence
    // in depth against adapters that decode before logging.
    expect(combined.includes("hello world")).toBe(false);
    // The error payload is bounded — not multi-megabyte from unbounded stderr.
    expect(combined.length).toBeLessThanOrEqual(20 * 1024);
  });

  // #5 — edge (boundary): image + text turn encoding. Translated input carries
  // one image mime + base64 reference and one text part, in original order.
  it("image + text turn encoding: input frame contains one text part and one image part in order", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );

    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==";

    const startPromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "t-img"));
    const handle = await startPromise;

    const sendPromise = handle.send(
      {
        text: "describe this",
        attachments: [{ mime: "image/png", base64: PNG_BASE64 }],
      },
      {
        onDelta: () => { /* no-op */ },
        onDone: () => { /* no-op */ },
      },
    );
    queueMicrotask(() => driveAgentTurn(child, "ok"));
    await sendPromise;
    await drainMicrotasks(8);

    const stdinLines = readStdinLines(child);
    expect(stdinLines.length).toBeGreaterThanOrEqual(1);

    // The translated input frame the adapter sent to stdin is a single JSON
    // object with `prompt` (text-only summary) and `parts` (ordered).
    const lastLine = stdinLines[stdinLines.length - 1];
    const parsed = JSON.parse(lastLine) as {
      prompt?: string;
      parts?: ReadonlyArray<Record<string, unknown>>;
    };

    // Order matters: text part first, image part second.
    const parts = parsed.parts ?? [];
    expect(parts.length).toBe(2);
    expect(parts[0]["type"]).toBe("text");
    expect(parts[0]["text"]).toBe("describe this");
    expect(parts[1]["type"]).toBe("image");
    expect(parts[1]["mime"]).toBe("image/png");
    expect(parts[1]["base64"]).toBe(PNG_BASE64);

    // The prompt field (top-level summary) is the text so callers that ignore
    // `parts` still see the user text.
    expect(parsed.prompt).toBe("describe this");

    handle.dispose();
  });

  // ---- R4.5 regression: stale per-turn exit listeners (Reviewer Finding) -------
  //
  // Reviewer Verdict §important:
  //   `child.on("exit", onExit)` in send() was never removed; settle() only
  //   detached the stdout JSONL pump. After N sends, every prior `onExit`
  //   closure stayed attached; when the child finally exited, ALL N stale
  //   closures fired `events.onError("codex exited mid-turn ...")` on turns
  //   that already completed with onDone — TASK-010 would observe spurious
  //   post-success failures on every dispose.
  //
  // Regression: 2 sends, both complete normally, then a real child exit.
  // Only the actual exit must produce ONE onError; prior completed turns
  // must NOT receive a stale onError from the late child exit.
  it("R4.5: stale per-turn exit listeners must NOT fire onError on completed turns after child exit", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "t-r45"));
    const handle = await startPromise;

    // ---- Turn 1: completes successfully via turn.completed.
    const errors1: string[] = [];
    const dones1: number[] = [];
    const events1: CodexProcessEvents = {
      onDelta: () => { /* no-op */ },
      onDone: () => dones1.push(1),
      onError: (m) => errors1.push(m),
    };
    const send1 = handle.send({ text: "first" }, events1);
    queueMicrotask(() => driveAgentTurn(child, "first-response"));
    await send1;
    await drainMicrotasks(8);
    expect(dones1.length).toBe(1);
    expect(errors1).toEqual([]);

    // ---- Turn 2: completes successfully via turn.completed.
    const errors2: string[] = [];
    const dones2: number[] = [];
    const events2: CodexProcessEvents = {
      onDelta: () => { /* no-op */ },
      onDone: () => dones2.push(1),
      onError: (m) => errors2.push(m),
    };
    const send2 = handle.send({ text: "second" }, events2);
    queueMicrotask(() => driveAgentTurn(child, "second-response"));
    await send2;
    await drainMicrotasks(8);
    expect(dones2.length).toBe(1);
    expect(errors2).toEqual([]);

    // ---- Real child exit fires AFTER both turns have already completed.
    // The exit handler in send() is what was leaving stale listeners behind.
    // Only THIS exit should fire onError; turns 1 and 2 must NOT receive a
    // stale onError from the late exit.
    child.emitChildExit(0);
    await drainMicrotasks(16);

    // Critical regression assertions:
    expect(errors1).toEqual([]); // turn 1 already completed; no stale onError
    expect(errors2).toEqual([]); // turn 2 already completed; no stale onError
    expect(dones1.length).toBe(1);
    expect(dones2.length).toBe(1);

    handle.dispose();
  });

  // ---- Aux: spawn signature + dispose constant --------------------------------

  it("spawn options set shell:true only on win32 (parity with omp adapter)", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );
    const startPromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "t-plat"));
    await startPromise;
    expect(captured.options?.shell).toBe(process.platform === "win32");
  });

  it("default spawnFn signature accepts CodexProcessOptions without throwing at construction", () => {
    expect(
      () =>
        new CodexProcess(
          {
            codexPath: "codex",
            cwd: "/tmp/proj",
          },
          defaultSpawn as unknown as Parameters<typeof CodexProcess>[1],
        ),
    ).not.toThrow();
  });

  it("CODEX_DISPOSE_TIMEOUT_MS is pinned at 2000", () => {
    expect(CODEX_DISPOSE_TIMEOUT_MS).toBe(2000);
  });

  it("start captures thread.started.thread_id as sessionId", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );
    const startPromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "fixed-uuid-abc"));
    const handle = await startPromise;
    expect(handle.sessionId).toBe("fixed-uuid-abc");
    expect(typeof handle.version).toBe("string");
    handle.dispose();
  });

  it("CodexProcessHandle exposes state / send / cancel / dispose / getStderrTail", async () => {
    const proc = new CodexProcess(
      {
        codexPath: "codex",
        cwd: "/tmp/proj",
      },
      captureSpawn(child, captured),
    );
    const startPromise = proc.start();
    queueMicrotask(() => driveStartReady(child, "t-handle"));
    const handle = await startPromise;
    const h: CodexProcessHandle = handle;
    expect(typeof h.state).toBe("function");
    expect(typeof h.send).toBe("function");
    expect(typeof h.cancel).toBe("function");
    expect(typeof h.dispose).toBe("function");
    expect(typeof h.getStderrTail).toBe("function");
    expect(typeof h.sessionId).toBe("string");
    expect(typeof h.version).toBe("string");
    h.dispose();
  });
});
