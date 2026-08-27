// src/ui/__tests__/consolePanelMessages.test.ts — TASK-001 Console protocol.
//
// Pure unit coverage for the Console host/webview message contract:
//   - isConsoleToHostMessage gates EVERY inbound postMessage value because the
//     webview is untrusted runtime input (plan §3.1: "host consumes only
//     guard-approved values").
//   - suggestSaveFileName(date) is deterministic: the caller supplies the Date
//     so unit tests never depend on wall-clock time (planner note, TASK-001).
//   - Zero-padding is load-bearing: filenames sort lexicographically newest-
//     last instead of "console_202611_vs console_20262".
//
// No DOM, no VS Code API — the module under test is deliberately pure so the
// webview bundle can import the same shapes (TASK-002) without vscode imports.

import { describe, it, expect } from "vitest";
import {
  isConsoleToHostMessage,
  suggestSaveFileName,
} from "../consolePanelMessages";

// ---- #1 — guard accepts a well-formed run message and narrows it ----------

describe("isConsoleToHostMessage — happy path", () => {
  it("#1 validates a run message and narrows to the declared run shape", () => {
    const raw: unknown = { type: "runConsole", sql: "SELECT 1" };
    expect(isConsoleToHostMessage(raw)).toBe(true);
    // Narrowing proof: after the guard, TypeScript exposes `.sql` via the
    // declared discriminant — consumed through a separate unknown-typed
    // channel so compile-time narrowing (not just runtime truthiness) is
    // exercised here and enforced by `npm run typecheck`.
    if (isConsoleToHostMessage(raw)) {
      expect(raw.type).toBe("runConsole");
      expect(raw.sql).toBe("SELECT 1");
      // Exactly the declared wire shape — no invented fields.
      expect(Object.keys(raw).sort()).toEqual(["sql", "type"]);
    }
  });

  it("#1b validates a saveConsoleAsSql message (second member of the union)", () => {
    const raw: unknown = { type: "saveConsoleAsSql", sql: "SELECT 2;" };
    expect(isConsoleToHostMessage(raw)).toBe(true);
    if (isConsoleToHostMessage(raw)) {
      expect(raw.type).toBe("saveConsoleAsSql");
      expect(raw.sql).toBe("SELECT 2;");
    }
  });
});

// ---- #2 — deterministic default save filename ------------------------------

describe("suggestSaveFileName", () => {
  it("#2 formats a deterministic SQL filename from the supplied Date", () => {
    // Local-time constructor arguments: year=2026, month=0 (Jan), day=2,
    // 03:04:05 — every field chosen so its two-digit form differs from its
    // raw form except the year (that combination is #4's job).
    expect(suggestSaveFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "console_20260102_030405.sql",
    );
  });
});

// ---- #3 — untrusted postMessage payloads are rejected ----------------------

describe("isConsoleToHostMessage — malformed payloads", () => {
  it("#3 rejects values a hostile webview could post", () => {
    // Null / non-object carrier.
    expect(isConsoleToHostMessage(null)).toBe(false);
    // Known type but MISSING sql entirely.
    expect(isConsoleToHostMessage({ type: "runConsole" })).toBe(false);
    // Known type but sql is the wrong runtime type (JSON numbers survive
    // postMessage intact — only typeof checks catch them).
    expect(isConsoleToHostMessage({ type: "runConsole", sql: 1 })).toBe(false);
    // Unknown discriminator — rejected before any routing switch can fall
    // through (messages.ts house rule: unknown messages ignored).
    expect(
      isConsoleToHostMessage({ type: "unknown", sql: "SELECT 1" }),
    ).toBe(false);
  });

  it("#3b rejects non-object primitives outright", () => {
    expect(isConsoleToHostMessage(undefined)).toBe(false);
    expect(isConsoleToHostMessage("runConsole")).toBe(false);
    expect(isConsoleToHostMessage(42)).toBe(false);
    expect(isConsoleToHostMessage(true)).toBe(false);
  });
});

// ---- #4 — boundary: every padded field is two digits wide ------------------

describe("suggestSaveFileName — zero padding", () => {
  it("#4 zero-pads single-digit month, day, hour, minute, and second", () => {
    // Same instant as #2, asserted field-by-field so a regression in ANY
    // individual pad call is attributed precisely, not just via one string.
    // Each capture group is exactly \d{2}, so a wide-enough-but-one-digit
    // value (e.g. "3") cannot match.
    const name = suggestSaveFileName(new Date(2026, 0, 2, 3, 4, 5));
    const groups =
      /^console_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.sql$/.exec(
        name,
      );
    expect(groups?.[1]).toBe("2026"); // year (four digits)
    expect(groups?.[2]).toBe("01"); // January -> 01, not 1
    expect(groups?.[3]).toBe("02"); // day -> 02
    expect(groups?.[4]).toBe("03"); // hour -> 03
    expect(groups?.[5]).toBe("04"); // minute -> 04
    expect(groups?.[6]).toBe("05"); // second -> 05
  });
});
