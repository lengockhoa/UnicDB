#!/usr/bin/env node
// Test fixture (TASK-ARP04-002 case 4): fake `ssh` whose local port is held
// by a FOREIGN process — a DETACHED grandchild binder whose PID differs from
// this spawned child's PID. Simulates the pickFreeLocalPort race the manager
// must defeat: the forward line prints, but listeningPids(port) resolves to
// the binder, so proveOwnership sees a PID mismatch and must fail closed
// (SIGKILL the child + reject). The TEST terminates the detached binder via
// the UnicDB_BINDER_PID marker / binder-pid control file and releases the port.
//
// Control files (written under $UnicDB_TEST_FOREIGN_DIR, set by the test):
//   child-pid    — this spawned child's PID (the manager's `child.pid`)
//   binder-pid   — the detached binder's PID, or "0" if it failed to bind
//   caught-sigterm — written only if this child receives SIGTERM (a SIGKILL
//                  path can never write it — used to prove fail-closed kill)
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const controlDir =
  process.env.UnicDB_TEST_FOREIGN_DIR ||
  mkdtempSync(join(tmpdir(), "UnicDB-foreign-"));

// Parse the manager's `-L 127.0.0.1:<local>:127.0.0.1:<target>` argv.
const lIdx = process.argv.findIndex((a) => a === "-L");
const fwd = lIdx >= 0 ? process.argv[lIdx + 1] : "";
const localPort = Number.parseInt(fwd.split(":")[1] ?? "0", 10);

writeFileSync(join(controlDir, "child-pid"), String(process.pid));

const pidFile = join(controlDir, `binder-${localPort}.pid`);

// Detached binder (grandchild): binds 127.0.0.1:<port>, writes its PID once
// the LISTEN socket exists, stays alive until SIGTERM (then close+exit).
// CJS via `node -e`; config arrives as the last argv entry (JSON).
const binderCode = `
const net = require("node:net");
const fs = require("node:fs");
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const srv = net.createServer((sock) => sock.end());
srv.on("error", () => process.exit(1));
srv.listen(cfg.port, "127.0.0.1", () => {
  fs.writeFileSync(cfg.pidFile, String(process.pid));
});
process.on("SIGTERM", () => {
  try { srv.close(() => process.exit(0)); } catch {}
  setTimeout(() => process.exit(0), 500).unref();
});
// Failsafe: if the test crashed before SIGTERM, do not leak a port holder
// forever — exit after the same lifetime as the fixture parent.
setTimeout(() => process.exit(0), 60_000).unref();
setInterval(() => {}, 1 << 30);
`;

const binder = spawn(
  process.execPath,
  ["-e", binderCode, JSON.stringify({ port: localPort, pidFile })],
  { detached: true, stdio: "ignore" },
);
binder.unref();

// Wait (max ~5s) until the binder has BOUND the port so the manager's first
// listeningPids() probe deterministically sees the foreign owner. Within the
// manager's 10s READY_TIMEOUT_MS budget.
let bound = false;
for (let i = 0; i < 100; i++) {
  if (existsSync(pidFile)) {
    bound = true;
    break;
  }
  await delay(50);
}
const binderPid = bound ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
writeFileSync(join(controlDir, "binder-pid"), String(binderPid));

process.stderr.write(`UnicDB_BINDER_PID=${binderPid}\n`);
// The exact OpenSSH debug line the manager's readiness scan matches.
process.stderr.write(
  `Local forwarding listening on 127.0.0.1 port ${localPort}.\n`,
);

process.on("SIGTERM", () => {
  // Managed teardown path (NOT the PID-mismatch path, which SIGKILLs).
  writeFileSync(join(controlDir, "caught-sigterm"), "1");
  if (binderPid > 0) {
    try {
      process.kill(binderPid, "SIGTERM");
    } catch {}
  }
  process.exit(0);
});

// Stay alive so the manager does not see an early exit before its probe.
await delay(60_000);
