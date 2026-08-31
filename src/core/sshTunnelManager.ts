// src/core/sshTunnelManager.ts
// DBX-05 TASK-DBX05-002 — runtime SSH tunnel lifecycle.
// Spawns `ssh` with the VALIDATED argv from ./sshTunnel — never a shell
// (`spawn("ssh", args)`, shell: false by default, no exec/execSync).
// No vscode import. Handles are in-memory only; dispose() drains everything.
import { spawn, type ChildProcess } from "child_process";
import { buildTunnelArgs, type TunnelConfig } from "./sshTunnel";

const READY_TIMEOUT_MS = 10_000;

export interface TunnelHandle {
  readonly key: string;
  /** Actual bound local port (resolved from ssh output). */
  readonly localPort: number;
  readonly child: ChildProcess;
}

/** Marker token added to spawned argv so `ps` parsing can identify our tunnels. */
const MARKER = "vsdb-tunnel";

export class SshTunnelManager {
  private readonly tunnels = new Map<string, TunnelHandle>();

  constructor(
    /** Injectable for tests — defaults to the real `ssh` binary on PATH. */
    private readonly sshPath: string = "ssh",
  ) {}

  /**
   * Resolve once the tunnel reports its listening line; kill + throw on
   * timeout/early-exit. Idempotent per key — a running tunnel is reused.
   */
  async start(cfg: TunnelConfig, key: string): Promise<TunnelHandle> {
    const existing = this.tunnels.get(key);
    if (existing) return existing;
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error(`invalid tunnel key: ${key}`);
    }

    const baseArgs = buildTunnelArgs({ ...cfg, localPort: 0 });
    // Marker via a VALID OpenSSH SetEnv assignment (NAME=VALUE — a bare
    // `SetEnv=vsdb-tunnel:key` makes ssh exit 255 with "Invalid SetEnv").
    // The value appears in `ps` output so parseTunnelProcLine can identify
    // our processes; the server only sees it when it accepts SetEnv.
    const args = [...baseArgs, "-o", `SetEnv=VSDB_TUNNEL=vsdb-tunnel:${key}`];

    const child = spawn(this.sshPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handle = await new Promise<TunnelHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`SSH tunnel did not report ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      let settled = false;
      const onExit = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`ssh exited before becoming ready (code ${code})`));
      };
      child.on("exit", onExit);

      // Buffer across chunk boundaries — the verbose listening line can be
      // split arbitrarily by the stream.
      let buffer = "";
      const scan = (chunk: Buffer | string) => {
        if (settled) return;
        buffer += chunk.toString();
        // `ssh -v` emits `Local forwarding listening on 127.0.0.1 port N.`
        // on stderr at the moment the local forward binds.
        const m = /Local forwarding listening on 127\.0\.0\.1 port (\d+)/.exec(buffer);
        if (m) {
          settled = true;
          clearTimeout(timer);
          const localPort = Number.parseInt(m[1], 10);
          child.removeListener("exit", onExit);
          child.on("exit", () => {
            // Child died later: drop the handle so a retry can start fresh.
            this.tunnels.delete(key);
          });
          const h: TunnelHandle = { key, localPort, child };
          this.tunnels.set(key, h);
          resolve(h);
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
    });
    return handle;
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
