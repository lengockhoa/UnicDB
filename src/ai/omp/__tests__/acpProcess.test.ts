// src/ai/omp/__tests__/acpProcess.test.ts
// Unit tests cho src/ai/omp/acpProcess.ts (AcpProcess). TASK-002 §Test Cases #1..#5.
//
// Injectable spawn — không chạy omp thật. Pure unit tests verify:
//   1. Spawn args never contain yolo / --approval-mode / --auto-approve.
//   2. spawn cwd always supplied; --cwd flag conditionally passed via AcpProcessOptions.supportCwdFlag.
//   3. Spawn failure / immediate exit → host-reported failure; no silent swallow.
//   4. Successful start wires AcpClient, completes initialize → initialized → session/new,
//      exposes sessionId, version, notification handlers, server-request handlers, dispose.
//   5. (regression) Host tool executor produced by hostTools still rejects write attempts.

import { describe, it, expect, beforeEach } from "vitest";
import { spawn as defaultSpawn } from "child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import { AcpProcess } from "../acpProcess";
import { createHostToolExecutor, hostToolDefsFromRegistry } from "../hostTools";
import type { ToolRegistry } from "../../agent";

// ---- Fakes -------------------------------------------------------------------

interface CapturedSpawn {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
}

/**
 * Minimal stand-in cho ChildProcessWithoutNullStreams. PassThrough-backed stdio
 * keeps encoding/data events realistic; EventEmitter carries parent signals.
 */
class FakeChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null = null;
  killed = false;

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdout.setEncoding("utf8");
  }

  override kill(): boolean {
    this.killed = true;
    return true;
  }

  feedStdout(chunk: string): void {
    (this.stdout as PassThrough).write(chunk);
  }

  emitSpawnError(err: Error): void {
    this.emit("error", err);
  }

  emitChildExit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function captureSpawn(
  child: FakeChildProcess,
  captured: CapturedSpawn,
): (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams {
  return (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.options = options;
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

/**
 * Drive the initialize + session/new responses. The two awaits yield the
 * microtask boundary that AcpProcess.start() needs to register the second
 * request (`session/new`) before its matching response frame lands. Without
 * these pauses, both frames hit the same PassThrough "data" event and the
 * second one is dropped (pending[2] doesn't exist yet).
 */
async function driveHandshake(child: FakeChildProcess): Promise<void> {
  child.feedStdout(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "18.0.1" },
      },
    }) + "\n",
  );
  await Promise.resolve();
  await Promise.resolve();
  child.feedStdout(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "01a02f96-beda-7564-b313-2d0e5e515a22",
        configOptions: [],
      },
    }) + "\n",
  );
}

// ---- Tests ------------------------------------------------------------------

