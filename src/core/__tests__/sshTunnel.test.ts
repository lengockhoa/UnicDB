// src/core/__tests__/sshTunnel.test.ts
// DBX-05 TASK-DBX05-002 — pure argv builder + ps parser.
import { describe, it, expect } from "vitest";
import { buildTunnelArgs, parseTunnelProcLine, TunnelError } from "../sshTunnel";

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

