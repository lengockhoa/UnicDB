// src/core/sshTunnelManager.ts
// DBX-05 TASK-DBX05-002 — runtime SSH tunnel lifecycle.
// Spawns `ssh` with the VALIDATED argv from ./sshTunnel — never a shell
// (`spawn("ssh", args)`, shell: false by default, no exec/execSync).
// No vscode import. Handles are in-memory only; dispose() drains everything.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect as tcpConnect } from "node:net";
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
 * Bind an ephemeral port, read it, and release it. ssh then re-binds it in
 * the -L forward. Racy in theory (TOCTOU), but the window is milliseconds
 * and the manager verifies actual liveness with a TCP probe below.
 */
function pickFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
function portAlive(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
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
            `ssh exited before becoming ready (code ${code ?? "signal"})`,
          ),
        );
      });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      const poll = async () => {
        while (!exited && !settled && Date.now() < deadline) {
          if (await portAlive(localPort)) {
            finish();
            return;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      void poll();
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
