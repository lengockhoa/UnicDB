// src/ai/omp/__tests__/acpProcess.test.ts
// Unit tests cho src/ai/omp/acpProcess.ts (AcpProcess). TASK-002 §Test Cases #1..#5.
//
// Injectable spawn — không chạy omp thật. Pure unit tests verify:
//   1. Spawn args never contain yolo / --approval-mode / --auto-approve.
//   2. spawn cwd always supplied; --cwd flag conditionally passed via AcpProcessOptions.supportCwdFlag.
//   3. Spawn failure / immediate exit → host-reported failure; no silent swallow.
//   4. Successful start wires AcpClient, completes initialize → initialized → session/new,
//      exposes sessionId, version, notification handlers, server-request handlers, dispose.
//
// TASK-012 (B11a): `hostTools.ts` was dead code (no `set_host_tools` RPC exists in
// production) and has been deleted along with its dedicated test file; the 3
// `hostTools:`-prefixed tests that used to live here were deleted with it.
// mcpServers-threading coverage now lives in the "TASK-012 (B11a)" describe block below.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn as defaultSpawn } from "child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import { AcpProcess, type OmpEngineState } from "../acpProcess";

// ---- Fakes -------------------------------------------------------------------

interface CapturedSpawn {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
}

/**
 * Minimal stand-in cho ChildProcessWithoutNullStreams. PassThrough-backed stdio
 * keeps encoding/data events realistic; EventEmitter carries parent signals.
 */
class FakeChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null = null;
  killed = false;
  /** History of signals passed to kill(); empty string means no signal. */
  killSignals: string[] = [];
  /**
   * When true, kill() does NOT immediately mark `killed` and does NOT emit
   * exit. The test must call `emitChildExit(...)` itself to simulate the
   * child actually terminating. Used by tests that need to model "ready
   * child ignores initial terminate until late exit".
   */
  deferExitOnKill = false;

  constructor() {
    super();
    this.stdin = new PassThrough();
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

/**
 * Drive the initialize + session/new responses. The two awaits yield the
 * microtask boundary that AcpProcess.start() needs to register the second
 * request (`session/new`) before its matching response frame lands. Without
 * these pauses, both frames hit the same PassThrough "data" event and the
 * second one is dropped (pending[2] doesn't exist yet).
 */
async function driveHandshake(child: FakeChildProcess): Promise<void> {
  child.feedStdout(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "18.0.1" },
      },
    }) + "\n",
  );
  await Promise.resolve();
  await Promise.resolve();
  child.feedStdout(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "01a02f96-beda-7564-b313-2d0e5e515a22",
        configOptions: [],
      },
    }) + "\n",
  );
}

// ---- Tests ------------------------------------------------------------------

