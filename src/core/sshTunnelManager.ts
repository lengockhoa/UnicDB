// src/core/sshTunnelManager.ts
// DBX-05 TASK-DBX05-002 — runtime SSH tunnel lifecycle.
// Spawns `ssh` with the VALIDATED argv from ./sshTunnel — never a shell
// (`spawn("ssh", args)`, shell: false by default, no exec/execSync).
// No vscode import. Handles are in-memory only; dispose() drains everything.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { buildTunnelArgs, type TunnelConfig } from "./sshTunnel";

const READY_TIMEOUT_MS = 10_000;

export interface TunnelHandle {
  readonly key: string;
  /** The local port ssh was told to bind (pre-allocated by the manager). */
  readonly localPort: number;
  readonly child: ChildProcess;
}

/**
 * One-time terminal event for a tunnel child that had reached the
 * returned-handle lifecycle. `intentional` distinguishes manager-issued
 * stops (SIGTERM via stop/stopAll) from unexpected exits. `code`/`signal`
 * mirror the underlying ChildProcess exit.
 */
export interface TunnelExit {
  readonly key: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly intentional: boolean;
}

/** Subscription token returned by {@link SshTunnelManager.onDidExit}. */
export interface TunnelExitSubscription {
  dispose(): void;
}

/** Marker token added to spawned argv so `ps` parsing can identify our tunnels. */
const MARKER = "vsdb-tunnel";

/**
 * Bind an ephemeral port, read it, and release it for ssh to re-bind.
 *
 * A local process could race for the released port. That is not trusted:
 * readiness additionally requires IDENTITY PROOF — see verifyListener below.
 */
function pickFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Identity proof for the local forward: the LISTEN socket on 127.0.0.1:port
 * must be owned by the ssh child we spawned. Checked with the platform's
 * socket table — spawn only, no shell. Undeterminable owner => fail closed.
 *
 * Supported platforms:
 * - macOS/BSD: lsof -t -iTCP:<port> -sTCP:LISTEN -n -P (PID per line)
 * - Linux:     ss -ltnp 'sport = :<port>' (users:(("ssh",pid=N,...)))
 * - Windows:   netstat -ano -p tcp (LISTENING rows; -ano works without admin)
 */
function listeningPids(port: number): Promise<Set<number>> {
  const platform = process.platform;
  const cmd =
    platform === "darwin" || platform === "freebsd" || platform === "openbsd"
      ? "lsof"
      : platform === "win32"
        ? "netstat"
        : "ss";
  const args =
    cmd === "lsof"
      ? ["-t", `-iTCP:${port}`, "-sTCP:LISTEN", "-n", "-P"]
      : cmd === "netstat"
        ? ["-ano", "-p", "tcp"]
        : ["-ltnp", `sport = :${port}`];
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    const done = (pids: Set<number>) => {
      child.kill("SIGKILL");
      resolve(pids);
    };
    const timer = setTimeout(() => done(new Set()), 2_000);
    child.on("error", () => {
      clearTimeout(timer);
      done(new Set()); // tool unavailable -> fail closed
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const pids = new Set<number>();
      const text = Buffer.concat(out).toString();
      if (cmd === "lsof") {
        // One PID per line.
        for (const line of text.split("\n")) {
          const pid = Number.parseInt(line.trim(), 10);
          if (Number.isInteger(pid)) pids.add(pid);
        }
      } else if (cmd === "netstat") {
        // TCP    127.0.0.1:5432    0.0.0.0:0    LISTENING    12345
        const listenPort = `:${port}`;
        for (const line of text.split("\n")) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 5) continue;
          if (!cols[3].toUpperCase().startsWith("LISTENING")) continue;
          const local = cols[1];
          if (!local.endsWith(listenPort)) continue;
          const pid = Number.parseInt(cols[4], 10);
          if (Number.isInteger(pid)) pids.add(pid);
        }
      } else {
        // ss -ltnp: users:(("ssh",pid=1234,fd=3))
        for (const m of text.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      }
      done(pids);
    });
  });
}

export class SshTunnelManager {
  private readonly tunnels = new Map<string, TunnelHandle>();
  /** In-flight same-key start() calls — coalesced to one shared promise. */
  private readonly pending = new Map<string, Promise<TunnelHandle>>();
  /** TunnelExit listeners registered via onDidExit. */
  private readonly exitListeners = new Set<(exit: TunnelExit) => void>();
  /** Children whose exit was requested by stop/stopAll (intentional). */
  private readonly intentional = new WeakSet<ChildProcess>();

  constructor(
    /** Injectable for tests — defaults to the real `ssh` binary on PATH. */
    private readonly sshPath: string = "ssh",
  ) {}

