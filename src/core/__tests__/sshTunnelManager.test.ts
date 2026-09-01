// src/core/__tests__/sshTunnelManager.test.ts
// DBX-05 TASK-DBX05-002 — lifecycle against a FAKE ssh binary (no network).
// The manager spawns a single executable; we wrap "node fixture.mjs" behind a
// tiny shell shim so `spawn(sshPath, args)` runs the fixture without a shell.
import { describe, it, expect, afterAll } from "vitest";
import { join } from "path";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import {
  SshTunnelManager,
  type TunnelExit,
} from "../sshTunnelManager";

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

/**
 * A shim variant that appends one byte per spawn invocation to a counter
 * file, so tests can PROVE a fresh process spawn happened (a stale `pending`
 * entry replaying a settled promise spawns nothing). Reading the counter
 * after a full settlement is race-free: the append happens when the child
 * process runs, strictly before that attempt can settle. The failing variant
 * counts then exits 1, so every attempt rejects with the existing
 * "exited before becoming ready" literal while still incrementing the count.
 */
function makeCountingShim(counterFile: string, opts?: { fail?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "vsdb-ssh-count-"));
  const shim = join(dir, "fake-ssh-count-shim");
  const tail = opts?.fail ? "exit 1\n" : `exec node "${FAKE_SSH}" "$@"\n`;
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf 'x' >> "${counterFile}"\n${tail}`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  return shim;
}

function spawnCount(counterFile: string): number {
  return readFileSync(counterFile, "utf8").length;
}

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

  // DBX-05 review round 2: a missing/unexecutable ssh binary emits `error`
  // (not `exit`) — start must reject promptly instead of crashing the host.
  it("rejects with a clear error when the ssh binary is missing", async () => {
    const mgr = new SshTunnelManager("/nonexistent/vsdb-missing-ssh");
    managers.push(mgr);
    await expect(mgr.start(cfg, "c5")).rejects.toThrow(
      /failed to start ssh|exited before becoming ready/,
    );
  });

  // ── RLX-03 TASK-RLX03-001 ────────────────────────────────────────────
  // Same-key concurrent starts coalesce; a post-ready unexpected exit is a
  // single observable TunnelExit event with intentional:false; a restart
  // receives a fresh handle/port proof.
  it("coalesces concurrent same-key starts then returns a fresh handle after unexpected exit", async () => {
    const mgr = freshMgr();
    const exits: TunnelExit[] = [];
    mgr.onDidExit((e) => exits.push(e));

    // Two concurrent calls before any readiness — must coalesce to ONE spawn
    // and resolve to the exact same handle. Coalescing contract: concurrent
    // callers share the SAME in-flight promise instance, not individually
    // wrapped variants.
    const p1 = mgr.start(cfg, "c1");
    const p2 = mgr.start(cfg, "c1");
    expect(p2).toBe(p1);
    const [a, b] = await Promise.all([p1, p2]);
    expect(b).toBe(a);

    // After readiness, kill the child externally (unexpected exit) and wait
    // for the typed exit event.
    const exited = new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (exits.length > 0) {
          clearInterval(i);
          resolve();
        }
      }, 5);
    });
    a.child.kill("SIGKILL");
    await exited;

    expect(mgr.list().length).toBe(0);
    expect(exits.length).toBe(1);
    expect(exits[0].key).toBe("c1");
    expect(exits[0].intentional).toBe(false);

    // A new start must be a fresh spawn (different handle/child) with a real
    // local port, NOT the previously cached handle.
    const c = await mgr.start(cfg, "c1");
    expect(c).not.toBe(a);
    expect(c.localPort).toBeGreaterThan(0);
    expect(c.child).not.toBe(a.child);
    mgr.stopAll();
  });

  // stop/stopAll mark intentional:true and remove the handle immediately;
  // a later start must NOT reuse the stopped handle.
  it("stop and stopAll mark child exits intentional before deleting handles", async () => {
    const mgr = freshMgr();
    const exits: TunnelExit[] = [];
    mgr.onDidExit((e) => exits.push(e));

    await mgr.start(cfg, "c2a");
    await mgr.start(cfg, "c2b");
    expect(mgr.list().length).toBe(2);

    expect(mgr.stop("c2a")).toBe(true);
    expect(mgr.list().length).toBe(1);

    mgr.stopAll();
    expect(mgr.list().length).toBe(0);

    // Wait for the exit events to flush (stopAll -> SIGTERM -> exit).
    await new Promise((r) => setTimeout(r, 100));

    const intentionalKeys = exits.filter((e) => e.intentional).map((e) => e.key).sort();
    expect(intentionalKeys).toEqual(["c2a", "c2b"]);

    // Restart after stop: must be a fresh handle, not a cached one.
    const restarted = await mgr.start(cfg, "c2a");
    expect(restarted.key).toBe("c2a");
    expect(restarted.localPort).toBeGreaterThan(0);
    mgr.stopAll();
  });

  // Two concurrent starts against a missing binary both reject with the
  // pre-existing error literal; the in-flight record is cleared so a later
  // start is a FRESH SPAWN (proved via the counting shim), not a replayed
  // settled rejection from a stale `pending` entry.
  it("coalesces a same-key missing-binary rejection and clears its in-flight record", async () => {
    const counterFile = join(mkdtempSync(join(tmpdir(), "vsdb-ssh-cnt-")), "spawns");
    writeFileSync(counterFile, "");
    const mgr = new SshTunnelManager(makeCountingShim(counterFile, { fail: true }));
    managers.push(mgr);

    const [r1, r2] = await Promise.allSettled([
      mgr.start(cfg, "bad"),
      mgr.start(cfg, "bad"),
    ]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    expect((r1 as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(
      /failed to start ssh|exited before becoming ready/.test(
        ((r1 as PromiseRejectedResult).reason as Error).message,
      ),
    ).toBe(true);
    expect(
      /failed to start ssh|exited before becoming ready/.test(
        ((r2 as PromiseRejectedResult).reason as Error).message,
      ),
    ).toBe(true);

    // Concurrent callers coalesced into ONE attempt: a single spawn happened
    // even though both callers reject with the same reason.
    expect(spawnCount(counterFile)).toBe(1);

    // Subsequent start must be a NEW attempt: a fresh spawn (counter grows
    // from 1 to 2) that again rejects (binary still missing). A stale
    // `pending` entry replaying the first rejection would keep the count at 1.
    const before = spawnCount(counterFile);
    expect(before).toBe(1);
    const r3 = await mgr.start(cfg, "bad").then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(
        /failed to start ssh|exited before becoming ready/.test(
          (r3.err as Error).message,
        ),
      ).toBe(true);
    }
    expect(spawnCount(counterFile)).toBe(2);
  });

  // Regression: different keys never share state.
  it("different keys retain independent live handles", async () => {
    const mgr = freshMgr();
    const a = await mgr.start(cfg, "c4a");
    const b = await mgr.start(cfg, "c4b");
    expect(mgr.list().length).toBe(2);
    expect(a.key).toBe("c4a");
    expect(b.key).toBe("c4b");

    const exits: TunnelExit[] = [];
    mgr.onDidExit((e) => exits.push(e));

    mgr.stop("c4a");
    expect(mgr.list().length).toBe(1);
    expect(mgr.list()[0].key).toBe("c4b");

    mgr.stopAll();
    await new Promise((r) => setTimeout(r, 100));
    expect(exits.map((e) => e.key).sort()).toEqual(["c4a", "c4b"]);
  });
});
