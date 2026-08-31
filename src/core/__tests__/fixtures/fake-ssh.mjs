#!/usr/bin/env node
// Test fixture: fake `ssh` that simulates a successful local forward.
// Parses the manager's `-L 127.0.0.1:<local>:127.0.0.1:<target>` argv, BINDS
// 127.0.0.1:<local> (so the manager's TCP readiness probe passes, matching
// real ssh behaviour), prints the OpenSSH debug line, then stays alive
// until SIGTERM.
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const lIdx = process.argv.findIndex((a) => a === "-L");
const fwd = lIdx >= 0 ? process.argv[lIdx + 1] : "";
const localPort = Number.parseInt(fwd.split(":")[1] ?? "0", 10);

const srv = createServer((sock) => sock.end());
if (localPort > 0) {
  srv.listen(localPort, "127.0.0.1");
}
process.stderr.write(
  `Local forwarding listening on 127.0.0.1 port ${localPort}.\n`,
);
process.on("SIGTERM", () => {
  srv.close();
  process.exit(0);
});
await delay(60_000);
