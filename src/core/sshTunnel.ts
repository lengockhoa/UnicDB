// src/core/sshTunnel.ts
// DBX-05 TASK-DBX05-002 — pure SSH tunnel argv builder + ps-line parser.
// No vscode import. Spawns NOTHING: this module only validates and renders
// the ssh argv so `sshTunnelManager` can child_process.spawn it WITHOUT a
// shell (injection surface = zero shell interpolation by construction).

/** Connection-level tunnel settings (subset of ConnectionConfig.tunnel). */
export interface TunnelConfig {
  /** Bastion host ssh connects to. */
  host: string;
  /** Bastion SSH port (the `-p` value); default 22. */
  port?: number;
  /** Database port to forward to from the bastion (`-L …:<targetPort>`). */
  targetPort?: number;
  user?: string;
  identityFile?: string;
  /** Requested local port; default 0 → ssh picks an ephemeral one. */
  localPort?: number;
}

export type TunnelErrorCode =
  | "emptyHost"
  | "badHostChars"
  | "badUserChars"
  | "badPort"
  | "badLocalPort"
  | "badIdentityFile";

export class TunnelError extends Error {
  readonly code: TunnelErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: TunnelErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
    this.details = details;
  }
}

/** Host/user charset: letters, digits, dot, underscore, hyphen. No `@`, no whitespace, no shell metacharacters. */
const SAFE_HOST_RE = /^[A-Za-z0-9._-]+$/;

function validate(cfg: TunnelConfig): void {
  if (typeof cfg.host !== "string" || cfg.host.length === 0) {
    throw new TunnelError("emptyHost", "tunnel host must be a non-empty string");
  }
  if (!SAFE_HOST_RE.test(cfg.host)) {
    throw new TunnelError(
      "badHostChars",
      `tunnel host contains forbidden characters: ${cfg.host}`,
      { host: cfg.host },
    );
  }
  if (cfg.user !== undefined && !SAFE_HOST_RE.test(cfg.user)) {
    throw new TunnelError(
      "badUserChars",
      `tunnel user contains forbidden characters: ${cfg.user}`,
      { user: cfg.user },
    );
  }
  if (
    cfg.port !== undefined &&
    (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)
  ) {
    throw new TunnelError("badPort", "tunnel port must be an integer 1..65535", {
      port: cfg.port,
    });
  }
  if (
    cfg.targetPort !== undefined &&
    (!Number.isInteger(cfg.targetPort) ||
      cfg.targetPort < 1 ||
      cfg.targetPort > 65535)
  ) {
    throw new TunnelError(
      "badPort",
      "tunnel targetPort must be an integer 1..65535",
      { targetPort: cfg.targetPort },
    );
  }
  if (
    cfg.localPort !== undefined &&
    (!Number.isInteger(cfg.localPort) ||
      (cfg.localPort !== 0 && (cfg.localPort < 1024 || cfg.localPort > 65535)))
  ) {
    throw new TunnelError(
      "badLocalPort",
      "local port must be 0 (ephemeral) or an integer 1024..65535",
      { localPort: cfg.localPort },
    );
  }
  if (cfg.identityFile !== undefined) {
    const id = cfg.identityFile;
    if (
      id.length === 0 ||
      /\s/.test(id) ||
      (!id.startsWith("/") && !id.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(id))
    ) {
      throw new TunnelError(
        "badIdentityFile",
        "identityFile must be an absolute path without whitespace",
        { identityFile: id },
      );
    }
  }
}

/**
 * Render the ssh argv for a local port-forward:
 *   ssh [-i identity] [-p bastionPort] [user@]host -v -N -L 127.0.0.1:<local>:127.0.0.1:<targetPort>
 * The manager appends nothing else; `localPort` 0 lets ssh choose ephemeral.
 * `-v` is required: `Local forwarding listening on …` is an OpenSSH debug
 * message that only appears at verbose log level — the manager's readiness
 * signal depends on it.
 */
export function buildTunnelArgs(cfg: TunnelConfig): string[] {
  validate(cfg);
  const args: string[] = [];
  if (cfg.identityFile !== undefined) args.push("-i", cfg.identityFile);
  if (cfg.user !== undefined) args.push("-l", cfg.user);
  if (cfg.port !== undefined) args.push("-p", String(cfg.port));
  args.push(cfg.host);
  args.push("-v");
  args.push("-N");
  args.push("-T");
  args.push("-o", "ExitOnForwardFailure=yes");
  args.push("-o", "BatchMode=yes");
  // ADR 0001 (docs/decisions/0001-ssh-host-key-identity-policy.md §4):
  // remote identity is fail-closed by construction — the host key must
  // already be in the user's known_hosts (no UserKnownHostsFile override,
  // no TOFU/accept-new). Pinned here so platform defaults or ssh_config
  // drift (§2–§3) can never relax host-key checking for the tunnel.
  args.push("-o", "StrictHostKeyChecking=yes");
  const local = cfg.localPort !== undefined ? cfg.localPort : 0;
  const target = cfg.targetPort ?? cfg.port ?? 5432;
  args.push("-L", `127.0.0.1:${local}:127.0.0.1:${target}`);
  return args;
}

export interface TunnelProc {
  pid: number;
  localPort?: number;
}

/**
 * Parse one `ps -o pid=,args=` line carrying our `UnicDB-tunnel` marker.
 * Returns null for foreign lines (header, other processes, empty input).
 * The manager tags spawned processes with `UnicDB-tunnel:<localPort>` in argv.
 */
export function parseTunnelProcLine(line: string): TunnelProc | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const m = /^(\d+)\s+(.*)$/.exec(trimmed);
  if (!m) return null;
  const args = m[2];
  if (!args.includes("UnicDB-tunnel")) return null;
  const portMatch = /UnicDB-tunnel:(\d+)/.exec(args);
  return {
    pid: Number.parseInt(m[1], 10),
    localPort: portMatch ? Number.parseInt(portMatch[1], 10) : undefined,
  };
}
