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
 * socket table (lsof on macOS/BSD, ss on Linux) — spawn only, no shell.
 * Undeterminable owner => fail closed.
 */
function listeningPids(port: number): Promise<Set<number>> {
  const isMac = process.platform === "darwin";
  const cmd = isMac ? "lsof" : "ss";
  const args = isMac
    ? ["-t", `-iTCP:${port}`, "-sTCP:LISTEN", "-n", "-P"]
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
      if (isMac) {
        // lsof -t prints one PID per line.
        for (const line of Buffer.concat(out).toString().split("\n")) {
          const pid = Number.parseInt(line.trim(), 10);
          if (Number.isInteger(pid)) pids.add(pid);
        }
      } else {
        // ss -ltnp: users:(("ssh",pid=1234,fd=3))
        const text = Buffer.concat(out).toString();
        for (const m of text.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      }
      done(pids);
    });
  });
}

export class SshTunnelManager {
  private readonly tunnels = new Map<string, TunnelHandle>();

  constructor(
    /** Injectable for tests — defaults to the real `ssh` binary on PATH. */
    private readonly sshPath: string = "ssh",
  ) {}

  /**
   * Resolve once the local forward accepts TCP connections; kill + throw on
   * timeout/early-exit/spawn-error. Idempotent per key — a running tunnel is
   * reused.
   *
   * Readiness is NOT derived from ssh debug output: OpenSSH prints
   * "Local forwarding listening on … port N" from the REQUESTED port before
   * bind, so with an ephemeral -L port it would report 0. Instead the manager
   * pre-allocates a free local port, passes it explicitly, and polls the
   * bound socket until it accepts.
   */
  async start(cfg: TunnelConfig, key: string): Promise<TunnelHandle> {
    const existing = this.tunnels.get(key);
    if (existing) return existing;
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error(`invalid tunnel key: ${key}`);
    }

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
    child.once("exit", () => {
      // Child died later: drop the handle so a retry can start fresh.
      if (this.tunnels.get(key) === h) this.tunnels.delete(key);
    });
    return h;
  }

  stop(key: string): boolean {
    const h = this.tunnels.get(key);
    if (!h) return false;
    this.tunnels.delete(key);
    h.child.kill("SIGTERM");
    return true;
  }

  list(): TunnelHandle[] {
    return [...this.tunnels.values()];
  }

  stopAll(): void {
    for (const h of this.tunnels.values()) {
      h.child.kill("SIGTERM");
    }
    this.tunnels.clear();
  }

  dispose(): void {
    this.stopAll();
  }
}