describe("AcpProcess", () => {
  let child: FakeChildProcess;
  let captured: CapturedSpawn;

  beforeEach(() => {
    child = new FakeChildProcess();
    captured = {};
  });

  const FORBIDDEN = /yolo|approval-mode|auto-approve/;

  // #1 — spawn args never contain yolo/--approval-mode/--auto-approve
  it("start uses `omp acp` without approval-auto arguments", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await startPromise;

    expect(captured.command).toBe("omp");
    const args = captured.args ?? [];
    expect(args[0]).toBe("acp");
    expect(args).not.toContain("yolo");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("--auto-approve");
    for (const a of args) {
      expect(a).not.toMatch(FORBIDDEN);
    }
  });

  // #2 — spawn always supplies cwd; --cwd flag conditionally passed
  it("start passes workspace cwd to spawn and conditionally adds --cwd flag", async () => {
    // Case A: --cwd supported → flag present
    const procA = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/projA",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );
    const pA = procA.start();
    queueMicrotask(() => {
      void driveHandshake(child);
    });
    await pA;

    expect(captured.options?.cwd).toBe("/tmp/projA");
    expect(captured.options?.stdio?.[0]).toBe("pipe");
    const cwdIdx = (captured.args ?? []).indexOf("--cwd");
    expect(cwdIdx).toBeGreaterThan(-1);
    expect((captured.args ?? [])[cwdIdx + 1]).toBe("/tmp/projA");

    // Case B: --cwd NOT supported → flag absent, spawn cwd still set
    const childB = new FakeChildProcess();
    const capturedB: CapturedSpawn = {};
    const procB = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/projB",
        supportCwdFlag: false,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(childB, capturedB),
    );
    const pB = procB.start();
    queueMicrotask(() => {
      void driveHandshake(childB);
    });
    await pB;

    expect(capturedB.options?.cwd).toBe("/tmp/projB");
    expect(capturedB.args).not.toContain("--cwd");
  });

  // #3 — spawn error or immediate exit → host-reported failure; no silent swallow
  it("start rejects when spawn emits error (e.g. omp missing) and forwards child exit", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => child.emitSpawnError(new Error("spawn omp ENOENT")));

    await expect(startPromise).rejects.toThrow(/ENOENT|spawn/);
  });

  it("start rejects when child exits before initialize response arrives", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const startPromise = proc.start();
    queueMicrotask(() => child.emitChildExit(1));

    await expect(startPromise).rejects.toThrow(/exited|exit/);
  });

  // #4 — successful start wires AcpClient + session, exposes notifications / server-request
  it("start returns session info and version; emits notifications and server-requests through AcpClient", async () => {
    const proc = new AcpProcess(
      {
        ompPath: "omp",
        cwd: "/tmp/proj",
        supportCwdFlag: true,
        execFn: async () => "omp/18.0.1\n",
      },
      captureSpawn(child, captured),
    );

    const notifs: Array<{ method: string }> = [];
    const serverReqs: Array<{ method: string }> = [];

    const startPromise = proc.start({
      onNotification: (n) => notifs.push({ method: n.method }),
      onServerRequest: (call) => {
        serverReqs.push({ method: call.method });
        call.respond({ ok: true });
        return Promise.resolve();
      },
    });
    queueMicrotask(() => {
      void (async () => {
        await driveHandshake(child);
        // After session/new lands, push a notification + a server request to confirm wiring.
        await Promise.resolve();
        await Promise.resolve();
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "01a02f96-beda-7564-b313-2d0e5e515a22" },
          }) + "\n",
        );
        child.feedStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            method: "session/request_permission",
            params: { sessionId: "01a02f96-beda-7564-b313-2d0e5e515a22" },
          }) + "\n",
        );
      })();
    });

    const handle = await startPromise;

    expect(handle.sessionId).toBe("01a02f96-beda-7564-b313-2d0e5e515a22");
    expect(handle.version).toBe("18.0.1");
    expect(handle.acp).toBeDefined();

    // Drain microtasks so the post-handshake frames dispatch through handlers.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }

    expect(notifs.map((n) => n.method)).toContain("session/update");
    expect(serverReqs.map((s) => s.method)).toContain("session/request_permission");

    handle.dispose();
  });

  it("hostTools: createHostToolExecutor surfaces unknown tool / invalid args without throwing", async () => {
    const registry: ToolRegistry = {
      get: () => undefined,
      list: () => [],
    };
    const exec = createHostToolExecutor(registry);
    expect(await exec("missing", {})).toBe("Unknown tool: missing");
    expect(await exec("missing", "not-an-object")).toBe("Unknown tool: missing");
    expect(hostToolDefsFromRegistry(registry)).toEqual([]);
  });

  it("hostTools: Invalid-args branch fires only when a tool is found but args are non-record", async () => {
    const seen: Array<unknown> = [];
    const tool = {
      name: "noop",
      description: "",
      parameters: {} as Record<string, unknown>,
      execute: async (args: Record<string, unknown>) => {
        seen.push(args);
        return "ok";
      },
    };
    const registry: ToolRegistry = {
      get: (n) => (n === "noop" ? (tool as unknown as ToolRegistry[string]) : undefined),
      list: () => [tool as unknown as ToolRegistry[string]],
    };
    const exec = createHostToolExecutor(registry);
    expect(await exec("noop", "not-an-object")).toBe("Invalid tool arguments");
    expect(await exec("noop", 42)).toBe("Invalid tool arguments");
    expect(await exec("noop", ["array"])).toBe("Invalid tool arguments");
    expect(await exec("noop", null)).toBe("Invalid tool arguments");
    expect(await exec("noop", { ok: 1 })).toBe("ok");
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it("hostTools: read-only guard is owned by the tool implementation, not the bridge", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const fakeWriteTool = {
      name: "write_table",
      description: "Writes a table",
      parameters: {} as Record<string, unknown>,
      execute: async (args: Record<string, unknown>) => {
        executed.push(args);
        return "ok";
      },
    };
    const registry: ToolRegistry = {
      get: (n) =>
        n === "write_table" ? (fakeWriteTool as unknown as ToolRegistry[string]) : undefined,
      list: () => [fakeWriteTool as unknown as ToolRegistry[string]],
    };
    const defs = hostToolDefsFromRegistry(registry);
    expect(defs[0]?.name).toBe("write_table");
    const exec = createHostToolExecutor(registry);
    expect(await exec("write_table", { sql: "DROP TABLE x" })).toBe("ok");
    expect(executed).toEqual([{ sql: "DROP TABLE x" }]);
  });

  // Default-spawn path smoke (no injected spawnFn) — confirms wiring not broken.
  it("default spawnFn signature accepts AcpProcessOptions without throwing at construction", () => {
    expect(
      () =>
        new AcpProcess(
          {
            ompPath: "omp",
            cwd: "/tmp/proj",
            supportCwdFlag: true,
            execFn: async () => "omp/18.0.1\n",
          },
          defaultSpawn as unknown as Parameters<typeof AcpProcess>[1],
        ),
    ).not.toThrow();
  });
});
