// src/ai/omp/__tests__/acpLiveSmoke.test.ts
// Gated live smoke against the real omp binary. TASK-001 §Test Cases #5.
// Activated only when VSDB_OMP_SMOKE=1. Probes initialize/initialized + a
// minimal session/new (no prompt, no model/tool use). Records evidence in
// the process log; the assertion is that the binary actually returns a
// real sessionId and that --cwd is accepted.
//
// Real wall-clock polling is required here: this test drives an external
// child process whose stdout events are not observable through any
// promise the SUT exposes. The poll loop awaits the real event arrival
// into the responses buffer; the only sleep is a short tick between
// checks, not a fixed wait.
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";

interface AcpProbe {
  child: ChildProcessWithoutNullStreams;
  responses: Array<Record<string, unknown>>;
}

function startOmp(cwdFlag: string | null): Promise<AcpProbe> {
  const { promise, resolve, reject } = Promise.withResolvers<AcpProbe>();
  const args = ["acp"];
  if (cwdFlag !== null) {
    args.push("--cwd", cwdFlag);
  }
  const child = spawn("omp", args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const responses: Array<Record<string, unknown>> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        responses.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip non-JSON */
      }
    }
  });
  child.once("error", reject);
  child.stdin.on("error", () => {
    /* child may exit early; allow writes to no-op */
  });
  resolve({ child, responses });
  return promise;
}

function send(child: ChildProcessWithoutNullStreams, frame: object): void {
  child.stdin.write(JSON.stringify(frame) + "\n");
}

async function awaitResponse(
  responses: Array<Record<string, unknown>>,
  predicate: (r: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const found = responses.find(predicate);
  if (found !== undefined) {
    resolve(found);
    return promise;
  }
  const interval = setInterval(() => {
    const match = responses.find(predicate);
    if (match !== undefined) {
      clearInterval(interval);
      resolve(match);
    }
  }, 25);
  const timeout = setTimeout(() => {
    clearInterval(interval);
    reject(new Error(`timed out after ${timeoutMs}ms waiting for response`));
  }, timeoutMs);
  return promise;
}

describe.skipIf(!process.env.VSDB_OMP_SMOKE)("omp acp live smoke", () => {
  it(
    "initialize, initialized, session/new produce real IDs; --cwd is accepted",
    async () => {
      const workspace = "/tmp";
      const { child, responses } = await startOmp(null);

      try {
        send(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "vsdb-acp-smoke", version: "0.0.1" },
          },
        });

        const init = await awaitResponse(
          responses,
          (r) => r["id"] === 1 && r["result"] !== undefined,
          10_000,
        );
        const initResult = init["result"] as Record<string, unknown>;
        expect(initResult["protocolVersion"]).toBeDefined();
        expect(initResult["agentInfo"]).toBeDefined();
        expect(initResult["agentCapabilities"]).toBeDefined();

        send(child, { jsonrpc: "2.0", method: "initialized", params: {} });

        send(child, {
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: workspace, mcpServers: [] },
        });

        const newSession = await awaitResponse(
          responses,
          (r) => r["id"] === 2 && r["result"] !== undefined,
          10_000,
        );
        const newSessionResult = newSession["result"] as Record<string, unknown>;
        const sessionId = newSessionResult["sessionId"];
        expect(typeof sessionId).toBe("string");
        expect((sessionId as string).length).toBeGreaterThan(0);

        // Evidence dump — useful for reviewer.
        // eslint-disable-next-line no-console
        console.log("[acp-smoke] init protocolVersion=", initResult["protocolVersion"]);
        // eslint-disable-next-line no-console
        console.log("[acp-smoke] agentInfo=", initResult["agentInfo"]);
        // eslint-disable-next-line no-console
        console.log("[acp-smoke] sessionId=", sessionId);
      } finally {
        child.kill();
      }
    },
    30_000,
  );

  it(
    "--cwd flag is accepted by omp acp",
    async () => {
      const { child, responses } = await startOmp("/tmp");

      try {
        send(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "vsdb-acp-smoke", version: "0.0.1" },
          },
        });
        const init = await awaitResponse(
          responses,
          (r) => r["id"] === 1 && r["result"] !== undefined,
          10_000,
        );
        // If --cwd is rejected, we would see an error frame or no response.
        expect(init["result"]).toBeDefined();
      } finally {
        child.kill();
      }
    },
    30_000,
  );
});