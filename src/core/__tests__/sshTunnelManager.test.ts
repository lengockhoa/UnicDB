// src/core/__tests__/sshTunnelManager.test.ts
// DBX-05 TASK-DBX05-002 — lifecycle against a FAKE ssh binary (no network).
// The manager spawns a single executable; we wrap "node fixture.mjs" behind a
// tiny shell shim so `spawn(sshPath, args)` runs the fixture without a shell.
// ARP-04 TASK-ARP04-002 — adds per-key isolation / fail-closed PID-proof /
// spawned-argv strict-pin cases on top of the existing suite.
import { describe, it, expect, afterAll } from "vitest";
import { join } from "path";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import {
  SshTunnelManager,
  type TunnelExit,
} from "../sshTunnelManager";

const FAKE_SSH = join(__dirname, "fixtures", "fake-ssh.mjs");
const FAKE_SSH_FOREIGN = join(__dirname, "fixtures", "fake-ssh-foreign.mjs");

/** Create a temp wrapper script: execs `node <fixture> "$@"`. */
function makeShim(fixture: string = FAKE_SSH, opts?: {
  recordArgvTo?: string;
  env?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "vsdb-ssh-"));
  const shim = join(dir, "fake-ssh-shim");
  // CASE 6: recording shim — dumps the spawned "$*" argv string, then execs
  // the fixture. Mirrors makeCountingShim's append-then-exec pattern (the
  // append happens when the child runs, strictly before it can settle).
  const record = opts?.recordArgvTo
    ? `printf '%s\\n' "$*" >> "${opts.recordArgvTo}"\n`
    : "";
  const envLines = Object.entries(opts?.env ?? {})
    .map(([k, v]) => `${k}="${v}" export ${k}\n`)
    .join("");
  writeFileSync(
    shim,
    `#!/bin/sh\n${envLines}${record}exec node "${fixture}" "$@"\n`,
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

/** Wait until a file exists (fixture control files), with a deadline. */
async function waitForFile(
  path: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  for (let i = 0; i < timeoutMs / 50; i++) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(path);
}

/** Poll whether a PID is still alive (SIGKILL contract for case 4). */
async function isPidAlive(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return false;
    }
  }
  return true;
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

  // ── ARP-04 TASK-ARP04-002 ────────────────────────────────────────────
  // Case 1 (happy/regression pin): same-key reuse returns the IDENTICAL
  // handle instance — no second spawn, no per-key state leak.
  it("same-key reuse returns the identical handle", async () => {
    const mgr = freshMgr();
    const a = await mgr.start(cfg, "k1");
    const b = await mgr.start(cfg, "k1");
    expect(b).toBe(a);
    expect(mgr.list().length).toBe(1);
    expect(b.key).toBe("k1");
    mgr.stopAll();
  });

  // Case 2 (edge: isolation): different keys stay independent; stop("a")
  // removes exactly "a" and a post-stopAll start of "b" is a FRESH handle
  // (new child, fresh port), never a cached/stopped one.
  it("different-key isolation under stop then fresh handle after stopAll", async () => {
    const mgr = freshMgr();
    const a = await mgr.start(cfg, "a");
    const b = await mgr.start(cfg, "b");
    expect(mgr.list().length).toBe(2);
    expect(b).not.toBe(a);

    expect(mgr.stop("a")).toBe(true);
    expect(mgr.list().length).toBe(1);
    expect(mgr.list()[0].key).toBe("b");

    mgr.stopAll();
    expect(mgr.list().length).toBe(0);

    const b2 = await mgr.start(cfg, "b");
    expect(b2).not.toBe(b);
    expect(b2.key).toBe("b");
    expect(b2.localPort).toBeGreaterThan(0);
    expect(b2.child).not.toBe(b.child);
    mgr.stopAll();
  });

  // Case 3 (edge: late exit): an externally SIGKILLed child removes ONLY its
  // own handle and emits exactly one TunnelExit with intentional:false; the
  // other key's handle stays live.
  it("unexpected post-ready exit removes only its own handle", async () => {
    const mgr = freshMgr();
    const exits: TunnelExit[] = [];
    mgr.onDidExit((e) => exits.push(e));

    await mgr.start(cfg, "a");
    const b = await mgr.start(cfg, "b");
    expect(mgr.list().length).toBe(2);

    const exited = new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (exits.length > 0) {
          clearInterval(i);
          resolve();
        }
      }, 5);
    });
    // Externally kill child "a" — the manager did not request this.
    const a = mgr.list().find((h) => h.key === "a")!;
    a.child.kill("SIGKILL");
    await exited;

    expect(exits.length).toBe(1);
    expect(exits[0].key).toBe("a");
    expect(exits[0].intentional).toBe(false);

    expect(mgr.list().length).toBe(1);
    expect(mgr.list()[0].key).toBe("b");
    // "b" must still be a live child process.
    expect(b.child.killed).toBe(false);
    expect(b.child.exitCode).toBeNull();
    mgr.stopAll();
  });

  // Case 4 (edge: PID mismatch fails closed): the fake-ssh-foreign fixture's
  // DETACHED grandchild binder wins the pickFreeLocalPort race, so the LISTEN
  // socket on the pre-allocated port is owned by a PID ≠ child.pid. Today's
  // proveOwnership (sshTunnelManager.ts:258-282) retries until listeningPids
  // is non-empty, compares, and must SIGKILL the child + reject — never route
  // traffic through a foreign listener. Assertion targets the CONTRACT:
  // rejection matching /port <N> is held by another process/ + child killed.
  it("rejects and SIGKILLs the child when a foreign process holds the port", async () => {
    const controlDir = mkdtempSync(join(tmpdir(), "vsdb-foreign-ctl-"));
    // Hand the fixture its control dir via the shim's environment.
    const shim = makeShim(FAKE_SSH_FOREIGN, {
      env: { VSDB_TEST_FOREIGN_DIR: controlDir },
    });
    const mgr = new SshTunnelManager(shim);
    managers.push(mgr);

    let childPid = 0;
    let binderPid = 0;
    try {
      await expect(mgr.start(cfg, "k4")).rejects.toThrow(
        /port \d+ is held by another process/,
      );

      expect(await waitForFile(join(controlDir, "child-pid"))).toBe(true);
      expect(await waitForFile(join(controlDir, "binder-pid"))).toBe(true);
      childPid = Number(readFileSync(join(controlDir, "child-pid"), "utf8"));
      binderPid = Number(readFileSync(join(controlDir, "binder-pid"), "utf8"));
      expect(binderPid).toBeGreaterThan(0);
      expect(childPid).toBeGreaterThan(0);

      // Fail closed: the impostor child was SIGKILLed (signal, not code).
      const childUp = await isPidAlive(childPid);
      expect(childUp).toBe(false);
      // And never as a managed SIGTERM — SIGKILL cannot be caught.
      expect(existsSync(join(controlDir, "caught-sigterm"))).toBe(false);
    } finally {
      // The test owns the detached binder: terminate it so the port is
      // released even on failure paths.
      if (binderPid > 0) {
        try {
          process.kill(binderPid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  });

  // Case 5 (edge: idempotent stop): stop on a missing key, a repeat stop,
  // and a stop after stopAll all return false without throwing.
  it("stop on missing or repeated keys is a safe false", async () => {
    const mgr = freshMgr();
    expect(mgr.stop("missing")).toBe(false);

    await mgr.start(cfg, "k1");
    mgr.stopAll();
    expect(mgr.stop("gone")).toBe(false);

    const m2 = freshMgr();
    await m2.start(cfg, "k1");
    expect(m2.stop("k1")).toBe(true);
    expect(m2.stop("k1")).toBe(false);
    expect(mgr.stop("k1")).toBe(false);
  });

  // Case 6 (edge, spawn-path pin): the spawned argv INHERITS the pinned
  // `-o StrictHostKeyChecking=yes` from buildTunnelArgs (TASK-ARP04-001) —
  // the manager spreads the builder output by construction and must not be
  // able to strip or relax it. Proved end-to-end: a recording shim logs the
  // actual spawned argv, `start` succeeds against the fixture, and the logged
  // argv carries the strict pair with no relaxing token.
  it("spawned argv inherits the pinned strict host-key flag", async () => {
    const argvFile = join(mkdtempSync(join(tmpdir(), "vsdb-ssh-argv-")), "argv.log");
    writeFileSync(argvFile, "");
    const mgr = new SshTunnelManager(makeShim(FAKE_SSH, { recordArgvTo: argvFile }));
    managers.push(mgr);

    await mgr.start(cfg, "k6");
    mgr.stopAll();

    // Race-free read: the shim's append happens when the child runs,
    // strictly before this start attempt could have settled.
    const argv = readFileSync(argvFile, "utf8");
    const tokens = argv.trim().split(/\s+/);
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens).toContain("StrictHostKeyChecking=yes");
    // The strict pair appears as ADJACENT argv elements somewhere in the
    // argv (the manager appends its own `-o SetEnv=…` marker pair after the
    // builder output, so this need not be the last -o pair — but it must
    // exist as a real `-o StrictHostKeyChecking=yes` option).
    const strictIdx = tokens.indexOf("StrictHostKeyChecking=yes");
    expect(strictIdx).toBeGreaterThan(0);
    expect(tokens.slice(strictIdx - 1, strictIdx + 1)).toEqual([
      "-o",
      "StrictHostKeyChecking=yes",
    ]);
    // No relaxing variant anywhere in the argv.
    expect(argv).not.toMatch(/StrictHostKeyChecking=(no|ask|accept-new|off)\b/);
    expect(argv).not.toMatch(/UserKnownHostsFile/);
  });
});
