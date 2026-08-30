// src/core/__tests__/sshTunnelManager.test.ts
// DBX-05 TASK-DBX05-002 — lifecycle against a FAKE ssh binary (no network).
// The manager spawns a single executable; we wrap "node fixture.mjs" behind a
// tiny shell shim so `spawn(sshPath, args)` runs the fixture without a shell.
import { describe, it, expect, afterAll } from "vitest";
import { join } from "path";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { SshTunnelManager } from "../sshTunnelManager";

const FAKE_SSH = join(__dirname, "fixtures", "fake-ssh.mjs");

/** Create a temp wrapper script: execs `node <fixture> "$@"`. */
function makeShim(): string {
  const dir = mkdtempSync(join(tmpdir(), "vsdb-ssh-"));
  const shim = join(dir, "fake-ssh-shim");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec node "${FAKE_SSH}" "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  return shim;
}

const shim = makeShim();
const cfg = { host: "bastion", port: 5432 } as const;
const managers: SshTunnelManager[] = [];
function freshMgr(): SshTunnelManager {
  const m = new SshTunnelManager(shim);
  managers.push(m);
  return m;
}
afterAll(() => {
  for (const m of managers) m.stopAll();
});

describe("SshTunnelManager (fixture ssh)", () => {
  it("start resolves with the fixture port", async () => {
    const mgr = freshMgr();
    const h = await mgr.start(cfg, "c1");
    expect(h.localPort).toBeTypeOf("number");
    expect(h.localPort).toBeGreaterThan(0);
    mgr.stopAll();
  });

  it("stop kills the child; list drains", async () => {
    const mgr = freshMgr();
    const h = await mgr.start(cfg, "c2");
    expect(mgr.list().length).toBe(1);
    const exited = new Promise<number | null>((res) =>
      h.child.on("exit", (code) => res(code)),
    );
    expect(mgr.stop("c2")).toBe(true);
    const code = await exited;
    expect([0, null]).toContain(code);
    expect(mgr.list().length).toBe(0);
  });

  it("double start is idempotent", async () => {
    const mgr = freshMgr();
    const a = await mgr.start(cfg, "c3");
    const b = await mgr.start(cfg, "c3");
    expect(b).toBe(a);
    mgr.stopAll();
    expect(mgr.list().length).toBe(0);
  });

  it("stopAll drains every tunnel", async () => {
    const mgr = freshMgr();
    await mgr.start(cfg, "c4a");
    await mgr.start(cfg, "c4b");
    expect(mgr.list().length).toBe(2);
    mgr.stopAll();
    expect(mgr.list().length).toBe(0);
  });
});
