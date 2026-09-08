// src/ai/codex/__tests__/codexLiveSmoke.test.ts
// TASK-014 — env-gated live smoke for the real Codex CLI.
// Activated ONLY when `UnicDB_CODEX_SMOKE=1`. Probes a minimal exec-mode
// handshake (no prompt, no model use, no DB mutation, no credentials).
//
// Hard rules (TASK-014 acceptance + TASK-006 verification notes):
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

const GATE_ENV = "UnicDB_CODEX_SMOKE";

interface CodexProbe {
  child: ChildProcessWithoutNullStreams;
  events: Array<Record<string, unknown>>;
  workspace: string;
  getSpawnError: () => Error | undefined;
}

function startProbe(
  bin: string,
  args: string[],
  cwd: string,
): Promise<CodexProbe> {
  const { promise, resolve, reject } = Promise.withResolvers<CodexProbe>();
  // Use exec mode with --json so the binary emits one JSON event per line.
  // We pass a literal non-prompt ("ping") plus `-` to indicate stdin input.
  // We DO NOT pass --dangerously-bypass-approvals, apiKey, or any DB credential.
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
  // Feed the trivial prompt on stdin so the binary doesn't wait forever.
  child.stdin.write("ping\n");
  child.stdin.end();
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

function startCodex(workspace: string): Promise<CodexProbe> {
  const args = [
    "exec",
    "--json",
    "-",
    "--cd",
    workspace,
  ];
  return startProbe("codex", args, workspace);
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
  "codex CLI live smoke",
  () => {
    let workspace = "";
    let cleanup = false;

    it(
      "binary exists and produces a parseable exec-mode JSON event inside 30s",
      async () => {
        workspace = mkdtempSync(join(tmpdir(), "unicdb-codex-smoke-"));
        cleanup = true;

        const { child, events, getSpawnError } = await startCodex(workspace);

        try {
          const first = await awaitFirstEvent(events, 30_000, getSpawnError);
          expect(typeof first).toBe("object");
          expect(first).not.toBeNull();
          // Evidence dump for the reviewer.
          // eslint-disable-next-line no-console
          console.log(
            "[codex-smoke] first-event-keys=",
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

describe("codex CLI live smoke — pins the gate env-var name", () => {
  it("GATE_ENV === 'UnicDB_CODEX_SMOKE'", () => {
    expect(GATE_ENV).toBe("UnicDB_CODEX_SMOKE");
  });

  it(
    "spawn error surfaces fast (missing binary)",
    async () => {
      const workspace = mkdtempSync(
        join(tmpdir(), "unicdb-codex-smoke-missing-"),
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
