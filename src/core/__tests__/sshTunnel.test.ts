// src/core/__tests__/sshTunnel.test.ts
// DBX-05 TASK-DBX05-002 — pure argv builder + ps parser.
// TASK-ARP04-001 — pinned strict host-key checking: buildTunnelArgs emits
// `-o StrictHostKeyChecking=yes` and can NEVER emit a host-key-relaxing
// option (policy: docs/decisions/0001-ssh-host-key-identity-policy.md §4–§6).
import { describe, it, expect } from "vitest";
import { buildTunnelArgs, parseTunnelProcLine, TunnelError } from "../sshTunnel";

/** Relaxing host-key policies that must never appear in generated argv. */
const RELAXING_HOST_KEY_RE = /StrictHostKeyChecking=(no|ask|accept-new|off)/i;

/** Extract the TunnelError code thrown by fn, failing the test otherwise. */
function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TunnelError);
    return (e as TunnelError).code;
  }
  throw new Error("expected a TunnelError to be thrown");
}

describe("buildTunnelArgs", () => {
  it("renders default argv for minimal config", () => {
    const args = buildTunnelArgs({ host: "bastion.example.com", port: 5433 });
    expect(args).toContain("bastion.example.com");
    expect(args).toContain("-N");
    expect(args).toContain("-T");
    expect(args).toContain("-v"); // verbose — required for the readiness line
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "5433",
        "-L",
        "127.0.0.1:0:127.0.0.1:5433",
        "-o",
        "ExitOnForwardFailure=yes",
      ]),
    );
  });

  // DBX-05 review regression: the bastion SSH port and the forwarded
  // destination port are DIFFERENT — tunnel.port is the ssh -p, targetPort
  // is the database port on the other side of the bastion.
  it("separates bastion port from forwarded target port", () => {
    const args = buildTunnelArgs({
      host: "bastion",
      port: 22,
      targetPort: 5432,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "22",
        "-L",
        "127.0.0.1:0:127.0.0.1:5432",
      ]),
    );
  });


  it("renders user + identity + explicit local port", () => {
    const args = buildTunnelArgs({
      host: "jump",
      user: "devops",
      port: 5432,
      identityFile: "/home/dev/.ssh/id_ed25519",
      localPort: 15432,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-i",
        "/home/dev/.ssh/id_ed25519",
        "-l",
        "devops",
        "-L",
        "127.0.0.1:15432:127.0.0.1:5432",
      ]),
    );
  });

  // TASK-ARP04-001 case 1 (RED-first): minimal config pins strict checking.
  it("pins strict host-key checking on minimal config", () => {
    const args = buildTunnelArgs({ host: "bastion", port: 5433 });
    const idx = args.indexOf("StrictHostKeyChecking=yes");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The pinned option must travel as its own two tokens: ["-o", value].
    expect(args[idx - 1]).toBe("-o");
    // Exactly once — a duplicate pair could let a later override win.
    expect(args.filter((a) => a === "StrictHostKeyChecking=yes")).toHaveLength(1);
  });

  // TASK-ARP04-001 case 2 (guard pin — already GREEN before the flag lands;
  // locks the invariant so no future change can relax host-key checking).
  it("never emits a relaxing host-key option", () => {
    const shapes: Array<Parameters<typeof buildTunnelArgs>[0]> = [
      { host: "bastion" },
      { host: "bastion", user: "devops", identityFile: "/home/dev/.ssh/id_ed25519" },
      { host: "bastion", identityFile: "/home/dev/.ssh/id_ed25519" },
    ];
    for (const cfg of shapes) {
      const joined = buildTunnelArgs(cfg).join(" ");
      expect(joined, `relaxing token in argv for ${JSON.stringify(cfg)}`).not.toMatch(
        RELAXING_HOST_KEY_RE,
      );
      expect(joined, `UserKnownHostsFile in argv for ${JSON.stringify(cfg)}`).not.toContain(
        "UserKnownHostsFile",
      );
    }
  });

  // TASK-ARP04-001 case 3 (guard): non-relaxing arg layout is unchanged.
  it("keeps the existing -i/-l/-p/-L layout beside the pin", () => {
    const args = buildTunnelArgs({
      host: "jump",
      user: "devops",
      port: 2222,
      identityFile: "/home/dev/.ssh/id_ed25519",
      targetPort: 5432,
      localPort: 15432,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-i",
        "/home/dev/.ssh/id_ed25519",
        "-l",
        "devops",
        "-p",
        "2222",
        "-L",
        "127.0.0.1:15432:127.0.0.1:5432",
        "-o",
        "StrictHostKeyChecking=yes",
      ]),
    );
  });

  // TASK-ARP04-001 case 4 (guard): BatchMode coexistence — an unknown host
  // key cannot fall through to an interactive TOFU prompt.
  it("keeps BatchMode=yes alongside the strict pin", () => {
    const args = buildTunnelArgs({ host: "bastion" });
    expect(args).toEqual(
      expect.arrayContaining(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]),
    );
    expect(args.indexOf("BatchMode=yes")).toBeLessThan(
      args.indexOf("StrictHostKeyChecking=yes"),
    );
  });

  // TASK-ARP04-001 case 5 (guard): option pairs stay separate tokens.
  it("emits the pin as a separate -o token pair, never glued", () => {
    const args = buildTunnelArgs({
      host: "bastion",
      user: "devops",
      identityFile: "/home/dev/.ssh/id_ed25519",
    });
    for (const token of args) {
      expect(token).not.toBe("-oStrictHostKeyChecking=yes");
      expect(token).not.toBe("-oStrictHostKeyChecking");
    }
    // Every -o is followed by exactly one value token.
    args.forEach((token, i) => {
      if (token === "-o") {
        expect(args[i + 1]).toBeDefined();
        expect(args[i + 1]).not.toBe("-o");
      }
    });
  });

  // TASK-ARP04-001 case 6 (regression): validation behavior is unchanged.
  it("still rejects malformed identity/port inputs with the same codes", () => {
    expect(errorCodeOf(() => buildTunnelArgs({ host: "" }))).toBe("emptyHost");
    expect(
      errorCodeOf(() => buildTunnelArgs({ host: "h", identityFile: "relative/key" })),
    ).toBe("badIdentityFile");
    expect(errorCodeOf(() => buildTunnelArgs({ host: "h", port: 70000 }))).toBe("badPort");
  });

  it("rejects empty host", () => {
    expect(() => buildTunnelArgs({ host: "" })).toThrow(TunnelError);
  });

  it("rejects host with whitespace / metacharacters", () => {
    expect(() => buildTunnelArgs({ host: "a b" })).toThrow(TunnelError);
    expect(() => buildTunnelArgs({ host: "h;rm" })).toThrow(TunnelError);
    expect(() => buildTunnelArgs({ host: "h$(x)" })).toThrow(TunnelError);
  });

  it("rejects user with forbidden characters", () => {
    expect(() => buildTunnelArgs({ host: "h", user: "a b" })).toThrow(TunnelError);
    expect(() => buildTunnelArgs({ host: "h", user: "a@b" })).toThrow(TunnelError);
  });

  it("rejects out-of-range ports", () => {
    expect(() => buildTunnelArgs({ host: "h", port: 0 })).toThrow(TunnelError);
    expect(() => buildTunnelArgs({ host: "h", port: 70000 })).toThrow(TunnelError);
    expect(() => buildTunnelArgs({ host: "h", localPort: 80 })).toThrow(TunnelError);
    expect(() => buildTunnelArgs({ host: "h", targetPort: 0 })).toThrow(TunnelError);
  });

  it("rejects identityFile with whitespace or relative path", () => {
    expect(() =>
      buildTunnelArgs({ host: "h", identityFile: "my key" }),
    ).toThrow(TunnelError);
    expect(() =>
      buildTunnelArgs({ host: "h", identityFile: "relative/key" }),
    ).toThrow(TunnelError);
  });
});

describe("parseTunnelProcLine", () => {
  it("parses our marker line", () => {
    const p = parseTunnelProcLine(
      "12345 ssh -v -N -T -o SetEnv=VSDB_TUNNEL=vsdb-tunnel:conn1 bastion",
    );
    expect(p).toEqual({ pid: 12345, localPort: undefined });
  });

  it("parses marker with port", () => {
    const p = parseTunnelProcLine(
      " 999 ssh ... VSDB_TUNNEL=vsdb-tunnel:15432 ... bastion",
    );
    expect(p).toEqual({ pid: 999, localPort: 15432 });
  });
});

