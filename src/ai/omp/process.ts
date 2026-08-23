// src/ai/omp/process.ts
// OmpProcess — wrapper quanh việc spawn `omp --mode rpc …` và tạo OmpRpcClient.
// Pure / injectable: spawnFn và execFn đều overridable; tests inject fakes.

import { spawn as defaultSpawn, exec as defaultExec } from "child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "child_process";
import { OmpRpcClient, type RpcTransport } from "./rpc";

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type ExecFn = (cmd: string) => Promise<string>;

export interface OmpProcessOptions {
  ompPath?: string;
  cwd: string;
  extraArgs?: ReadonlyArray<string>;
  execFn?: ExecFn;
}

interface SpawnLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
}

export class OmpProcess {
  private readonly opts: OmpProcessOptions;
  private readonly spawnFn: SpawnFn;
  private readonly execFn: ExecFn;
  private child: SpawnLike | null = null;
  private rpc: OmpRpcClient | null = null;
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private disposed = false;

  constructor(opts: OmpProcessOptions, spawnFn: SpawnFn = defaultSpawn as unknown as SpawnFn) {
    this.opts = opts;
    this.spawnFn = spawnFn;
    this.execFn = opts.execFn ?? defaultExecFn;
  }

  /**
   * Spawn omp + wait for ready. Trả về rpc + version (parse từ `${omp} --version`).
   */
  async start(transport?: RpcTransport): Promise<{ rpc: OmpRpcClient; version: string }> {
    const ompPath = this.opts.ompPath ?? "omp";
    const args: string[] = [
      "--mode",
      "rpc",
      "--approval-mode",
      "yolo",
      "--no-session",
      "--cwd",
      this.opts.cwd,
    ];
    if (this.opts.extraArgs !== undefined) {
      args.push(...this.opts.extraArgs);
    }
    const child = this.spawnFn(ompPath, args, {
      // Pipe stdin so omp receives prompt/abort/host_tool_result frames;
      // stdio:"ignore" closes stdin at birth → omp treats EOF as terminate.
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
    });
    const spawnLike: SpawnLike = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      on: ((ev: string, cb: (...args: unknown[]) => void): void => {
        child.on(ev as "exit", (...a: unknown[]) => {
          if (ev === "exit") {
            (cb as (code: number | null) => void)(a[0] as number | null);
          } else if (ev === "error") {
            (cb as (err: Error) => void)(a[0] as Error);
          }
        });
      }) as SpawnLike["on"],
      kill: (signal?: string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
    this.child = spawnLike;
    spawnLike.on("exit", (code) => {
      for (const cb of this.exitListeners) {
        try {
          cb(code);
        } catch {
          /* listener errors must not break the chain */
        }
      }
      this.disposeRpc();
    });
    // Forward spawn 'error' (e.g. omp missing → ENOENT) so waitReady/start
    // rejects promptly instead of waiting 10s for the ready timeout.
    const startError = new Promise<never>((_, reject) => {
      spawnLike.on("error", (err) => {
        reject(err);
        this.disposeRpc();
      });
    });

    const rpcTransport: RpcTransport =
      transport ?? createLineTransport(spawnLike.stdin, spawnLike.stdout);
    const rpc = new OmpRpcClient(rpcTransport);
    this.rpc = rpc;
    await Promise.race([rpc.waitReady(), startError]);

    let version = "unknown";
    try {
      const raw = await this.execFn(`${ompPath} --version`);
      const match = raw.match(/omp\/(\S+)/);
      if (match !== null && match[1] !== undefined) {
        version = match[1];
      }
    } catch {
      /* keep default */
    }

    return { rpc, version };
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitListeners.push(cb);
  }

  kill(): void {
    if (this.child === null) {
      return;
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* best-effort */
    }
  }

  private disposeRpc(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.rpc !== null) {
      try {
        this.rpc.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- helpers -----------------------------------------------------------------

function defaultExecFn(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    defaultExec(cmd, (err, stdout) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function createLineTransport(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): RpcTransport {
  const listeners = new Set<(line: string) => void>();
  let buffer = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        for (const cb of listeners) {
          cb(line);
        }
      }
    }
  });
  let closed = false;
  return {
    write: (line: string) => {
      if (closed) {
        return;
      }
      try {
        stdin.write(line);
      } catch {
        /* EPIPE after child exit — drop silently; rpc.dispose will fire soon. */
      }
    },
    onLine: (cb: (line: string) => void) => {
      listeners.add(cb);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      listeners.clear();
      try {
        stdin.end();
      } catch {
        /* best-effort */
      }
    },
  };
}