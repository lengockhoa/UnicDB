// src/ai/__tests__/auditExport.test.ts — TASK-AIX07-002
//
// Pure audit-export envelope tests. The exporter must be pure (no
// vscode/fs/net/child_process) and must run trace.redact() as the
// FINAL pass immediately before serialization.
import { describe, it, expect } from "vitest";
import { TraceRecorder } from "../trace";
import {
  AUDIT_EXPORT_SCHEMA,
  AUDIT_EXPORT_VERSION,
  buildAuditEnvelope,
  serializeAuditExport,
} from "../auditExport";

describe("audit export envelope (TASK-AIX07-002)", () => {
  it("dumpAll and audit envelope preserve two ordered redacted turns", () => {
    const r = new TraceRecorder();
    r.record("turn-a", "prompt", { text: "hi" });
    r.record("turn-b", "delta", { text: "lo" });

    const envelope = buildAuditEnvelope(r.dumpAll(), "2026-08-31T00:00:00.000Z");
    expect(envelope.schema).toBe(AUDIT_EXPORT_SCHEMA);
    expect(envelope.version).toBe(AUDIT_EXPORT_VERSION);
    expect(envelope.exportedAt).toBe("2026-08-31T00:00:00.000Z");
    expect(envelope.turns.map((t) => t.turnId)).toEqual(["turn-a", "turn-b"]);

    const parsed = JSON.parse(serializeAuditExport(r.dumpAll())) as {
      schema: string;
      version: number;
      turns: Array<{ turnId: string; truncated: boolean }>;
    };
    expect(parsed.schema).toBe("UnicDB.ai.audit-export");
    expect(parsed.version).toBe(1);
    expect(parsed.turns.map((t) => t.turnId)).toEqual(["turn-a", "turn-b"]);
    expect(parsed.turns.every((t) => typeof t.truncated === "boolean")).toBe(true);

    // Source recorder stays populated after export.
    expect(r.events()).toHaveLength(2);
    expect(r.dumpAll().map((d) => d.turnId)).toEqual(["turn-a", "turn-b"]);
  });

  it("serialized audit export cannot contain credential or authorization sentinels", () => {
    const SHORT_SECRET = "ab"; // KV_RE no-min rule target
    const LONG_SECRET = "aGVsbG8gd29ybGQgdGhpc2lzIHNlY3JldA=="; // >= 24 chars
    const BEARER = "eyJhbGciOiJIUzI1NiJ9";
    const r = new TraceRecorder();
    r.record("turn-a", "prompt", {
      apiKey: "sk-live-abcdefghijklmnop", // literal key → key-level scrub
      nested: { password: "hunter2", token: "tk-999" }, // nested key scrub
      note: `apiKey=${SHORT_SECRET}`, // short secret-shaped string
      blob: LONG_SECRET, // long opaque run
      header: `Authorization: Bearer ${BEARER}`, // bearer signature
    });
    r.record("turn-b", "tool_end", { result: "plain text stays" });

    const json = serializeAuditExport(r.dumpAll());
    expect(json).not.toContain("sk-live-abcdefghijklmnop");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("tk-999");
    expect(json).not.toContain(SHORT_SECRET);
    expect(json).not.toContain(LONG_SECRET);
    expect(json).not.toContain(BEARER);
    expect(json).toContain("<redacted>");
    expect(json).toContain("plain text stays");

    // The envelope's own frame carries no credential field.
    const envelope = buildAuditEnvelope(r.dumpAll());
    const ownKeys = Object.keys(envelope);
    expect(ownKeys).not.toContain("apiKey");
    expect(ownKeys).not.toContain("secret");
    expect(ownKeys).not.toContain("password");
    expect(ownKeys).not.toContain("token");
  });

  it("empty snapshot and truncated dump serialize valid envelopes", () => {
    const empty = JSON.parse(serializeAuditExport([])) as { turns: unknown[] };
    expect(empty.turns).toEqual([]);

    const r = new TraceRecorder({ maxEntriesPerTurn: 2 });
    for (let i = 0; i < 4; i++) r.record("capped", "delta", { i });
    const parsed = JSON.parse(serializeAuditExport(r.dumpAll())) as {
      turns: Array<{ turnId: string; truncated: boolean; events: unknown[] }>;
    };
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]!.turnId).toBe("capped");
    expect(parsed.turns[0]!.truncated).toBe(true);
    expect(parsed.turns[0]!.events).toHaveLength(2);
  });

  it("serialized export cannot leak secrets through a payload toJSON hook", () => {
    // Reviewer critical finding: JSON.stringify invokes toJSON() AFTER
    // the final redact() pass, so a payload object carrying a toJSON
    // hook that returns secret-shaped data was serialized raw.
    const SENTINEL = "sk-live-sentinel-payload-key";
    const r = new TraceRecorder();
    r.record("turn-a", "prompt", {
      note: "harmless",
      toJSON: () => ({ apiKey: SENTINEL }),
    });

    const json = serializeAuditExport(r.dumpAll());
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("toJSON");
    expect(json).toContain("harmless");

    // Export must still be valid JSON with the envelope shape intact.
    const parsed = JSON.parse(json) as {
      schema: string;
      version: number;
      turns: Array<{ turnId: string; events: Array<{ payload: unknown }> }>;
    };
    expect(parsed.schema).toBe("UnicDB.ai.audit-export");
    expect(parsed.version).toBe(1);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]!.turnId).toBe("turn-a");
  });

  it("TASK-AIX03-103: tcid:-marked OpenAI-format provider id survives audit export", () => {
    // 31-character realistic OpenAI-shaped provider id (call_ + 26 chars),
    // prefixed by the audit-correlation marker so LONG_RUN_RE skips it.
    const MARKED = "tcid:call_abcdefghijklmnopqrstuvwxyz";
    const r = new TraceRecorder();
    r.record("turn-a", "tool_start", {
      name: "demo",
      argsJson: "{}",
      toolCallId: MARKED,
    });
    r.record("turn-a", "tool_end", {
      name: "demo",
      isError: false,
      toolCallId: MARKED,
    });

    const json = serializeAuditExport(r.dumpAll());
    expect(json).toContain(MARKED);
    // The exact marker-prefixed value must be present, not <redacted>.
    expect(json).not.toContain('"toolCallId":"<redacted>"');

    const parsed = JSON.parse(json) as {
      turns: Array<{
        events: Array<{
          kind: string;
          payload: { toolCallId?: string };
        }>;
      }>;
    };
    const payloads = parsed.turns[0]!.events.map((e) => e.payload);
    expect(payloads[0]!.toolCallId).toBe(MARKED);
    expect(payloads[1]!.toolCallId).toBe(MARKED);
  });

  it("TASK-AIX03-103: unmarked 31-character opaque run stays <redacted>", () => {
    // Same provider id as above but WITHOUT the tcid: marker — must be
    // scrubbed by LONG_RUN_RE. The marker is the only exemption.
    const UNMARKED = "call_abcdefghijklmnopqrstuvwxyz";
    const r = new TraceRecorder();
    r.record("turn-a", "tool_start", {
      name: "demo",
      argsJson: "{}",
      toolCallId: UNMARKED,
    });

    const json = serializeAuditExport(r.dumpAll());
    expect(json).not.toContain(UNMARKED);
    expect(json).toContain('"toolCallId":"<redacted>"');
  });

  it("envelope build is copy-safe against consumer mutation", () => {
    const r = new TraceRecorder();
    r.record("t1", "prompt", { x: 1 });
    const envelope = buildAuditEnvelope(r.dumpAll());
    envelope.turns[0]!.events.push({
      turnId: "t1",
      seq: 99,
      kind: "error",
      ts: 0,
      payload: "injected",
    });
    const fresh = buildAuditEnvelope(r.dumpAll());
    expect(fresh.turns[0]!.events).toHaveLength(1);
    expect(r.events("t1")).toHaveLength(1);
  });
});
