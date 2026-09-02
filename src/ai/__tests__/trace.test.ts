// src/ai/__tests__/trace.test.ts — TASK-AIX06-001
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TraceRecorder,
  redact,
  MAX_ENTRIES_PER_TURN,
  MAX_TURNS,
} from "../trace";
import { logLine } from "../../core/diagnostics";

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
    const out = redact({ header: "Authorization: Bearer eyJhbGciOi" });
    // AIX-06 r3: Authorization is now caught by the KV scrubber (covers
    // both the structural "Authorization: <value>" form and the raw
    // "Authorization=short" form). The value `eyJhbGciOi` is also
    // long enough to be caught by the opaque-run scrubber.
    expect(JSON.stringify(out)).not.toContain("eyJhbGciOi");
    expect(JSON.stringify(out)).toContain("<redacted>");
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

describe("TraceRecorder.dumpAll (TASK-AIX07-002)", () => {
  it("returns turns in insertion order, copy-safe", () => {
    const r = new TraceRecorder();
    r.record("turn-a", "prompt", { x: 1 });
    r.record("turn-b", "prompt", { x: 2 });
    r.record("turn-a", "delta", { x: 3 });
    const all = r.dumpAll();
    expect(all.map((d) => d.turnId)).toEqual(["turn-a", "turn-b"]);
    // seq is per-turn: turn-a holds seq 1 then 2, turn-b holds seq 1.
    expect(all[0]!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(all[0]!.events.map((e) => e.payload)).toEqual([{ x: 1 }, { x: 3 }]);
    expect(all[1]!.events.map((e) => e.seq)).toEqual([1]);
    expect(all[1]!.events.map((e) => e.payload)).toEqual([{ x: 2 }]);
    // Copy-safe: mutating the returned inner arrays must not leak in.
    all[0]!.events.push({
      turnId: "turn-a",
      seq: 999,
      kind: "error",
      ts: 0,
      payload: "mutated",
    });
    expect(r.dumpAll()[0]!.events).toHaveLength(2);
    expect(r.events("turn-a")).toHaveLength(2);
  });

  it("empty recorder snapshots to an empty array", () => {
    const r = new TraceRecorder();
    expect(r.dumpAll()).toEqual([]);
  });

  it("preserves per-turn truncated flag in the snapshot", () => {
    const r = new TraceRecorder({ maxEntriesPerTurn: 2 });
    for (let i = 0; i < 4; i++) r.record("t1", "delta", { i });
    const all = r.dumpAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.truncated).toBe(true);
    expect(all[0]!.events).toHaveLength(2);
  });

  it("snapshot cannot mutate recorder internals", () => {
    const r = new TraceRecorder();
    r.record("t1", "prompt", { x: 1 });
    const all = r.dumpAll();
    // Outer array is frozen; a push must throw and never land.
    expect(() =>
      (all as unknown as { push: (d: unknown) => void }).push({
        turnId: "evil",
        events: [],
        truncated: false,
      }),
    ).toThrow();
    expect(r.dumpAll().map((d) => d.turnId)).toEqual(["t1"]);
    // Even an inner-copy mutation leaves subsequent output intact.
    r.dumpAll()[0]!.events.push({
      turnId: "t1",
      seq: 42,
      kind: "error",
      ts: 0,
      payload: "injected",
    });
    expect(r.events("t1")).toHaveLength(1);
    expect(r.dumpAll()[0]!.events).toHaveLength(1);
  });

  it("clear() empties dumpAll() too", () => {
    const r = new TraceRecorder();
    r.record("t1", "prompt", { x: 1 });
    r.clear();
    expect(r.dumpAll()).toEqual([]);
  });
});