  /**
   * Subscribe to post-ready tunnel child exits. The listener fires EXACTLY
   * ONCE per child that reached the returned-handle lifecycle — never for
   * children that failed readiness (those reject `start()` instead).
   */
  onDidExit(listener: (exit: TunnelExit) => void): TunnelExitSubscription {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  private emitExit(exit: TunnelExit): void {
    for (const listener of this.exitListeners) {
      try {
        listener(exit);
      } catch {
        // Listener errors must never break the tunnel lifecycle.
      }
    }
  }

  /**
   * Resolve once the local forward accepts TCP connections; kill + throw on
   * timeout/early-exit/spawn-error. Idempotent per key — a running tunnel is
   * reused.
   *
   * Readiness = ssh's forward line + listener PID identity proof (see
   * listeningPids): the pre-allocated local port's LISTEN socket must be
   * owned by this ssh child before any DB traffic is allowed through.
   */
  async start(cfg: TunnelConfig, key: string): Promise<TunnelHandle> {
    const existing = this.tunnels.get(key);
    if (existing) return existing;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error(`invalid tunnel key: ${key}`);
    }

    const attempt = this.spawnAndProve(cfg, key);
    this.pending.set(key, attempt);
    // Settlement cleanup: the in-flight record must clear on BOTH outcomes so
    // a later start() is a fresh attempt rather than a replayed rejection.
    const clear = () => {
      if (this.pending.get(key) === attempt) this.pending.delete(key);
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private async spawnAndProve(
    cfg: TunnelConfig,
    key: string,
  ): Promise<TunnelHandle> {

    const localPort = await pickFreeLocalPort();
    const args = [
      ...buildTunnelArgs({ ...cfg, localPort }),
      "-o",
      `SetEnv=VSDB_TUNNEL=${MARKER}:${key}`,
    ];

    const child = spawn(this.sshPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let sawLine = false;
      let checking = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners("error");
        err ? reject(err) : resolve();
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error(`SSH tunnel not ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      child.once("error", (err) => {
        finish(new Error(`failed to start ssh: ${err.message}`));
      });

      let exited = false;
      child.once("exit", (code) => {
        exited = true;
        finish(
          new Error(
            `ssh exited before becoming ready (code ${code ?? "signal"}) — ` +
              `port ${localPort} may be taken or unreachable`,
          ),
        );
      });

      /**
       * After ssh's forward line: prove the LISTEN socket on our port is
       * owned by THIS ssh child. Defeats a local impostor that won the
       * pickFreeLocalPort race — its PID will not match. Fail closed when
       * ownership cannot be determined.
       */
      const proveOwnership = async () => {
        if (checking || settled) return;
        checking = true;
        const pids = await listeningPids(localPort);
        if (settled) return;
        if (pids.size === 0) {
          // ssh may not have completed bind yet — retry after a beat.
          checking = false;
          setTimeout(proveOwnership, 200);
          return;
        }
        if (pids.has(child.pid ?? -1)) {
          finish();
          // Drain the verbose pipes so they never fill and block ssh.
          child.stdout?.resume();
          child.stderr?.resume();
        } else {
          child.kill("SIGKILL");
          finish(
            new Error(
              `port ${localPort} is held by another process (pids ${[...pids].join(",")}) — refusing to route DB traffic`,
            ),
          );
        }
      };

      const scan = (chunk: Buffer | string) => {
        if (settled) {
          drain(chunk);
          return;
        }
        buffer += chunk.toString();
        const re = new RegExp(
          `Local forwarding listening on 127\\.0\\.0\\.1 port ${localPort}\\b`,
        );
        if (!sawLine && re.test(buffer)) {
          sawLine = true;
          void proveOwnership();
        }
      };
      const drain = (_chunk: Buffer | string) => {};
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
    });

    const h: TunnelHandle = { key, localPort, child };
    this.tunnels.set(key, h);
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      // Terminal event for a child that reached the returned-handle
      // lifecycle. Drop the handle FIRST so a follow-up start() observes
      // a clean map and proceeds to a fresh spawn with a new ephemeral
      // port + listener PID proof. Then emit the typed exit exactly once.
      const intentional = this.intentional.has(child);
      if (this.tunnels.get(key) === h) this.tunnels.delete(key);
      this.emitExit({ key, code, signal, intentional });
    });
    return h;
  }

  stop(key: string): boolean {
    const h = this.tunnels.get(key);
    if (!h) return false;
    this.tunnels.delete(key);
    // Mark intent BEFORE SIGTERM so the post-ready exit handler classifies
    // this as a managed shutdown, not an unexpected failure.
    this.intentional.add(h.child);
    h.child.kill("SIGTERM");
    return true;
  }

  list(): TunnelHandle[] {
    return [...this.tunnels.values()];
  }

  stopAll(): void {
    for (const h of this.tunnels.values()) {
      this.intentional.add(h.child);
      h.child.kill("SIGTERM");
    }
    this.tunnels.clear();
  }

  dispose(): void {
    this.stopAll();
  }
}
