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

/** Bounded tail of the child's stderr retained for startup-error messages. */
const STDERR_TAIL_LIMIT = 8 * 1024; // 8 KB

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
  /**
   * TASK-006 (B4b): per-request bound in ms passed through to AcpClient.
   * Default 30_000 (AcpClient's DEFAULT_ACP_REQUEST_TIMEOUT_MS); tests pass
   * a small value so a stalled handshake fails fast instead of hanging.
   */
  requestTimeoutMs?: number;
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

    // TASK-006 (B10): drain stderr continuously from spawn onwards — an
    // unread pipe can block the child once its OS buffer fills, and omp's
    // own auth/model/config error text was previously discarded entirely.
    // Keep a bounded tail so startup errors can surface it.
    let stderrTail = "";
    spawnLike.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail += text;
      if (stderrTail.length > STDERR_TAIL_LIMIT) {
        stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_LIMIT);
      }
    });

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
    const acp = new AcpClient(transport, { requestTimeoutMs: this.opts.requestTimeoutMs });
    if (handlers.onNotification !== undefined) acp.onNotification(handlers.onNotification);
    if (handlers.onServerRequest !== undefined) acp.onServerRequest(handlers.onServerRequest);

    // Post-handshake child-exit watchdog: when the real `omp acp` process
    // exits after handshake, dispose the AcpClient exactly once. The client's
    // onClose listeners (e.g. the panel's permission coordinator) fire
    // BEFORE the transport is closed, so they still get one shot at writing
    // the cancelled result on a writable transport. This is the production
    // default-deny path for "process exit" — without it, the only thing that
    // ever settles a pending permission is the unrelated 60s timeout.
    let exited = false;
    const onChildExit = (_code: number | null): void => {
      if (exited) return;
      exited = true;
      this.disposeClient();
    };
    spawnLike.on("exit", onChildExit);

    // Bind the client to the handle so disposeClient() can actually dispose
    // it. Previously this.acp was never assigned, so the post-exit dispose
    // was a no-op and the panel's onClose hook never fired on real exit.
    this.acp = acp;

    try {
      const initResult = (await Promise.race([
        acp.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "vsdb-extension", version: "1.5.1" },
        }),
        startError,
      ])) as { agentInfo?: { version?: string } };

      // TASK-006 (B4a): the handshake is initialize → initialized →
      // session/new. `initialized` is a notification (no `id`, no reply
      // expected) — sending it was previously skipped entirely.
      acp.notify("initialized", {});

      const sessionResult = (await Promise.race([
        acp.request("session/new", { cwd: this.opts.cwd, mcpServers: [] }),
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
      throw attachStderrTail(err, stderrTail);
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

/**
 * TASK-006 (B10): append the retained stderr tail (if any) to a startup
 * error's message and expose it as `.stderrTail` for callers/tests that want
 * it without string-parsing the message.
 */
function attachStderrTail(err: unknown, tail: string): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  if (tail.length > 0) {
    base.message = `${base.message}\n--- omp stderr (tail) ---\n${tail}`;
  }
  (base as Error & { stderrTail?: string }).stderrTail = tail;
  return base;
}

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
