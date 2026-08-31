// src/ai/__tests__/trace.test.ts — TASK-AIX06-001
import { describe, it, expect } from "vitest";
import {
  TraceRecorder,
  redact,
  MAX_ENTRIES_PER_TURN,
  MAX_TURNS,
} from "../trace";

describe("redact (TASK-AIX06-001)", () => {
  it("scrubs apiKey literal", () => {
    const out = redact({ apiKey: "sk-live-abcdefghijklmnop" }) as Record<string, string>;
    expect(out.apiKey).toBe("<redacted>");
  });

  it("scrubs secret, password, token keys", () => {
    const out = redact({
      secret: "x",
      password: "y",
      token: "z",
    }) as Record<string, string>;
    expect(out.secret).toBe("<redacted>");
    expect(out.password).toBe("<redacted>");
    expect(out.token).toBe("<redacted>");
  });

  it("scrubs Authorization: Bearer header inside a string value", () => {
    const out = redact({ header: "Authorization: Bearer eyJhbGciOi.x.y" });
    expect(JSON.stringify(out)).toContain("Bearer <redacted>");
    expect(JSON.stringify(out)).not.toContain("eyJhbGciOi");
  });

  it("scrubs Basic auth in a string value", () => {
    const out = redact({ h: "Basic dXNlcjpwYXNz" });
    expect(JSON.stringify(out)).toContain("Basic <redacted>");
    expect(JSON.stringify(out)).not.toContain("dXNlcjpwYXNz");
  });

  it("scrubs long mixed-case opaque runs but keeps short words", () => {
    const mixed = "abcdefghijklmnopqrstuvwx";
    const normal = "hello world";
    const out = redact({ a: mixed, b: normal });
    expect(JSON.stringify(out)).toContain("<redacted>");
    expect(JSON.stringify(out)).toContain("hello world");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redact({
      a: { apiKey: "x", b: { token: "y" } },
      list: [{ password: "z" }],
    }) as Record<string, unknown>;
    expect((out.a as Record<string, string>).apiKey).toBe("<redacted>");
    expect((out.a as { b: Record<string, string> }).b.token).toBe("<redacted>");
    expect((out.list as Array<Record<string, string>>)[0]!.password).toBe("<redacted>");
  });

  it("never throws", () => {
    expect(() => redact(undefined)).not.toThrow();
  });
});

describe("TraceRecorder (TASK-AIX06-001)", () => {
  it("record stores redacted payload with monotonic seq + ts", () => {
    const r = new TraceRecorder();
    r.record("t1", "prompt", { text: "hi" });
    r.record("t1", "delta", { text: "lo" });
    const evs = r.events("t1");
    expect(evs).toHaveLength(2);
    expect(evs[0]!.seq).toBe(1);
    expect(evs[1]!.seq).toBe(2);
    expect(typeof evs[0]!.ts).toBe("number");
  });

  it("events() returns a frozen copy; mutation is a no-op", () => {
    const r = new TraceRecorder();
    r.record("t1", "prompt", { x: 1 });
    const copy = r.events("t1") as unknown as { push: (e: unknown) => void };
    expect(() => copy.push("mutated")).toThrow();
    expect(r.events("t1")).toHaveLength(1);
  });

  it("per-turn ring caps at maxEntriesPerTurn and sets truncated", () => {
    const r = new TraceRecorder({ maxEntriesPerTurn: 5 });
    for (let i = 0; i < 8; i++) r.record("t1", "delta", { i });
    const buf = r.dump("t1");
    expect(buf.events).toHaveLength(5);
    expect(buf.truncated).toBe(true);
    expect(buf.events[0]!.seq).toBe(4);
  });

  it("turn-level FIFO: maxTurns+1 distinct turnIds evict the oldest", () => {
    const r = new TraceRecorder({ maxTurns: 3, maxEntriesPerTurn: 10 });
    r.record("a", "prompt", { x: 1 });
    r.record("b", "prompt", { x: 2 });
    r.record("c", "prompt", { x: 3 });
    r.record("d", "prompt", { x: 4 });
    expect(r.dump("a").events).toHaveLength(0);
    expect(r.dump("d").events).toHaveLength(1);
  });

  it("clear() empties everything", () => {
    const r = new TraceRecorder();
    r.record("t1", "prompt", { x: 1 });
    r.clear();
    expect(r.events()).toHaveLength(0);
    expect(r.dump("t1").events).toHaveLength(0);
  });

  it("exports MAX_TURNS and MAX_ENTRIES_PER_TURN", () => {
    expect(MAX_TURNS).toBeGreaterThan(0);
    expect(MAX_ENTRIES_PER_TURN).toBeGreaterThan(0);
  });
});

describe("redact r1 negative-leak (AIX-06 review)", () => {
  it("scrubs clientSecret-style suffixed keys", () => {
    const out = redact({ clientSecret: "short-value" }) as Record<string, string>;
    expect(out.clientSecret).toBe("<redacted>");
  });
  it("scrubs refreshToken-style keys", () => {
    const out = redact({ refreshToken: "abc" }) as Record<string, string>;
    expect(out.refreshToken).toBe("<redacted>");
  });
  it("scrubs key=value inside plain strings (short value)", () => {
    const out = redact({ s: "apiKey=short-value" }) as Record<string, string>;
    expect(out.s).not.toContain("short-value");
    expect(out.s).toContain("<redacted>");
  });
  it("scrubs 24-char base64 run containing / and +", () => {
    const token = "abc/def+ghi=jklmnopqrstu=";
    const out = redact({ s: token });
    expect(JSON.stringify(out)).not.toContain(token);
  });
  it("case-insensitive bearer in plain string", () => {
    const out = redact({ s: "bearer abcdefghijklmnop" }) as Record<string, string>;
    expect(out.s).toContain("<redacted>");
  });
});

describe("events() global insertion order (AIX-06 review F2)", () => {
  it("returns cross-turn events in true insertion order", () => {
    const r = new TraceRecorder();
    r.record("a", "prompt", { x: 1 });
    r.record("b", "prompt", { x: 2 });
    r.record("a", "delta", { x: 3 });
    const evs = r.events();
    expect(evs.map((e) => e.turnId)).toEqual(["a", "b", "a"]);
    expect(evs.map((e) => e.payload)).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });
});

describe("redact r2 review (AIX-06)", () => {
  it("scrubs apiKey<space>value (whitespace delimiter)", () => {
    const out = redact({ s: "apiKey short" }) as Record<string, string>;
    expect(out.s).not.toContain("short");
  });
  it("scrubs 2-char value (no minimum)", () => {
    const out = redact({ s: "token ab" }) as Record<string, string>;
    expect(out.s).not.toContain("ab");
  });
  it("never emits an onTrace payload containing a raw secret", () => {
    // emit() in ompChatEngine.ts must call trace.record BEFORE onTrace.
    // The recorder returns the redacted event; onTrace receives it.
    const r = new TraceRecorder();
    const ev = r.record("t1", "delta", { text: "Authorization: Bearer abc" });
    expect(JSON.stringify(ev)).not.toContain("abc");
  });
});
