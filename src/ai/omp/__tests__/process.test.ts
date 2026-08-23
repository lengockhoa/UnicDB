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

// #8
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
});