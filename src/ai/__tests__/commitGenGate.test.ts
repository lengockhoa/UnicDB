// src/ai/__tests__/commitGenGate.test.ts
// Unit tests for src/ai/commitGenGate.ts — TASK-GITMSG-001 §Test Cases #1–#2.
// Pure module: no vscode import, no ports — the gate is a single-flight slot.
import { describe, it, expect } from "vitest";
import { createCommitGenGate } from "../commitGenGate";

// ============================================================================
// Test #1 — happy path: acquire → release → acquire
// ============================================================================
describe("ai/commitGenGate — acquire → release → acquire", () => {
  it("first acquire returns a release fn; after release a second acquire succeeds", () => {
    const gate = createCommitGenGate();

    const release = gate.acquire();
    expect(typeof release).toBe("function");

    release!();
    const release2 = gate.acquire();
    expect(typeof release2).toBe("function");
    release2!();
  });
});

// ============================================================================
// Test #2 — edge: re-entrancy — acquire while held; release is idempotent
// ============================================================================
describe("ai/commitGenGate — acquire while held", () => {
  it("returns null while a run is in flight; double-release frees the slot exactly once", () => {
    const gate = createCommitGenGate();

    const release = gate.acquire();
    expect(typeof release).toBe("function");

    // Slot held → second acquire refused.
    expect(gate.acquire()).toBeNull();

    // Release is idempotent: calling it twice must not throw and must free
    // the slot exactly once (a second release must NOT free a later holder).
    expect(() => release!()).not.toThrow();
    expect(() => release!()).not.toThrow();

    const release2 = gate.acquire();
    expect(typeof release2).toBe("function");

    // The stale first release must not free the new holder's slot.
    release!();
    expect(gate.acquire()).toBeNull();

    release2!();
    expect(typeof gate.acquire()).toBe("function");
  });
});
