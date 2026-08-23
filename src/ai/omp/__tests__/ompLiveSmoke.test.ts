// ORCHESTRATOR LIVE SMOKE — R4.5 round 1 verification against real omp binary.
// Not part of CI suite: spawns real omp. Kept as manual evidence; delete after cycle L closes.
import { describe, it, expect } from "vitest";
import { OmpProcess } from "../process";

describe.skipIf(!process.env.VSDB_OMP_SMOKE)("omp live smoke", () => {
  it("real binary roundtrip: start/ready/prompt/agent_end/kill", async () => {
    const p = new OmpProcess({ cwd: "/tmp" });
    const { rpc, version } = await p.start();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    let sawEnd = false;
    rpc.onEvent((ev) => {
      if ((ev as unknown as { type: string }).type === "agent_end") sawEnd = true;
    });
    await rpc.request({ type: "prompt", message: "reply with exactly: pong" });
    for (let i = 0; i < 60 && !sawEnd; i++) await new Promise((r) => setTimeout(r, 250));
    expect(sawEnd).toBe(true);
    p.kill();
  }, 45000);
});
