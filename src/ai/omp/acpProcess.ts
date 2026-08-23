// src/ai/omp/acpProcess.ts
// AcpProcess — TDD lifecycle wrapper cho `omp acp`.
//
// TASK-002 §Goal:
//   - Spawn real `omp acp` (no `--mode rpc`, no yolo/--approval-mode/--auto-approve).
//   - Spawn child process `cwd` is mandatory; `--cwd` flag is conditional on
//     TASK-001-evidenced support.
//   - Wire AcpClient (TASK-001) through a NDJSON transport against the child stdio.
//   - Run initialize → initialized → session/new to produce session metadata.
//   - Expose sessionId + version + dispose + onNotification/onServerRequest for TASK-004.
//
// Pure / injectable: spawnFn and execFn overridable; tests inject fakes.

import {
  spawn as defaultSpawn,
  exec as defaultExec,
} from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { AcpClient, type AcpTransport, type AcpNotificationHandler, type AcpServerRequestHandler } from "./acp";

export type AcpSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type AcpExecFn = (cmd: string) => Promise<string>;

export interface AcpProcessOptions {
  /**
   * Resolved omp binary path. Defaults to "omp"; callers should pass the path
   * from `detectOmp()` so missing binaries surface as a startup error here.
   */
  ompPath?: string;
  /** Workspace cwd — supplied to spawn() unconditionally. */
  cwd: string;
  /**
   * TASK-001 evidence: `omp acp --cwd <workspace>` accepted by omp 18.0.1.
   * Set to false to probe a server that does NOT accept --cwd; the spawn
   * option `cwd` always enforces the workspace boundary either way.
   */
  supportCwdFlag: boolean;
  execFn?: AcpExecFn;
}

export interface AcpStartHandlers {
  onNotification?: AcpNotificationHandler;
  onServerRequest?: AcpServerRequestHandler;
}

export interface AcpProcessHandle {
  acp: AcpClient;
  sessionId: string;
  version: string;
  /** Tear down the AcpClient + best-effort terminate the child. */
  dispose: () => void;
}

interface ChildLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
}

export class AcpProcess {
  private readonly opts: AcpProcessOptions;
  private readonly spawnFn: AcpSpawnFn;
  private readonly execFn: AcpExecFn;
  private child: ChildLike | null = null;
  private acp: AcpClient | null = null;
  private disposed = false;

  constructor(
    opts: AcpProcessOptions,
    spawnFn: AcpSpawnFn = defaultSpawn as unknown as AcpSpawnFn,
  ) {
    this.opts = opts;
    this.spawnFn = spawnFn;
    this.execFn = opts.execFn ?? defaultExecFn;
  }

  /**
   * Spawn omp + complete initialize / initialized / session/new handshake.
   * Resolves with `{ acp, sessionId, version, dispose }`.
   */
  async start(handlers: AcpStartHandlers = {}): Promise<AcpProcessHandle> {
    const ompPath = this.opts.ompPath ?? "omp";
    const args: string[] = ["acp"];
    if (this.opts.supportCwdFlag) {
      args.push("--cwd", this.opts.cwd);
    }

    const child = this.spawnFn(ompPath, args, {
      // Pipe stdin/stdout/stderr so AcpClient can talk NDJSON to the child.
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
    });
    const spawnLike: ChildLike = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      on: ((ev: string, cb: (...a: unknown[]) => void): void => {
        child.on(ev as "exit", (...a: unknown[]) => {
          if (ev === "exit") {
            (cb as (code: number | null) => void)(a[0] as number | null);
          } else if (ev === "error") {
            (cb as (err: Error) => void)(a[0] as Error);
          }
        });
      }) as ChildLike["on"],
      kill: (signal?: string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
    this.child = spawnLike;

    // Race: ready handshake vs spawn 'error' / child 'exit' failure.
    const startError = new Promise<never>((_, reject) => {
      spawnLike.on("error", (err) => reject(err));
      spawnLike.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`omp acp exited before handshake (code=${code ?? "null"})`));
        }
      });
    });

    const transport: AcpTransport = createAcpLineTransport(spawnLike.stdin, spawnLike.stdout);
    const acp = new AcpClient(transport);
    if (handlers.onNotification !== undefined) acp.onNotification(handlers.onNotification);
    if (handlers.onServerRequest !== undefined) acp.onServerRequest(handlers.onServerRequest);

    try {
      const initResult = (await Promise.race([
        acp.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "vsdb-extension", version: "1.5.1" },
        }),
        startError,
      ])) as { agentInfo?: { version?: string } };
      const sessionResult = (await Promise.race([
        acp.request("session/new", { cwd: this.opts.cwd }),
        startError,
      ])) as { sessionId?: unknown };

      const sessionId = typeof sessionResult.sessionId === "string"
        ? sessionResult.sessionId
        : "";

      // Surface omp version through execFn (best-effort; ignored on failure).
      let version = "unknown";
      try {
        const raw = await this.execFn(`${ompPath} --version`);
        const match = raw.match(/omp\/(\S+)/);
        if (match !== null && match[1] !== undefined) {
          version = match[1];
        }
      } catch {
        /* keep "unknown" */
      }
      // Prefer agent-reported version if available.
      const agentVersion = initResult.agentInfo?.version;
      if (typeof agentVersion === "string" && agentVersion.length > 0) {
        version = agentVersion;
      }

      return {
        acp,
        sessionId,
        version,
        dispose: () => this.disposeClient(),
      };
    } catch (err) {
      this.disposeClient();
      throw err;
    }
  }

  private disposeClient(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.acp !== null) {
      try {
        this.acp.dispose();
      } catch {
        /* best-effort */
      }
      this.acp = null;
    }
    if (this.child !== null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function defaultExecFn(cmd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    defaultExec(cmd, (err, stdout) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function createAcpLineTransport(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): AcpTransport {
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
      if (closed) return;
      try {
        stdin.write(line);
      } catch {
        /* EPIPE after child exit — drop silently */
      }
    },
    onLine: (cb: (line: string) => void) => {
      listeners.add(cb);
    },
    close: () => {
      if (closed) return;
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
