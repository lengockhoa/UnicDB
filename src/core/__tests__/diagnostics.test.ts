// src/core/__tests__/diagnostics.test.ts
// TASK-ARP09-001 — pure redacted diagnostics formatter (TDD RED-first).
// Contract: docs/AI_HANDOFF/tasks/TASK-ARP09-001.md §Test Cases 1-9.
import { describe, it, expect } from "vitest";
import {
  logLine,
  MAX_DIAG_LINE_CHARS,
  type DiagCategory,
  type DiagSeverity,
} from "../diagnostics";

const FIXED = new Date("2026-09-02T00:00:00.000Z");

describe("TASK-ARP09-001 — logLine", () => {
  // Case 1 — happy: exact prefix shape with fixed timestamp.
  it("1. formats `[ISO] [category] [severity] message` exactly", () => {
    expect(logLine("connection", "info", "connection opened", undefined, FIXED)).toBe(
      "[2026-09-02T00:00:00.000Z] [connection] [info] connection opened",
    );
  });

  // Case 2 — happy: correlation suffix appended when id present.
  it("2. appends ` (corr:<id>)` when a correlation id is given", () => {
    const out = logLine("ai", "warn", "retry", "run-42", FIXED);
    expect(out.startsWith("[2026-09-02T00:00:00.000Z] [ai] [warn] retry")).toBe(true);
    expect(out.endsWith(" (corr:run-42)")).toBe(true);
  });

  // Case 3 — edge (secret): bearer token scrubbed via imported redact().
  it("3. scrubs bearer tokens to `<redacted>`", () => {
    const out = logLine(
      "ai",
      "error",
      "provider failed: Authorization: Bearer eyJhbGciOiJFUzI1NiIs…",
      undefined,
      FIXED,
    );
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("eyJhbGciOiJFUzI1NiIs");
  });

  // Case 4 — edge (KV-in-SQL): `password = 'hunter2'` scrubbed via KV_RE.
  it("4. scrubs key=value secrets inside plain messages", () => {
    const out = logLine(
      "general",
      "warn",
      "SELECT * FROM users WHERE password = 'hunter2'",
      undefined,
      FIXED,
    );
    expect(out).not.toContain("hunter2");
    expect(out).toContain("password<redacted>");
  });

  // Case 5 — edge (multiline): single-line invariant.
  it("5. strips newlines — output is exactly one line", () => {
    const out = logLine("general", "info", "line1\nline2\r\nline3", undefined, FIXED);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out.trim()).toBe(out);
    expect(out).toContain("line1 line2 line3");
  });

  // Case 6 — edge (length bound): assembled line bounded to 2000, LAST step.
  it("6. bounds the FULLY assembled line to MAX_DIAG_LINE_CHARS", () => {
    expect(MAX_DIAG_LINE_CHARS).toBe(2000);
    // Contract fixture. NB: a 5000-char `x` run is itself secret-shaped
    // (trace.ts LONG_RUN_RE ≥24 chars), so redact() collapses it to
    // `<redacted>` BEFORE bounding — line stays well under the cap.
    const scrubbed = logLine("general", "info", "x".repeat(5000), undefined, FIXED);
    expect(scrubbed.length).toBeLessThanOrEqual(MAX_DIAG_LINE_CHARS);
    expect(scrubbed).toBe("[2026-09-02T00:00:00.000Z] [general] [info] <redacted>");
    // The bound must bite the ASSEMBLED line: use a redact-surviving long
    // message (no ≥24-char opaque run) so the tail is genuinely cut.
    const long = "x ".repeat(3000); // 6000 chars, survives redact()
    const out = logLine("general", "info", long, undefined, FIXED);
    // cut happens AT the cap (final trim may shave a slice-end space)
    expect(out.length).toBeLessThanOrEqual(MAX_DIAG_LINE_CHARS);
    expect(out.length).toBeGreaterThan(1990);
    // prefix intact, MESSAGE tail is what gets cut
    expect(out.startsWith("[2026-09-02T00:00:00.000Z] [general] [info] x")).toBe(true);
    expect(out.endsWith("x")).toBe(true);
    expect(out).toMatch(/^\[[^\]]+\] \[general\] \[info\] x(?: x)*$/);
    // bound also holds when the correlation suffix is present (suffix
    // assembled BEFORE the slice — it may be cut, prefix never is)
    const withCorr = logLine("ai", "error", long, "run-42", FIXED);
    expect(withCorr.length).toBeLessThanOrEqual(MAX_DIAG_LINE_CHARS);
    expect(withCorr.startsWith("[2026-09-02T00:00:00.000Z] [ai] [error] x")).toBe(true);
  });

  // Case 7 — edge (non-string): JSON.stringify fallback → String().
  it("7. stringifies non-string messages and never throws", () => {
    expect(logLine("general", "info", { a: 1 }, undefined, FIXED)).toContain('{"a":1}');
    expect(logLine("general", "info", null, undefined, FIXED)).toContain("null");
    expect(logLine("general", "info", undefined, undefined, FIXED)).toContain("undefined");
  });

  // Case 8 — edge (degenerate): circular object falls back to String().
  it("8. survives circular objects via String() fallback", () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    const out = logLine("general", "info", c, undefined, FIXED);
    expect(typeof out).toBe("string");
    expect(out).toContain("[object Object]");
  });

  // Case 9 — happy: full category × severity union contract.
  it("9. accepts every category × severity combination", () => {
    const categories: readonly DiagCategory[] = [
      "lifecycle",
      "connection",
      "ai",
      "schema",
      "general",
    ];
    const severities: readonly DiagSeverity[] = ["info", "warn", "error"];
    for (const category of categories) {
      for (const severity of severities) {
        const out = logLine(category, severity, "m", undefined, FIXED);
        expect(out).toBe(`[2026-09-02T00:00:00.000Z] [${category}] [${severity}] m`);
      }
    }
  });
});
