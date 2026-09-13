// src/ai/__tests__/commitGenOmpOneShot.live.test.ts
// Gated LIVE regression test for the Generate Commit Message hang.
//
// Activated only with UnicDB_OMP_SMOKE=1 (same gate as acpLiveSmoke.test.ts).
// Drives the REAL omp binary through the SAME production shape the host wires
// (AcpProcess → createOmpChatEngine → driveCommitGenOneShot + the auto-answer
// server-request handler) and asserts the turn SETTLES.
//
// Why this exists: the original bug was only observable against a real omp —
// it issued `session/request_permission`, nobody answered, and the unbounded
// `session/prompt` never settled (the progress spinner hung). Unit tests pin
// the policy; this proves the wiring against the actual binary.
import { describe, it, expect } from "vitest";
import { AcpProcess } from "../omp/acpProcess";
import { createOmpChatEngine } from "../omp/ompChatEngine";
import type { AcpSession, HostMcp } from "../omp/ompChatEngine";
import {
  answerCommitGenServerRequest,
  driveCommitGenOneShot,
} from "../commitGenOmpOneShot";
import type { AcpProcessHandle } from "../omp/acpProcess";

function noopHostMcp(): HostMcp {
  return {
    port: 0,
    url: "http://127.0.0.1:0",
    sessionId: "commit-gen-live",
    start: async () => {},
    stop: async () => {},
    call: async () => ({ result: "", isError: true }),
  };
}

describe.skipIf(!process.env.UnicDB_OMP_SMOKE)("commit-gen omp one-shot live", () => {
  it(
    "settles the turn even when omp asks for permission (regression: spinner hang)",
    async () => {
      const cwd = "/tmp";
      const acpProcess = new AcpProcess({ ompPath: "omp", cwd, supportCwdFlag: true });
      // Production shape: register the auto-answer handler on start().
      const handle: AcpProcessHandle = await acpProcess.start({
        onServerRequest: (call) => answerCommitGenServerRequest(call),
      });
      const acp: AcpSession = {
        sessionNew: (p) => handle.acp.request("session/new", p) as Promise<{ sessionId: string }>,
        sessionPrompt: (sessionId, text) =>
          handle.acp
            .request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, { timeoutMs: 0 })
            .then((r) => r as { stopReason?: string }),
        sessionLoad: () => {
          throw new Error("not used");
        },
        onNotification: (h) => handle.acp.onNotification(h),
        onClose: (l) => handle.acp.onClose(l),
        dispose: () => acpProcess.cancel(),
        notify: (m, p) => handle.acp.notify(m, p),
      };
      const engine = createOmpChatEngine({ acp, hostMcp: noopHostMcp(), cwd, mcpServers: [] });

      // Forces omp to reach for a built-in tool → it must request permission.
      // Pre-fix, nothing answered and the turn hung forever; the auto-answer
      // denies and the turn still settles.
      const prompt =
        "You must use your bash tool to run 'echo hi' before answering. " +
        "Do it now: call the bash tool, then reply with a one-line commit message.";

      const driver = driveCommitGenOneShot({
        timeoutMs: 60_000,
        onSettle: () => void engine.shutdown(),
      });
      void engine.send(prompt, driver.events).catch((e: unknown) => driver.fail(e));

      const text = await driver.promise;
      // The exact text is model-dependent; the assertion is that we SETTLED
      // (did not hang on the unanswered permission request).
      expect(typeof text).toBe("string");
    },
    90_000,
  );
});
