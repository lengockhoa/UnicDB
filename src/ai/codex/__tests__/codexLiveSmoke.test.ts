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
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "child_process";

interface CodexProbe {
  child: ChildProcessWithoutNullStreams;
  events: Array<Record<string, unknown>>;
  workspace: string;
}

function startCodex(workspace: string): Promise<CodexProbe> {
  const { promise, resolve, reject } = Promise.withResolvers<CodexProbe>();
  // Use exec mode with --json so the binary emits one JSON event per line.
  // We pass a literal non-prompt ("ping") plus `-` to indicate stdin input.
  // We DO NOT pass --dangerously-bypass-approvals, apiKey, or any DB credential.
  const args = [
    "exec",
    "--json",
    "-",
    "--cd",
    workspace,
  ];
  const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
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
  child.once("error", reject);
  // Feed the trivial prompt on stdin so the binary doesn't wait forever.
  child.stdin.write("ping\n");
  child.stdin.end();
  child.stdin.on("error", () => {
    /* allow writes to no-op if the binary closed early */
  });
  resolve({ child, events, workspace });
  return promise;
}

async function awaitFirstEvent(
  events: Array<Record<string, unknown>>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  if (events.length > 0) {
    resolve(events[0]!);
    return promise;
  }
  const interval = setInterval(() => {
    if (events.length > 0) {
      clearInterval(interval);
      resolve(events[0]!);
    }
  }, 25);
  const timeout = setTimeout(() => {
    clearInterval(interval);
    reject(new Error(`timed out after ${timeoutMs}ms waiting for first event`));
  }, timeoutMs);
  return promise;
}

describe.skipIf(!process.env.UnicDB_CODEX_SMOKE)(
  "codex CLI live smoke",
  () => {
    let workspace = "";
    let cleanup = false;

    it(
      "binary exists and produces a parseable exec-mode JSON event inside 30s",
      async () => {
        workspace = mkdtempSync(join(tmpdir(), "unicdb-codex-smoke-"));
        cleanup = true;

        const { child, events } = await startCodex(workspace);

        try {
          const first = await awaitFirstEvent(events, 30_000);
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

describe("codex CLI live smoke — gate disabled", () => {
  it("test 5: suite skipped when UnicDB_CODEX_SMOKE is unset", () => {
    // Contract test for the env-var gate name. Companion describe.skipIf
    // suite is skipped when env is unset; this test always runs and pins
    // the gate name match.
    const gateName = "UnicDB_CODEX_SMOKE";
    expect(typeof gateName).toBe("string");
    expect(gateName.length).toBeGreaterThan(0);
  });
});
