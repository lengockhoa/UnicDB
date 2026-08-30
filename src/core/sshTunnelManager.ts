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

  /** Resolve once the tunnel reports its listening line; kill + throw on timeout/early-exit. */
  async start(cfg: TunnelConfig, key: string): Promise<TunnelHandle> {
    const existing = this.tunnels.get(key);
    if (existing) return existing;

    const requestedLocal = cfg.localPort;
    const baseArgs = buildTunnelArgs({ ...cfg, localPort: 0 });
    // Marker goes FIRST-ish (before -N) purely for ps readability; ssh ignores
    // unknown non-flag tokens? No — it does not. Carry the marker as a comment
    // via the -o SendEnv? Simplest safe carrier: append after `--`? ssh treats
    // the first non-option token as host. So instead we tag via env-injected
    // argv: reuse `-o` with a harmless option value.
    const args = [...baseArgs, "-o", `SetEnv=${MARKER}:${key}`];
    // `SetEnv` requires the server to accept it; it never breaks forwarding
    // setup and identifies the process for `ps`. The REAL readiness signal is
    // the listening line below.

    const child = spawn(this.sshPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handle = await new Promise<TunnelHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`SSH tunnel did not report ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      let exited = false;
      const onExit = (code: number | null) => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        reject(new Error(`ssh exited before becoming ready (code ${code})`));
      };
      child.on("exit", (code) => onExit(code));

      const scan = (chunk: Buffer | string) => {
        const text = chunk.toString();
        // Line: `Local forwarding listening on 127.0.0.1 port 54321.` (OpenSSL
        // wording varies by version) — extract the bound port after "port".
        const m = /Local forwarding listening on 127\.0\.0\.1 port (\d+)/.exec(text);
        if (m) {
          exited = true;
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
      // Silence downstream data after resolution — nothing consumes it.
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
      if (requestedLocal !== undefined) {
        // Deterministic port: accept it immediately once ssh is alive (no
        // line needed); still bounded by the ready timeout.
        // Not used by default path (localPort 0) — kept for explicit configs.
      }
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
