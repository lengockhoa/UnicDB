// src/ai/__tests__/commitGenOmpOneShot.e2e.test.ts
// Deterministic end-to-end regression for the Generate Commit Message hang.
//
// The bug: the commit-gen one-shot never answered `session/request_permission`,
// so the (intentionally unbounded) `session/prompt` never settled and the SCM
// progress spinner hung forever. A live model only reaches for a tool
// intermittently, so this test drives the REAL production path
// (AcpProcess → createOmpChatEngine → driveCommitGenOneShot) against a fake
// omp server that ALWAYS asks for permission before finishing the turn.
//
// With the fix wired, the auto-answer settles the turn. Remove the
// `onServerRequest` handler from the AcpProcess.start() call below and this
// test times out — that is the RED shape this test guards against.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Writable, Readable } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { AcpProcess } from "../omp/acpProcess";
import type { AcpProcessHandle } from "../omp/acpProcess";
import { createOmpChatEngine } from "../omp/ompChatEngine";
import type { AcpSession, HostMcp } from "../omp/ompChatEngine";
import {
  answerCommitGenServerRequest,
  driveCommitGenOneShot,
} from "../commitGenOmpOneShot";

// ---- fake omp child ---------------------------------------------------------

class FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdout.setEncoding("utf8");
  }
  override kill(): boolean {
    return true;
  }
  feed(chunk: string): void {
    (this.stdout as PassThrough).write(chunk);
  }
}

/**
 * Fake omp server: completes the handshake, and on EVERY `session/prompt`
 * first sends a `session/request_permission` server request. It resolves the
 * prompt with `end_turn` ONLY after the client answers that permission —
 * exactly the behaviour that hung production.
 */
function attachFakeOmp(
  child: FakeChild,
  permissionId: number,
): { permissionAnswered: () => boolean } {
  let promptId: number | null = null;
  let answered = false;
  let buf = "";
  (child.stdin as PassThrough).setEncoding("utf8");
  (child.stdin as PassThrough).on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = frame["id"];
      const method = frame["method"];

      if (method === "initialize") {
        child.feed(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "18.1.15" },
            },
          }) + "\n",
        );
        continue;
      }
      if (method === "session/new") {
        child.feed(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { sessionId: "fake-session", configOptions: [] },
          }) + "\n",
        );
        continue;
      }
      if (method === "session/prompt") {
        promptId = id as number;
        // Ask for permission — the client MUST answer or the turn never ends.
        child.feed(
          JSON.stringify({
            jsonrpc: "2.0",
            id: permissionId,
            method: "session/request_permission",
            params: {
              sessionId: "fake-session",
              toolCall: { toolCallId: "call-1", title: "echo hi", kind: "execute" },
              options: [
                { optionId: "allow_once", label: "Allow once" },
                { optionId: "deny", label: "Deny" },
              ],
            },
          }) + "\n",
        );
        continue;
      }
      // A response frame from the client to our permission request.
      if (method === undefined && id === permissionId && promptId !== null) {
        answered = true;
        child.feed(
          JSON.stringify({
            jsonrpc: "2.0",
            id: promptId,
            result: { stopReason: "end_turn" },
          }) + "\n",
        );
        promptId = null;
        continue;
      }
    }
  });
  return { permissionAnswered: () => answered };
}

function noopHostMcp(): HostMcp {
  return {
    port: 0,
    url: "http://127.0.0.1:0",
    sessionId: "commit-gen-e2e",
    start: async () => {},
    stop: async () => {},
    call: async () => ({ result: "", isError: true }),
  };
}

function makeProcess(child: FakeChild): AcpProcess {
  return new AcpProcess(
    {
      ompPath: "omp",
      cwd: "/tmp",
      supportCwdFlag: true,
      execFn: async () => "omp/18.1.15\n",
    },
    ((_command: string, _args: string[], _options: SpawnOptions) =>
      child as unknown as ChildProcessWithoutNullStreams) as never,
  );
}

function sessionFrom(handle: AcpProcessHandle, proc: AcpProcess): AcpSession {
  return {
    sessionNew: (p) =>
      handle.acp.request("session/new", p).then((r) => r as { sessionId: string }),
    sessionPrompt: (sessionId, text) =>
      handle.acp
        .request(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text }] },
          { timeoutMs: 0 },
        )
        .then((r) => r as { stopReason?: string }),
    sessionLoad: () => {
      throw new Error("not used");
    },
    onNotification: (h) => handle.acp.onNotification(h),
    onClose: (l) => handle.acp.onClose(l),
    dispose: () => proc.cancel(),
    notify: (m, p) => handle.acp.notify(m, p),
  };
}

describe("commit-gen omp one-shot — permission request must not hang the turn", () => {
  it("settles when omp asks for permission (auto-answer wired)", async () => {
    const permissionId = 900001;
    const child = new FakeChild();
    const fake = attachFakeOmp(child, permissionId);
    const proc = makeProcess(child);
    const handle = await proc.start({
      onServerRequest: (call) => answerCommitGenServerRequest(call),
    });
    const engine = createOmpChatEngine({
      acp: sessionFrom(handle, proc),
      hostMcp: noopHostMcp(),
      cwd: "/tmp",
      mcpServers: [],
    });

    const driver = driveCommitGenOneShot({
      timeoutMs: 3_000,
      onSettle: () => void engine.shutdown(),
    });
    void engine.send("write a commit message", driver.events).catch((e: unknown) =>
      driver.fail(e),
    );

    // Pre-fix this rejected with the 3s timeout (the hang). Now it resolves.
    await expect(driver.promise).resolves.toBeTypeOf("string");
    expect(fake.permissionAnswered()).toBe(true);
  });

  it("times out (does NOT hang forever) if the engine sends but never settles", async () => {
    // No prompt-triggering server here: just prove the bound rejects rather
    // than leaving an indefinite pending promise — the safety net behind the
    // auto-answer fix.
    const child = new FakeChild();
    // Complete the handshake but never answer session/prompt.
    let buf = "";
    (child.stdin as PassThrough).setEncoding("utf8");
    (child.stdin as PassThrough).on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame["method"] === "initialize") {
          child.feed(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame["id"],
              result: { protocolVersion: 1, agentInfo: { version: "18.1.15" } },
            }) + "\n",
          );
        } else if (frame["method"] === "session/new") {
          child.feed(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame["id"],
              result: { sessionId: "fake-session", configOptions: [] },
            }) + "\n",
          );
        }
        // session/prompt → silence on purpose.
      }
    });
    const proc = makeProcess(child);
    const handle = await proc.start({
      onServerRequest: (call) => answerCommitGenServerRequest(call),
    });
    const engine = createOmpChatEngine({
      acp: sessionFrom(handle, proc),
      hostMcp: noopHostMcp(),
      cwd: "/tmp",
      mcpServers: [],
    });

    const driver = driveCommitGenOneShot({
      timeoutMs: 1_000,
      onSettle: () => void engine.shutdown(),
    });
    void engine.send("hi", driver.events).catch((e: unknown) => driver.fail(e));

    await expect(driver.promise).rejects.toThrow(/did not finish within/);
  });
});