describe("redact toolCallId allowlist (TASK-AIX03-103)", () => {
  it("tcid:-marked long run bypasses LONG_RUN_RE but keeps key-level scrub", () => {
    const MARKED = "tcid:call_abcdefghijklmnopqrstuvwxyz";
    const out = redact({ toolCallId: MARKED }) as Record<string, string>;
    expect(out.toolCallId).toBe(MARKED);
  });

  it("unmarked long run remains scrubbed even when stored under toolCallId", () => {
    const UNMARKED = "call_abcdefghijklmnopqrstuvwxyz";
    const out = redact({ toolCallId: UNMARKED }) as Record<string, string>;
    expect(out.toolCallId).toBe("<redacted>");
  });

  it("tcid: marker without the long run still survives in a string value", () => {
    const SHORT_MARKED = "tcid:c1";
    const out = redact({ note: `id=${SHORT_MARKED}` }) as Record<string, string>;
    expect(out.note).toContain(SHORT_MARKED);
  });

  it("bearer / kv scrub still wins over the tcid: exemption", () => {
    const out = redact({ toolCallId: "Bearer abcdefghijklmnop" }) as Record<string, string>;
    expect(out.toolCallId).toContain("<redacted>");
    expect(out.toolCallId).not.toContain("abcdefghijklmnop");
  });

  it("the marker is case-sensitive and prefix-anchored", () => {
    // Wrong prefix — even with the same body — must NOT take the
    // marker exemption. The long run body still falls under
    // LONG_RUN_RE; only the exact lowercase `tcid:` prefix bypasses
    // the scrub. Result: `TCID:` is preserved, the long-run body is
    // replaced with `<redacted>`.
    const out = redact({ toolCallId: "TCID:call_abcdefghijklmnopqrstuvwxyz" }) as Record<string, string>;
    expect(out.toolCallId).toBe("TCID:<redacted>");
    expect(out.toolCallId).not.toBe("tcid:<redacted>");
    expect(out.toolCallId).not.toContain("call_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("redact r3 review (AIX-06 / DBX-07)", () => {
  it("scrubs Authorization=<short> (KV_RE alternative covers bare Authorization)", () => {
    // r3 added `authorization` to the KV_RE alternative so the bare
    // `Authorization=ab` form is scrubbed even when the value is too
    // short for LONG_RUN_RE. The no-min rule from r2 still applies.
    const out = redact({ s: "Authorization=ab" }) as Record<string, string>;
    expect(out.s).not.toContain("ab");
    expect(out.s).toContain("<redacted>");
  });
  it("does NOT redact normal prose like 'auth flow' (r3 review fix)", () => {
    // Bare `auth` was removed from KV_RE — it over-redacted normal
    // phrases. `auth flow` must survive untouched.
    const out = redact({ s: "switched to a new auth flow" }) as Record<string, string>;
    expect(out.s).toBe("switched to a new auth flow");
  });
  it("scrubs auth=<value> with an explicit delimiter (r3 round 2)", () => {
    // Round 2 finding: after removing bare `auth` from KV_RE, the
    // form `auth=tk` escaped entirely. The dedicated AUTH_KV_RE
    // (colon/equals delimiters only) closes that gap.
    const out = redact({ s: "auth=tk" }) as Record<string, string>;
    expect(out.s).not.toContain("tk");
    expect(out.s).toContain("<redacted>");
  });
  it("scrubs literal key `auth` at object level (r3 round 2)", () => {
    // Round 2 finding: key `auth` alone was not in SECRET_KEY_RE, so
    // { auth: "short-secret" } escaped. Adding `auth` to the key-level
    // scrubber closes it.
    const out = redact({ auth: "short-secret" }) as Record<string, string>;
    expect(out.auth).toBe("<redacted>");
  });
  it("keeps 'auth:flow'-style prose after the new delimiter rule", () => {
    // Sanity: prose mentioning auth followed by a colon-free context
    // (e.g. discussion text) is untouched when there is no delimiter.
    const out = redact({ s: "we discuss auth in the next section" }) as Record<string, string>;
    expect(out.s).toBe("we discuss auth in the next section");
  });
});

describe("ARP-09 diagnostics reuse — TASK-ARP09-004", () => {
  // Read-only source-shape evidence: ARP-09's diagnostics formatter must
  // REUSE trace.ts redaction, never re-implement or bypass it. Mirrors the
  // source-reading pin pattern of policy.test.ts (pure — no vscode).
  const diagSrc = readFileSync(
    fileURLToPath(new URL("../../core/diagnostics.ts", import.meta.url)),
    "utf8",
  );

  // Case 25 — happy: redact is imported from trace.ts and actually called
  // from the logLine path (applied, not an import-only dead reference).
  it("diagnostics.ts imports redact from ../ai/trace and calls it in logLine's path", () => {
    expect(diagSrc).toMatch(/import\s*\{\s*redact\s*\}\s*from\s*["']\.\.\/ai\/trace["']/);
    // The single redact( call lives in toRedactedSingleLine, which logLine
    // calls — prove reachability from logLine's body.
    expect(diagSrc).toMatch(/function logLine\(/);
    expect(diagSrc).toMatch(/toRedactedSingleLine\(message\)/);
    expect(diagSrc).toMatch(/redact\(raw\)/);
  });

  // Case 26 — edge: NO local copy of the secret scrubber. The only
  // replace() calls in the file must be line-break stripping, not
  // secret-shaped token replacement.
  it("diagnostics.ts contains no re-implemented secret scrubber", () => {
    expect(diagSrc).not.toMatch(/Bearer\s+[A-Za-z0-9._\-+/=]+/);
    expect(diagSrc).not.toMatch(/Basic\s+[A-Za-z0-9._\-+/=]+/);
    expect(diagSrc).not.toMatch(/new RegExp\(/);
    expect(diagSrc).not.toMatch(/SECRET_KEY_RE|BEARER_RE|BASIC_RE|KV_RE|AUTH_KV_RE|LONG_RUN_RE/);
    // The lone replace() uses strip ONLY line breaks (diagnostics.ts:47,53).
    const replaces = diagSrc.match(/\.replace\([^)]*\)/g) ?? [];
    expect(replaces.length).toBeGreaterThan(0);
    for (const r of replaces) {
      expect(r).toMatch(/\\r|\\n/);
    }
  });

  // Case 27 — edge: the import is APPLIED — a secret-shaped payload driven
  // through the diagnostics formatter comes out byte-identical to what
  // redact() produces directly for the same input (same marker shape).
  it("logLine output carries exactly the marker redact() produces", () => {
    const secret = "provider failed: Authorization: Bearer eyJhbGciOiJFUzI1NiIsInRlc3Q";
    const direct = redact(secret) as string;
    const viaLogLine = logLine("ai", "error", secret, undefined, new Date(0));
    // Same scrub result inside the formatted line.
    expect(viaLogLine).toContain(direct);
    // No secret residue anywhere on the line.
    expect(viaLogLine).not.toContain("eyJhbGciOiJFUzI1NiIsInRlc3Q");
    // Same holds for the key=value form (PLAN §4 rows 3-4 fixtures).
    const kv = "password = 'hunter2'";
    expect(logLine("general", "warn", kv, undefined, new Date(0))).toContain(
      redact(kv) as string,
    );
  });

  // Case 29 — edge: no unredacted write path. Every appendLine argument in
  // extension.ts must be logLine-formatted (REDACTED). Today 003 has not
  // landed (no appendLine at all — vacuously true, gated per the task's
  // Dependencies note); when 003 lands, its flush site must keep the
  // `appendLine(logLine(...))` shape — `appendLine(<raw>)` fails this pin.
  it("every appendLine argument in extension.ts is logLine-formatted", () => {
    const extSrc = readFileSync(
      fileURLToPath(new URL("../../extension.ts", import.meta.url)),
      "utf8",
    );
    // One nesting level is enough for appendLine(logLine(...)) shapes.
    const appendCalls = extSrc.match(/\.appendLine\((?:[^()]|\([^()]*\))*\)/g) ?? [];
    for (const call of appendCalls) {
      expect(call).toContain("logLine(");
    }
  });
});