describe("AcpProcess", () => {
  let child: FakeChildProcess;
  let captured: CapturedSpawn;

  beforeEach(() => {
    child = new FakeChildProcess();
    captured = {};
  });

  const FORBIDDEN = /yolo|approval-mode|auto-approve/;

  // #1 — spawn args never contain yolo/--approval-mode/--auto-approve
  it("start uses `omp acp` without approval-auto arguments", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await startPromise;

    expect(captured.command).toBe("omp");
    const args = captured.args ?? [];
    expect(args[0]).toBe("acp");
    expect(args).not.toContain("yolo");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("--auto-approve");
    for (const a of args) {
      expect(a).not.toMatch(FORBIDDEN);
    }
  });

  // Review Finding 2: on Windows, `where omp` typically resolves `omp.cmd`
  // — a shell shim. Node >= 20.12 cannot spawn a `.cmd` file without
  // `shell: true` (CVE-2024-27980 mitigation), so a detected-usable omp
  // would die with ENOENT on every real session start. `shell` must mirror
  // `process.platform === "win32"` exactly (true on Windows, false/absent
  // effect elsewhere) — this assertion is written to hold on every CI
  // platform, not just Windows.
  it("R(Finding2) regression: spawn options set shell:true only on win32", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );
    const startPromise = proc.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await startPromise;

    expect(captured.options?.shell).toBe(process.platform === "win32");
  });

  // #2 — spawn always supplies cwd; --cwd flag conditionally passed
  it("start passes workspace cwd to spawn and conditionally adds --cwd flag", async () => {
    // Case A: --cwd supported → flag present
    const procA = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/projA",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );
    const pA = procA.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await pA;

    expect(captured.options?.cwd).toBe("/tmp/projA");
    expect(captured.options?.stdio?.[0]).toBe("pipe");
    const cwdIdx = (captured.args ?? []).indexOf("--cwd");
    expect(cwdIdx).toBeGreaterThan(-1);
    expect((captured.args ?? [])[cwdIdx + 1]).toBe("/tmp/projA");

    // Case B: --cwd NOT supported → flag absent, spawn cwd still set
    const childB = new FakeChildProcess();
    const capturedB: CapturedSpawn = {};
    const procB = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/projB",
        supportCwdFlag: false,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(childB, capturedB),
    );
    const pB = procB.start();
    queueMicrotask(() => {
      void driveHandshake(childB);
    });
    await pB;

    expect(capturedB.options?.cwd).toBe("/tmp/projB");
    expect(capturedB.args).not.toContain("--cwd");
  });

  // #3 — spawn error or immediate exit → host-reported failure; no silent swallow
  it("start rejects when spawn emits error (e.g. omp missing) and forwards child exit", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => child.emitSpawnError(new Error("spawn omp ENOENT")));

    await expect(startPromise).rejects.toThrow(/ENOENT|spawn/);
  });

  it("start rejects when child exits before initialize response arrives", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => child.emitChildExit(1));

    await expect(startPromise).rejects.toThrow(/exited|exit/);
  });

  // #4 — successful start wires AcpClient + session, exposes notifications / server-request
  it("start returns session info and version; emits notifications and server-requests through AcpClient", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const notifs: Array<{ method: string }> = [];
    const serverReqs: Array<{ method: string }> = [];

    const startPromise = proc.start({
      onNotification: (n) => notifs.push({ method: n.method }),
      onServerRequest: (call) => {
        serverReqs.push({ method: call.method });
        call.respond({ ok: true });
        return Promise.resolve();
      },
    });
    queueMicrotask(() => {
      void (async () => {
        await driveHandshake(child);
        // After session/new lands, push a notification + a server request to confirm wiring.
        await Promise.resolve();
        await Promise.resolve();
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "01a02f96-beda-7564-b313-2d0e5e515a22" },
          }) + "\n",
        );
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            method: "session/request_permission",
            params: { sessionId: "01a02f96-beda-7564-b313-2d0e5e515a22" },
          }) + "\n",
        );
      })();
    });

    const handle = await startPromise;

    expect(handle.sessionId).toBe("01a02f96-beda-7564-b313-2d0e5e515a22");
    expect(handle.version).toBe("18.0.1");
    expect(handle.acp).toBeDefined();

    // Drain microtasks so the post-handshake frames dispatch through handlers.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }

    expect(notifs.map((n) => n.method)).toContain("session/update");
    expect(serverReqs.map((s) => s.method)).toContain("session/request_permission");

    handle.dispose();
  });

  // TASK-004 fix round — child exit after handshake must dispose the
  // AcpClient exactly once so the panel's onClose hook fires and pending
  // permission requests are default-denied. Regression for the case where
  // `this.acp` was never assigned and no `child.on("exit")` watchdog was
  // registered post-handshake.
  it("child exit after handshake disposes the AcpClient and fires onClose listeners", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    let closeListenerFires = 0;
    const startPromise = proc.start();
    queueMicrotask(() => {
      void (async () => {
        await driveHandshake(child);
      })();
    });

    const handle = await startPromise;
    handle.acp.onClose(() => {
      closeListenerFires += 1;
    });

    // Real exit path — must trigger disposeClient → acp.dispose → onClose.
    child.emitChildExit(0);

    // Drain microtasks so the exit listener and onClose drain run.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }

    expect(closeListenerFires).toBe(1);

    // Idempotent: second exit / manual disposeClient do not re-fire the
    // listener (acpClient.onClose fires each registered cb exactly once).
    child.emitChildExit(0);
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(closeListenerFires).toBe(1);

    handle.dispose();
  });

  // Default-spawn path smoke (no injected spawnFn) — confirms wiring not broken.
  it("default spawnFn signature accepts AcpProcessOptions without throwing at construction", () => {
    expect(
      () =>
        new AcpProcess(
          {
            ompPath: "omp",
            cwd: "/tmp/proj",
            supportCwdFlag: true,
            execFn: async () => "omp/18.0.1\n",
          },
          defaultSpawn as unknown as Parameters<typeof AcpProcess>[1],
        ),
    ).not.toThrow();
  });

  // ---- TASK-002 cases #1..#4 (mcpServers regression + list/load wiring) ----

  /**
   * Read every NDJSON frame written to the fake child's stdin. PassThrough
   * stdio buffers chunks; parsing here mirrors what the real `omp acp`
   * process would receive on its stdin pipe.
   */
  function readStdinFrames(c: FakeChildProcess): Array<Record<string, unknown>> {
    const raw = (c.stdin as PassThrough).read() ?? "";
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // Case #1 — regression: session/new frame params deep-equal {cwd, mcpServers: []}
  it("session/new frame sends {cwd, mcpServers: []} (regression for latent -32603)", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/w",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void (async () => {
        // Drain initialize, then drain enough microtasks so the session/new
        // request frame has been written to stdin BEFORE the session/new
        // response lands.
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: 1, agentInfo: { version: "18.0.1" } },
          }) + "\n",
        );
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { sessionId: "sess-1" },
          }) + "\n",
        );
      })();
    });
    await startPromise;

    const frames = readStdinFrames(child);
    // Frame layout: [initialize id=1, initialized (notification), session/new id=2]
    const sessionNew = frames[2];
    expect(sessionNew).toBeDefined();
    expect(sessionNew?.["method"]).toBe("session/new");
    expect(sessionNew?.["params"]).toEqual({ cwd: "/w", mcpServers: [] });
  });

  // Case #2 — edge-flag: supportCwdFlag:false → spawn cwd present, no --cwd, envelope still has mcpServers
  it("supportCwdFlag:false still spawns cwd + session/new envelope carries mcpServers: []", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/w",
        supportCwdFlag: false,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void (async () => {
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: 1, agentInfo: { version: "18.0.1" } },
          }) + "\n",
        );
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { sessionId: "sess-1" },
          }) + "\n",
        );
      })();
    });
    await startPromise;

    expect(captured.options?.cwd).toBe("/w");
    expect(captured.args ?? []).not.toContain("--cwd");

    const frames = readStdinFrames(child);
    // Frame layout: [initialize id=1, initialized (notification), session/new id=2]
    const sessionNew = frames[2];
    expect(sessionNew?.["method"]).toBe("session/new");
    expect(sessionNew?.["params"]).toEqual({ cwd: "/w", mcpServers: [] });
  });

  // ---- TASK-012 (B11a) — mcpServers threaded into session/new when provided --

  it("session/new forwards a non-empty mcpServers array verbatim when AcpProcessOptions.mcpServers is set", async () => {
    const descriptor = {
      type: "http",
      name: "UnicDB",
      url: "http://127.0.0.1:54321",
      headers: [{ name: "Authorization", value: "Bearer test-token" }],
    };
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/w",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
        mcpServers: [descriptor],
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await startPromise;

    const frames = readStdinFrames(child);
    const sessionNew = frames[2];
    expect(sessionNew?.["method"]).toBe("session/new");
    expect(sessionNew?.["params"]).toEqual({ cwd: "/w", mcpServers: [descriptor] });
  });

  it("session/new still defaults to mcpServers: [] when AcpProcessOptions.mcpServers is omitted (no regression)", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/w",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await startPromise;

    const frames = readStdinFrames(child);
    const sessionNew = frames[2];
    expect(sessionNew?.["params"]).toEqual({ cwd: "/w", mcpServers: [] });
  });

  // Case #3 — edge-sessionLoad: handle.acp.sessionLoad returns replay buffer across same flush as result.
  it("handle.acp.sessionLoad resolves with replay buffer (window open across multi-flush)", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/w",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    const loadPromise = startPromise.then((handle) =>
      handle.acp.sessionLoad("s1", "/w"),
    );

    queueMicrotask(() => {
      void (async () => {
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: 1, agentInfo: { version: "18.0.1" } },
          }) + "\n",
        );
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { sessionId: "sess-1" },
          }) + "\n",
        );
        // Drain so handle is returned and sessionLoad() has been called and its
        // request frame written to stdin (id=3). Then respond + feed 2 notifications
        // in the same flush so the replay window absorbs them.
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "s1", delta: "n1" },
          }) + "\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "s1", delta: "n2" },
          }) + "\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: { configOptions: [], modes: {} },
          }) + "\n",
        );
      })();
    });

    const result = await loadPromise;

    // Replay buffer absorbs both notifications arriving in the same flush
    // as the load result. Window is NOT closed by result+settle (TASK-001 §F1
    // frozen semantics: closed only on the NEXT outgoing request/notify write).
    expect(result.configOptions).toEqual([]);
    expect(result.modes).toEqual({});
    expect(result.replay.closed).toBe(false);
    expect(result.replay.notifications).toEqual([
      { method: "session/update", params: { sessionId: "s1", delta: "n1" } },
      { method: "session/update", params: { sessionId: "s1", delta: "n2" } },
    ]);

    // Outgoing frame for session/load carries the evidence-frozen envelope.
    // Frame layout: [initialize, initialized (notification), session/new, session/load]
    const frames = readStdinFrames(child);
    const loadFrame = frames[3];
    expect(loadFrame?.["method"]).toBe("session/load");
    expect(loadFrame?.["params"]).toEqual({
      sessionId: "s1",
      cwd: "/w",
      mcpServers: [],
    });
  });

  // Case #4 — edge-list: sessionList propagates server error code/message verbatim.
  it("handle.acp.sessionList rejects with server error code + message intact", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/w",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    const listPromise = startPromise.then((handle) => handle.acp.sessionList());

    queueMicrotask(() => {
      void (async () => {
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: 1, agentInfo: { version: "18.0.1" } },
          }) + "\n",
        );
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { sessionId: "sess-1" },
          }) + "\n",
        );
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            error: { code: -32603, message: "boom" },
          }) + "\n",
        );
      })();
    });

    await expect(listPromise).rejects.toMatchObject({
      message: expect.stringContaining("boom"),
      code: -32603,
    });
  });

  // Case #5 — regression-lifecycle: existing suite (above) must keep passing. Implicit:
  // if any of the existing tests fail post-fix, vitest reports it. No explicit
  // assertion here — this test is the documentation anchor for the contract.

  // ---- TASK-006 (B4a/B4b/B10) ------------------------------------------------

  // R (B4a) — assert on the ACTUAL recorded frames, not a comment. Today (pre-fix)
  // the handshake writes only [initialize, session/new] — `initialized` is missing.
  it("handshake sends exactly initialize, initialized (notification, no id), session/new — in that order", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    const handle = await startPromise;

    const frames = readStdinFrames(child);
    expect(frames).toHaveLength(3);

    expect(frames[0]?.["method"]).toBe("initialize");
    expect(typeof frames[0]?.["id"]).toBe("number");

    expect(frames[1]?.["method"]).toBe("initialized");
    expect("id" in (frames[1] ?? {})).toBe(false);

    expect(frames[2]?.["method"]).toBe("session/new");
    expect(typeof frames[2]?.["id"]).toBe("number");

    // Happy — session id resolves from the session/new result.
    expect(handle.sessionId).toBe("01a02f96-beda-7564-b313-2d0e5e515a22");

    handle.dispose();
  });

  // R (B4b) — today (pre-fix) a stalled handshake hangs `start()` forever: no
  // timeout exists anywhere in AcpClient. After the fix it rejects within the
  // configured bound, the message names the phase ("initialize"), and the
  // child is killed (no orphan process).
  it("rejects within the configured bound when the agent never answers initialize; message names the phase; child killed", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
        requestTimeoutMs: 25,
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    // Deliberately never feed any stdout response — agent stays silent.
    const err = await startPromise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/initialize/i);
    expect((err as Error).message).toMatch(/timed out|timeout/i);
    expect(child.killed).toBe(true);
  });

  // R (B10) — today (pre-fix) stderr is discarded entirely. After the fix, a
  // startup error surfaces the stderr tail so omp's own auth/model/config
  // error text is visible instead of silently lost.
  it("surfaces the stderr tail in the startup error when the child exits non-zero before handshake completes", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void (async () => {
        // Wait for our production stderr listener (registered synchronously
        // during start()) to actually receive the chunk before exiting, so
        // the exit-triggered rejection races AFTER the tail is captured.
        const received = new Promise<void>((resolve) => {
          child.stderr.once("data", () => resolve());
        });
        (child.stderr as PassThrough).write("omp: auth failed: invalid API key\n");
        await received;
        child.emitChildExit(1);
      })();
    });

    const err = await startPromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("auth failed: invalid API key");
    expect((err as Error & { stderrTail?: string }).stderrTail).toContain(
      "auth failed: invalid API key",
    );
  });

  // Edge (backpressure) — 1 MB of stderr must be drained (no unbounded buffer,
  // no blocked child) and the retained tail bounded to <= 8 KB.
  it("drains 1 MB of stderr without unbounded buffering; retained tail is bounded to <= 8 KB", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void (async () => {
        const chunk = "x".repeat(64 * 1024); // 64 KB
        for (let i = 0; i < 16; i++) {
          // 16 * 64 KB = 1 MB total
          (child.stderr as PassThrough).write(chunk);
          await Promise.resolve();
        }
        child.emitChildExit(1);
      })();
    });

    const err = await startPromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const tail = (err as Error & { stderrTail?: string }).stderrTail ?? "";
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(8 * 1024);
  });

  // ---- Review Finding 1 (fix round 2): win32 cmd.exe quoting -----------------
  //
  // `shell: process.platform === "win32"` (Finding 2, prior round) makes Node
  // compose `cmd /d /s /c "<ompPath> <arg1> <arg2> ...>"` by PLAIN SPACE-JOINING
  // `command` + `args`, with no per-token quoting
  // (see lib/internal/child_process.js normalizeSpawnArguments). Two breakages
  // follow: an install path with spaces splits into multiple cmd.exe tokens,
  // and a cwd containing a shell metacharacter (e.g. "&") is interpreted by
  // cmd.exe as a command separator — arbitrary command execution at session
  // start. Node's own outer `"${composed}"` wrap does not protect against this:
  // since `/s` is also passed, cmd.exe's /c quote handling falls into its
  // "strip first char + strip LAST quote char in the line" fallback (per
  // `cmd /?`), which — when the composed string has no OTHER quotes — reduces
  // to stripping exactly the two outer quotes Node just added and nothing
  // else. So whatever quoting AcpProcess hands to spawnFn is exactly what
  // cmd.exe re-parses.
  describe("Review Finding 1 (fix round 2): win32 cmd.exe quoting", () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("quotes ompPath and args for cmd.exe so a path with spaces and a cwd containing '&' survive intact and cannot inject a second command", async () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const proc = new AcpProcess(
        {
          ompPath: "C:\\Program Files\\omp\\omp.cmd",
          cwd: "C:\\repo & calc",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const startPromise = proc.start();
      queueMicrotask(() => {
        void driveHandshake(child);
      });
      await startPromise;

      // shell:true on win32 is unchanged from the Finding 2 fix.
      expect(captured.options?.shell).toBe(true);

      // Every token handed to spawnFn must already be individually quoted:
      // the whole path (spaces and all) stays ONE token, and the cwd's "&"
      // is wrapped so cmd.exe cannot treat it as a command separator.
      expect(captured.command).toBe('"C:\\Program Files\\omp\\omp.cmd"');
      const args = captured.args ?? [];
      expect(args).toEqual(['"acp"', '"--cwd"', '"C:\\repo & calc"']);

      // Simulate exactly what Node's shell:true win32 path does next
      // (space-join command+args, then wrap the WHOLE thing in one more
      // pair of outer quotes for `cmd /d /s /c`), then simulate cmd.exe's
      // own /c quote-stripping fallback (strip first char + last quote
      // char of the line) — our inner per-token quotes must survive intact.
      const composed = [captured.command, ...args].join(" ");
      const cmdLine = `"${composed}"`;
      const afterCmdStrip = cmdLine.slice(1, -1);
      expect(afterCmdStrip).toBe(composed);
      expect(afterCmdStrip).toBe(
        '"C:\\Program Files\\omp\\omp.cmd" "acp" "--cwd" "C:\\repo & calc"',
      );
    });

    it("does not quote command/args on non-win32 (spawn path unchanged)", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "/usr/local/bin/omp",
          cwd: "/tmp/repo & calc",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );
      const startPromise = proc.start();
      queueMicrotask(() => {
        void driveHandshake(child);
      });
      await startPromise;

      expect(captured.options?.shell).toBe(false);
      expect(captured.command).toBe("/usr/local/bin/omp");
      expect(captured.args).toEqual(["acp", "--cwd", "/tmp/repo & calc"]);
    });
  });

  // ---- TASK-AIX05-101: ACP child lifecycle and bounded reaping -------------

  describe("TASK-AIX05-101: lifecycle, protocol mismatch, cancellation, bounded reap", () => {
    // #1 — happy: valid initialize + session/new reaches "ready"
    it("valid initialize + session/new reaches ready; onStateChange sees exactly [starting, ready]; no kill before teardown", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      queueMicrotask(() => {
        void driveHandshake(child);
      });
      const handle = await startPromise;

      expect(handle.state()).toBe("ready");
      expect(handle.sessionId).toBe("01a02f96-beda-7564-b313-2d0e5e515a22");
      expect(states).toEqual(["starting", "ready"]);
      // No kill signal sent during a successful handshake.
      expect(child.killSignals).toEqual([]);

      // dispose() is async: the SIGKILL escalation is bounded by
      // OMP_ACP_DISPOSE_TIMEOUT_MS (2000ms). The fake child ignores
      // SIGTERM, so the promise resolves via the SIGKILL timer.
      await handle.dispose();
      expect(handle.state()).toBe("stopped");
    });

    // #2 — edge: child exit while starting → crashed → fallback-builtin
    it("clean child exit while starting emits [starting, crashed, fallback-builtin] and rejects start()", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      // Exit cleanly (code=0) BEFORE the initialize response lands.
      queueMicrotask(() => {
        setTimeout(() => child.emitChildExit(0), 0);
      });

      await expect(startPromise).rejects.toThrow(/exited|exit|protocol|crash/i);
      // Drain microtasks so any post-reject state-change callbacks fire.
      for (let i = 0; i < 12; i++) await Promise.resolve();

      expect(states).toEqual(["starting", "crashed", "fallback-builtin"]);
      // The child has already exited on its own (code=0 during starting);
      // there is nothing left to reap. The classification path that owns
      // the "reap on starting exit" contract is test #6 (protocol
      // mismatch — child still alive at mismatch), not this one.
    });

    // #3 — edge: child exit while ready → exactly one "crashed" appended; onClose fires once
    it("ready crash emits exactly one 'crashed' appended; AcpClient.onClose fires exactly once", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      let closeFires = 0;
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      queueMicrotask(() => {
        void driveHandshake(child);
      });
      const handle = await startPromise;
      handle.acp.onClose(() => {
        closeFires += 1;
      });

      // Drain post-handshake microtasks, then crash the child.
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(states).toEqual(["starting", "ready"]);

      child.emitChildExit(1);
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // Exactly one "crashed" appended to the state sequence.
      expect(states).toEqual(["starting", "ready", "crashed"]);
      expect(handle.state()).toBe("crashed");
      expect(closeFires).toBe(1);

      // A second exit does NOT re-emit crashed and does NOT re-fire onClose.
      child.emitChildExit(1);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(states).toEqual(["starting", "ready", "crashed"]);
      expect(closeFires).toBe(1);
    });

    // #4 — edge: cancel during ready → cancelling → stopped (no crash/fallback)
    it("cancel() on a ready handle emits cancelling, then stopped on exit — no crash, no fallback", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      queueMicrotask(() => {
        void driveHandshake(child);
      });
      const handle = await startPromise;
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(states).toEqual(["starting", "ready"]);

      // First cancel(): transitions to cancelling, sends exactly one termination.
      handle.cancel();
      expect(handle.state()).toBe("cancelling");
      expect(child.killSignals).toEqual(["SIGTERM"]);

      // Second cancel() is idempotent — no extra kill signals.
      handle.cancel();
      expect(child.killSignals).toEqual(["SIGTERM"]);

      // Child exits after our termination.
      child.emitChildExit(0);
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // Final sequence: starting, ready, cancelling, stopped — NO crashed/fallback.
      expect(states).toEqual(["starting", "ready", "cancelling", "stopped"]);
      expect(handle.state()).toBe("stopped");
    });

    // #5 — edge: spawn failure transitions to fallback
    it("spawn error rejects start() and emits [starting, fallback-builtin]; no usable handle", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      queueMicrotask(() => child.emitSpawnError(new Error("spawn omp ENOENT")));

      await expect(startPromise).rejects.toThrow(/ENOENT|spawn/);
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // Terminal state is fallback-builtin; no "ready", no "crashed".
      expect(states[0]).toBe("starting");
      expect(states[states.length - 1]).toBe("fallback-builtin");
      expect(states).not.toContain("ready");
    });

    // #6 — edge: protocol version mismatch rejects with the pinned message
    it("incompatible initialize version rejects with pinned message; terminal state fallback-builtin; stdin never receives initialized or session/new", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      queueMicrotask(() => {
        // Drain a microtask so start() can register the initialize request,
        // then reply with an incompatible protocolVersion.
        setTimeout(() => {
          child.feedStdout(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: 2, agentInfo: { version: "99.0.0" } },
            }) + "\n",
          );
        }, 0);
      });

      const err = await startPromise.catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("OMP ACP protocol version mismatch: expected 1, received 2");

      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(states[states.length - 1]).toBe("fallback-builtin");

      // Stdin must NOT carry an `initialized` or `session/new` frame.
      const frames = readStdinFrames(child);
      const methods = frames.map((f) => f["method"]);
      expect(methods).not.toContain("initialized");
      expect(methods).not.toContain("session/new");

      // Child must have been terminated.
      expect(child.killSignals.length).toBeGreaterThan(0);
    });

    // #7 — regression: dispose has a bounded reap, ignores late exit
    it("dispose() has a bounded reap (OMP_ACP_DISPOSE_TIMEOUT_MS = 2000), escalates to SIGKILL once, reports stopped once, ignores late exit", async () => {
      const proc = new AcpProcess(
        {
          ompPath: "omp",
          cwd: "/w",
          supportCwdFlag: true,
          execFn: async () => "omp/18.0.1\n",
        },
        captureSpawn(child, captured),
      );

      const states: OmpEngineState[] = [];
      const startPromise = proc.start({
        onStateChange: (s) => states.push(s),
      });
      // The ready child ignores the initial SIGTERM (deferExitOnKill) and
      // stays alive until we manually emit an exit later.
      child.deferExitOnKill = true;
      queueMicrotask(() => {
        void driveHandshake(child);
      });
      const handle = await startPromise;
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // Now we are ready. The child is ignoring the initial SIGTERM until
      // we emit an exit ourselves.
      expect(states).toEqual(["starting", "ready"]);

      // Use fake timers so the 2000ms reap bound is testable.
      vi.useFakeTimers();
      const disposePromise = handle.dispose();
      // First kill is SIGTERM sent immediately. Schedule the escalation
      // (SIGKILL) at 2000ms.
      expect(child.killSignals).toEqual(["SIGTERM"]);

      // Advance just under the timeout: no SIGKILL yet.
      await vi.advanceTimersByTimeAsync(1500);
      expect(child.killSignals).toEqual(["SIGTERM"]);

      // Advance past the timeout: SIGKILL is sent.
      await vi.advanceTimersByTimeAsync(600);
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

      // The dispose promise resolves to "stopped" without a real exit.
      await vi.advanceTimersByTimeAsync(0);
      await disposePromise;
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(handle.state()).toBe("stopped");
      // "stopped" emitted exactly once.
      const stoppedCount = states.filter((s) => s === "stopped").length;
      expect(stoppedCount).toBe(1);

      // Late exit after dispose: no new state event, no further kill.
      const statesBeforeLate = [...states];
      const killsBeforeLate = [...child.killSignals];
      child.emitChildExit(0);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(states).toEqual(statesBeforeLate);
      expect(child.killSignals).toEqual(killsBeforeLate);

      vi.useRealTimers();
    });
  });
});

