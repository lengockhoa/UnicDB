// src/ai/omp/__tests__/process.test.ts
// Unit tests cho src/ai/omp/process.ts (OmpProcess). TASK-001 §Test Cases #8, #9.
//
// Injectable spawn/exec — không chạy omp thật. Fake spawn giả lập child
// process với stdout/stderr; viết ready frame để trigger waitReady().
import { describe, it, expect } from "vitest";
import { OmpProcess } from "../process";
import { OmpRpcClient, type RpcTransport } from "../rpc";

// ---- Fakes -------------------------------------------------------------------

interface FakeChild {
  stdout: { on: (ev: "data", cb: (b: Buffer) => void) => void };
  stderr: { on: (ev: "data", cb: (b: Buffer) => void) => void };
  on(ev: string, cb: (...args: unknown[]) => void): void;
  kill(sig?: string): void;
  killed: boolean;
}

class FakeSpawnedProcess implements FakeChild {
  stdout = {
    on: (_ev: "data", _cb: (b: Buffer) => void): void => {
      /* noop */
    },
  };
  stderr = {
    on: (_ev: "data", _cb: (b: Buffer) => void): void => {
      /* noop */
    },
  };
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(ev: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(ev) ?? [];
    list.push(cb);
    this.listeners.set(ev, list);
  }
  kill(_sig?: string): void {
    this.killed = true;
    for (const cb of this.listeners.get("exit") ?? []) {
      cb(0);
    }
  }
  killed = false;

  emitExit(code: number | null): void {
    for (const cb of this.listeners.get("exit") ?? []) {
      cb(code);
    }
  }
}

/** Transport that pipes stdout from the FakeSpawnedProcess to RPC. */
class ChildTransport implements RpcTransport {
  written: string[] = [];
  private listener: ((line: string) => void) | null = null;
  private buffer = "";

  constructor(private readonly child: FakeSpawnedProcess) {
    this.child.stdout.on("data", (b: Buffer) => {
      this.buffer += b.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0 && this.listener) {
          this.listener(line);
        }
      }
    });
  }
  write(line: string): void {
    this.written.push(line);
  }
  onLine(cb: (line: string) => void): void {
    this.listener = cb;
  }
  close(): void {
    /* noop */
  }

  /** Manually push a frame into the RPC pipeline (simulating server output). */
  feed(line: string): void {
    if (this.listener) {
      this.listener(line);
    }
  }
}

function fakeSpawn(child: FakeSpawnedProcess): (
  cmd: string,
  args: string[],
  opts: unknown,
) => FakeChild {
  return (_cmd: string, _args: string[], _opts: unknown) => child;
}

// ---- Tests -------------------------------------------------------------------


// EventEmitter-based fake child that mimics a real Node child process:
// stdin is a real Writable stream that buffers writes and tracks end();
// stdout/stderr are Readable streams that emit 'data' on feedStdout().
// This is the regression target for the broken default transport.
class FakeWritable {
  writes: string[] = [];
  ended = false;
  private finishListeners: Array<() => void> = [];
  write(chunk: string | Buffer): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  }
  end(): void {
    this.ended = true;
    for (const cb of this.finishListeners) {
      cb();
    }
  }
  on(ev: string, cb: () => void): void {
    if (ev === "finish") {
      this.finishListeners.push(cb);
    }
  }
}

class FakeReadable {
  encoding: BufferEncoding | null = null;
  private dataListeners: Array<(b: Buffer | string) => void> = [];
  on(ev: "data", cb: (b: Buffer | string) => void): void {
    if (ev === "data") {
      this.dataListeners.push(cb);
    }
  }
  setEncoding(enc: BufferEncoding): this {
    this.encoding = enc;
    return this;
  }
  emitData(chunk: string): void {
    const payload: Buffer | string =
      this.encoding !== null ? chunk : Buffer.from(chunk, "utf8");
    for (const cb of this.dataListeners) {
      cb(payload);
    }
  }
}

class EventEmitterFakeChild {
  stdin = new FakeWritable();
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(ev: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners[ev] ?? [];
    list.push(cb);
    this.listeners[ev] = list;
  }
  kill(_signal?: string): void {
    for (const cb of this.listeners["exit"] ?? []) {
      cb(0);
    }
  }
  feedStdout(chunk: string): void {
    this.stdout.emitData(chunk);
  }
  emitError(err: Error): void {
    for (const cb of this.listeners["error"] ?? []) {
      cb(err);
    }
  }
  emitExit(code: number | null): void {
    for (const cb of this.listeners["exit"] ?? []) {
      cb(code);
    }
  }
}

