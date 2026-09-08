// src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts
// TASK-014 — env-gated live smoke for the real Claude Code CLI.
// Activated ONLY when `UnicDB_CLAUDE_CODE_SMOKE=1`. Probes a minimal
// stream-json handshake. `--print ping` is a trivial non-mutating
// prompt that DOES reach the model (a single round-trip); the point
// is to exercise argv parsing + stream-json emission, not to do DB
// work. Records evidence in the process log; the assertion is that
// the binary actually produces a parseable event inside a bounded
// timeout.
//
// Hard rules (TASK-014 acceptance):
//   - default → suite skipped (never invokes the real binary)
//   - gate requested + binary missing → suite fails loudly, never silent skip
//   - never passes apiKey/DB credential; never uses dangerous bypass flags
//   - mandatory temp cwd; bounded timeout; cleanup on exit
//
// Mirrors src/ai/omp/__tests__/acpLiveSmoke.test.ts shape (proven gate
// pattern from TASK-006).
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "child_process";

const GATE_ENV = "UnicDB_CLAUDE_CODE_SMOKE";

interface ClaudeProbe {
  child: ChildProcessWithoutNullStreams;
  events: Array<Record<string, unknown>>;
  workspace: string;
  getSpawnError: () => Error | undefined;
}

function startProbe(
  bin: string,
  args: string[],
  cwd: string,
): Promise<ClaudeProbe> {
  const { promise, resolve, reject } = Promise.withResolvers<ClaudeProbe>();
  // `--print ping` is a trivial non-mutating prompt that DOES reach
  // the model. The flag `--output-format stream-json` streams JSON
  // events we can parse. `--verbose` is passed for stream-json
  // verbosity so the CLI emits a richer event sequence on stdout.
  // We DO NOT pass --dangerously-skip-permissions, apiKey, or any DB
  // credential.
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  let spawnError: Error | undefined;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip non-JSON noise */
      }
    }
  });
  child.once("error", (err) => {
    spawnError = err;
    reject(err);
  });
  child.stdin.on("error", () => {
    /* allow writes to no-op if the binary closed early */
  });
  resolve({
    child,
    events,
    workspace: cwd,
    getSpawnError: () => spawnError,
  });
  return promise;
}

function startClaude(workspace: string): Promise<ClaudeProbe> {
  const args = [
    "--print",
    "ping",
    "--output-format",
    "stream-json",
    "--verbose",
    "--cwd",
    workspace,
  ];
  return startProbe("claude", args, workspace);
}

function awaitFirstEvent(
  events: Array<Record<string, unknown>>,
  timeoutMs: number,
  getSpawnError?: () => Error | undefined,
): Promise<Record<string, unknown>> {
  // Entry check: fail fast when the spawn already errored before this call.
  const early = getSpawnError?.();
  if (early) return Promise.reject(early);
  if (events.length > 0) return Promise.resolve(events[0]!);
  return new Promise((resolve, reject) => {
    // Inside the promise body: re-check in case spawn error fired between
    // the synchronous entry check above and the microtask that ran this body.
    const entry = getSpawnError?.();
    if (entry) {
      reject(entry);
      return;
    }
    const interval = setInterval(() => {
      const tick = getSpawnError?.();
      if (tick) {
        clearInterval(interval);
        reject(tick);
        return;
      }
      if (events.length > 0) {
        clearInterval(interval);
        resolve(events[0]!);
      }
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for first event`));
    }, timeoutMs);
  });
}

describe.skipIf(!process.env[GATE_ENV])(
  "claude code CLI live smoke",
  () => {
    let workspace = "";
    let cleanup = false;

    it(
      "binary exists and produces a parseable stream-json event inside 30s",
      async () => {
        workspace = mkdtempSync(join(tmpdir(), "unicdb-claude-smoke-"));
        cleanup = true;

        const { child, events, getSpawnError } = await startClaude(workspace);

        try {
          const first = await awaitFirstEvent(events, 30_000, getSpawnError);
          // First event must be a JSON object (the CLI emits either an
          // init/system event or the assistant header). Just assert it's
          // an object — shape varies across CLI versions.
          expect(typeof first).toBe("object");
          expect(first).not.toBeNull();
          // Evidence dump for the reviewer.
          // eslint-disable-next-line no-console
          console.log(
            "[claude-smoke] first-event-keys=",
            Object.keys(first).join(","),
          );
        } finally {
          child.kill();
        }
      },
      45_000,
    );

    afterEach(() => {
      if (cleanup && workspace) {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        cleanup = false;
        workspace = "";
      }
    });
  },
);

describe("claude code CLI live smoke — pins the gate env-var name", () => {
  it("GATE_ENV === 'UnicDB_CLAUDE_CODE_SMOKE'", () => {
    expect(GATE_ENV).toBe("UnicDB_CLAUDE_CODE_SMOKE");
  });

  it(
    "spawn error surfaces fast (missing binary)",
    async () => {
      const workspace = mkdtempSync(
        join(tmpdir(), "unicdb-claude-smoke-missing-"),
      );
      try {
        const probe = await startProbe(
          "unicdb-smoke-missing-binary",
          ["--print", "ping"],
          workspace,
        );
        const start = Date.now();
        await expect(
          awaitFirstEvent(probe.events, 30_000, probe.getSpawnError),
        ).rejects.toThrow();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5_000);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it("resolves the first pushed event while the 30s timeout is still pending", async () => {
    vi.useFakeTimers();
    try {
      const events: Array<Record<string, unknown>> = [];
      const promise = awaitFirstEvent(events, 30_000, () => undefined);
      events.push({ type: "system", subtype: "init" });
      await vi.advanceTimersByTimeAsync(25);
      const first = await promise;
      expect(first).toEqual({ type: "system", subtype: "init" });
    } finally {
      vi.useRealTimers();
    }
  });
});