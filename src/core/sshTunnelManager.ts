// src/core/sshTunnelManager.ts
// DBX-05 TASK-DBX05-002 — runtime SSH tunnel lifecycle.
// Spawns `ssh` with the VALIDATED argv from ./sshTunnel — never a shell
// (`spawn("ssh", args)`, shell: false by default, no exec/execSync).
// No vscode import. Handles are in-memory only; dispose() drains everything.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { buildTunnelArgs, type TunnelConfig } from "./sshTunnel";

const READY_TIMEOUT_MS = 10_000;
/** Grace after ssh's forward line: bind failures (port stolen) exit fast —
 * waiting this long past the line means ssh's bind actually succeeded. */
const READY_QUIET_MS = 400;

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
 * Race (a local process binding the port between our release and ssh's
 * bind) is handled FAIL-CLOSED, not assumed away: OpenSSH binds AFTER it
 * prints the verbose forward line, and if the port is taken its bind fails
 * and (ExitOnForwardFailure=yes) the process exits immediately. The manager
 * therefore only accepts readiness after a quiet period in which ssh stays
 * alive past the bind step — see READY_QUIET_MS in start(). An impostor
 * listener can never pass: either ssh's bind succeeds (the impostor cannot
 * also bind — the kernel rejects a second listener) or ssh exits and the
 * start is rejected. No window remains in which DB traffic can reach a
 * foreign listener through a "ready" handle.
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
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(quiet);
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

      // OpenSSH prints the forward line BEFORE bind(); a port thief makes
      // ssh exit right after the line. Only trust readiness once ssh has
      // stayed alive past the bind step.
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const armQuiet = () => {
        quiet = setTimeout(() => {
          if (!exited && sawLine) finish();
          // If the child died in the meantime the exit handler rejects.
        }, READY_QUIET_MS);
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
          armQuiet();
          // Drain the verbose pipes from here on so they never fill.
          child.stdout?.resume();
          child.stderr?.resume();
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