describe("OmpProcess", () => {
  it("start: spawns with --mode rpc --approval-mode yolo --no-session --cwd; returns rpc + parsed version", async () => {
    const child = new FakeSpawnedProcess();
    const transport = new ChildTransport(child);
    const captured: { cmd?: string; args?: string[]; opts?: unknown } = {};

    const spawnFn = (cmd: string, args: string[], opts: unknown): FakeChild => {
      captured.cmd = cmd;
      captured.args = args;
      captured.opts = opts;
      return child;
    };

    const proc = new OmpProcess(
      {
        cwd: "/tmp/proj",
        execFn: async () => "omp/18.0.1\n",
      },
      spawnFn,
    );

    const startPromise = proc.start(transport);
    queueMicrotask(() => {
      transport.feed(JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      }));
    });
    const result = await startPromise;

    expect(captured.cmd).toBe("omp");
    expect(captured.args).toEqual([
      "--mode",
      "rpc",
      "--approval-mode",
      "yolo",
      "--no-session",
      "--cwd",
      "/tmp/proj",
    ]);
    expect(captured.opts).toBeDefined();
    expect(result.version).toBe("omp/18.0.1");
    expect(result.rpc).toBeInstanceOf(OmpRpcClient);

    void result;
  });

  // #9
  it("child exit: onExit fired with code, rpc disposed (pending request rejects)", async () => {
    const child = new FakeSpawnedProcess();
    const transport = new ChildTransport(child);
    const proc = new OmpProcess({ cwd: "/tmp/proj", execFn: async () => "omp/18.0.1\n" },
      fakeSpawn(child));

    const startPromise = proc.start(transport);
    queueMicrotask(() => {
      transport.feed(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    });
    const { rpc } = await startPromise;

    let exitCode: number | null | undefined;
    proc.onExit((code) => {
      exitCode = code;
    });

    child.emitExit(7);

    expect(exitCode).toBe(7);

    const pending = rpc.request({ type: "prompt", message: "x" });
    await expect(pending).rejects.toThrow("disposed");
  });
  // Regression for TASK-001 reviewer critical #1: default transport in
  // production must wire child stdin/stdout bidirectionally. Without an
  // injected transport, OmpProcess.start() must build a transport that:
  //   - writes framed JSON lines to child.stdin (so omp receives commands)
  //   - reads framed JSON lines from child.stdout (so omp frames reach the
  //     RPC client and resolve pending requests)
  // Prior implementation created createLineTransport(stdout) whose write()
  // was a no-op — silently dropping every prompt/abort/host_tool_result.
  it("default transport wires child stdin<->stdout bidirectionally (no injected transport)", async () => {
    const child = new EventEmitterFakeChild();
    // Spawn options must NOT use stdio "ignore" for stdin; production must
    // pipe stdin so omp can read commands.
    const captured: { opts?: unknown } = {};
    const spawnFn = (_cmd: string, _args: string[], opts: unknown): EventEmitterFakeChild => {
      captured.opts = opts;
      return child;
    };
    const proc = new OmpProcess(
      { cwd: "/tmp/proj", execFn: async () => "omp/18.0.1\n" },
      spawnFn as unknown as Parameters<typeof OmpProcess>[1],
    );
    const startPromise = proc.start();
    setImmediate(() => {
      child.feedStdout(JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      }) + "\n");
    });


    const { rpc } = await startPromise;

    // 1. Spawn stdio must pipe stdin (not "ignore"), otherwise omp sees EOF.
    const stdio = (captured.opts as { stdio?: unknown } | undefined)?.stdio;
    expect(stdio).toEqual(["pipe", "pipe", "pipe"]);

    // 2. Bytes flow RPC → child.stdin when a request is sent.
    const reqPromise = rpc.request({ type: "prompt", message: "hi" });
    // Allow microtask queue to drain so request() runs transport.write().
    await new Promise<void>((r) => setImmediate(r));
    expect(child.stdin.writes).toEqual([
      JSON.stringify({ type: "prompt", message: "hi" }) + "\n",
    ]);

    // 3. Bytes flow child.stdout → RPC; response resolves the pending request.
    child.feedStdout(JSON.stringify({
      type: "response",
      command: "prompt",
      success: true,
      data: { ok: true },
    }) + "\n");
    const result = await reqPromise;
    expect(result).toEqual({ ok: true });

    // 4. Closing the RPC disposes transport, which ends stdin (no EPIPE).
    rpc.dispose();
    expect(child.stdin.ended).toBe(true);
  });

  // Regression for TASK-001 reviewer important #2: spawn 'error' must reject
  // start() promptly. Without this, omp missing on PATH waits for the 10s
  // waitReady timeout instead of failing immediately.
  it("start() rejects when spawn emits 'error' (e.g. omp missing)", async () => {
    const child = new EventEmitterFakeChild();
    const spawnFn = (): EventEmitterFakeChild => child;
    const proc = new OmpProcess(
      { cwd: "/tmp/proj", execFn: async () => "omp/18.0.1\n" },
      spawnFn as unknown as Parameters<typeof OmpProcess>[1],
    );

    const startPromise = proc.start();
    setImmediate(() => {
      child.emitError(new Error("spawn omp ENOENT"));
    });

    await expect(startPromise).rejects.toThrow(/ENOENT|spawn/);
  });
});