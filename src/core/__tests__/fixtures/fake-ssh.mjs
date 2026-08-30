#!/usr/bin/env node
// Test fixture: fake `ssh` that simulates a successful local forward.
// Prints the OpenSSH "Local forwarding listening" line on stderr with a FIXED
// port read from --fixture-port, then stays alive until SIGTERM.
import { setTimeout as delay } from "node:timers/promises";

const portIdx = process.argv.indexOf("--fixture-port");
const port = portIdx >= 0 ? process.argv[portIdx + 1] : "54321";
process.stderr.write(`Local forwarding listening on 127.0.0.1 port ${port}.\n`);
const ticker = setInterval(() => {}, 1 << 30);
process.on("SIGTERM", () => {
  clearInterval(ticker);
  process.exit(0);
});
await delay(60_000);
