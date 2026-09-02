// src/ui/__tests__/consolePanelMessages.test.ts — TASK-001 Console protocol.
// Cycle AIC TASK-AIC-004 — adds Console ghost-text autocomplete message
// variants with strict runtime validation, mirroring the existing pattern.
import { describe, it, expect } from "vitest";
import {
  isConsoleToHostMessage,
  suggestSaveFileName,
} from "../consolePanelMessages";

describe("isConsoleToHostMessage — AIC-004 autocomplete variants", () => {
  it("accepts a well-formed requestAutocomplete message", () => {
    const raw: unknown = {
      type: "requestAutocomplete",
      tabId: "tab-1",
      requestId: "req-1",
      cursorOffset: 16,
      documentText: "SELECT * FROM us",
    };
    expect(isConsoleToHostMessage(raw)).toBe(true);
  });

  it("accepts a well-formed acceptAutocomplete message", () => {
    const raw: unknown = {
      type: "acceptAutocomplete",
      tabId: "tab-1",
      requestId: "req-1",
      suffix: "ers",
    };
    expect(isConsoleToHostMessage(raw)).toBe(true);
  });

  it("accepts a well-formed clearAutocomplete message", () => {
    const raw: unknown = {
      type: "clearAutocomplete",
      tabId: "tab-1",
    };
    expect(isConsoleToHostMessage(raw)).toBe(true);
  });

  it("rejects requestAutocomplete with missing tabId", () => {
    const raw: unknown = {
      type: "requestAutocomplete",
      requestId: "req-1",
      cursorOffset: 16,
      documentText: "SELECT 1",
    };
    expect(isConsoleToHostMessage(raw)).toBe(false);
  });

  it("rejects requestAutocomplete with non-string requestId", () => {
    const raw: unknown = {
      type: "requestAutocomplete",
      tabId: "tab-1",
      requestId: 42,
      cursorOffset: 16,
      documentText: "SELECT 1",
    };
    expect(isConsoleToHostMessage(raw)).toBe(false);
  });

  it("rejects acceptAutocomplete with non-string suffix", () => {
    const raw: unknown = {
      type: "acceptAutocomplete",
      tabId: "tab-1",
      requestId: "req-1",
      suffix: 7,
    };
    expect(isConsoleToHostMessage(raw)).toBe(false);
  });

  it("rejects clearAutocomplete with missing tabId", () => {
    const raw: unknown = {
      type: "clearAutocomplete",
    };
    expect(isConsoleToHostMessage(raw)).toBe(false);
  });

  it("rejects unknown autocomplete type", () => {
    const raw: unknown = { type: "ghostTextApply", tabId: "x" };
    expect(isConsoleToHostMessage(raw)).toBe(false);
  });
});

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

// ---- ARP-08 TASK-ARP08-001 — draft snapshot codec + clearDrafts wire --------
//
// Pure-unit coverage for the versioned, bounded ConsoleDraftSnapshot codec:
//   - parse is FAIL-CLOSED: malformed JSON, wrong/missing version, bad shape,
//     unknown activeTabId, empty/over-cap payloads all return null (no throw).
//   - parse REBUILDS a fresh object with exactly the declared fields, so
//     unknown extra fields are tolerated on the wire but stripped from the
//     result ("tolerated-and-stripped") and no caller can mutate the
//     persisted payload through the parsed value.
//   - encode is a verbatim JSON serialization — clamping to the caps is the
//     host's job (TASK-ARP08-002), never the codec's.
//   - `clearDrafts` joins the webview→host union; its guard is type-only,
//     mirroring `historyList`.

import {
  CONSOLE_DRAFTS_KEY,
  CONSOLE_DRAFT_SNAPSHOT_VERSION,
  CONSOLE_DRAFTS_MAX_BUFFER_CHARS,
  CONSOLE_DRAFTS_MAX_NAME_CHARS,
  CONSOLE_DRAFTS_MAX_TABS,
  encodeConsoleDraftSnapshot,
  parseConsoleDraftSnapshot,
} from "../consolePanelMessages";
import type { ConsoleDraftSnapshot } from "../consolePanelMessages";

function makeValidSnapshot(): ConsoleDraftSnapshot {
  return {
    version: 1,
    tabs: [
      { id: "tab-1", name: "Users", buffer: "SELECT * FROM users;" },
      { id: "tab-2", name: "Orders", buffer: "SELECT * FROM orders;" },
    ],
    activeTabId: "tab-1",
  };
}

describe("CONSOLE_DRAFTS_* constants (ARP-08)", () => {
  it("exports the persisted-draft storage key, schema version, and caps", () => {
    expect(CONSOLE_DRAFTS_KEY).toBe("vsdb.consoleDrafts");
    expect(CONSOLE_DRAFT_SNAPSHOT_VERSION).toBe(1);
    expect(CONSOLE_DRAFTS_MAX_TABS).toBe(20);
    expect(CONSOLE_DRAFTS_MAX_BUFFER_CHARS).toBe(64_000);
    expect(CONSOLE_DRAFTS_MAX_NAME_CHARS).toBe(200);
  });
});

// ---- #1 — encode→parse round-trip -------------------------------------------

describe("encodeConsoleDraftSnapshot / parseConsoleDraftSnapshot — happy path", () => {
  it("#1 round-trips a valid 2-tab snapshot losslessly", () => {
    const snapshot = makeValidSnapshot();
    const encoded = encodeConsoleDraftSnapshot(snapshot);
    const parsed = parseConsoleDraftSnapshot(encoded);
    expect(parsed).toEqual(snapshot);
    expect(parsed?.version).toBe(1);
    // Exactly the declared top-level shape — unknown fields never survive.
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "activeTabId",
      "tabs",
      "version",
    ]);
  });
});

// ---- #2 — malformed input is rejected, never thrown -------------------------

describe("parseConsoleDraftSnapshot — malformed input", () => {
  it("#2 returns null (no throw) on non-JSON and primitive carriers", () => {
    expect(parseConsoleDraftSnapshot("not-json")).toBeNull();
    expect(parseConsoleDraftSnapshot("42")).toBeNull();
    expect(
      parseConsoleDraftSnapshot(undefined as unknown as string),
    ).toBeNull();
    expect(parseConsoleDraftSnapshot(null as unknown as string)).toBeNull();
  });
});

// ---- #3 — version gate -------------------------------------------------------

describe("parseConsoleDraftSnapshot — version gate", () => {
  it("#3 rejects a future version and a missing version", () => {
    const future = JSON.stringify({
      version: 2,
      tabs: [{ id: "tab-1", name: "Users", buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    });
    expect(parseConsoleDraftSnapshot(future)).toBeNull();
    const versionless = JSON.stringify({
      tabs: [{ id: "tab-1", name: "Users", buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    });
    expect(parseConsoleDraftSnapshot(versionless)).toBeNull();
  });
});

// ---- #4 — shape gate ---------------------------------------------------------

describe("parseConsoleDraftSnapshot — shape gate", () => {
  it("#4 rejects non-array tabs, non-string tab fields, and non-string activeTabId", () => {
    const tabsJson =
      '[{"id":"tab-1","name":"Users","buffer":"SELECT 1;"}]';
    // tabs not an array.
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({ version: 1, tabs: {}, activeTabId: "tab-1" }),
      ),
    ).toBeNull();
    // Tab with a non-string buffer (JSON numbers survive postMessage/memento).
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({
          version: 1,
          tabs: [{ id: "tab-1", name: "Users", buffer: 7 }],
          activeTabId: "tab-1",
        }),
      ),
    ).toBeNull();
    // Tab with a null id.
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({
          version: 1,
          tabs: [{ id: null, name: "Users", buffer: "SELECT 1;" }],
          activeTabId: "tab-1",
        }),
      ),
    ).toBeNull();
    // Non-string tab name.
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({
          version: 1,
          tabs: [{ id: "tab-1", name: 9, buffer: "SELECT 1;" }],
          activeTabId: "tab-1",
        }),
      ),
    ).toBeNull();
    // activeTabId not a string.
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({ version: 1, tabs: JSON.parse(tabsJson), activeTabId: 1 }),
      ),
    ).toBeNull();
  });

  it("#4b rejects an empty tabs array (a restored panel must have a tab)", () => {
    const empty = JSON.stringify({ version: 1, tabs: [], activeTabId: "tab-1" });
    expect(parseConsoleDraftSnapshot(empty)).toBeNull();
  });
});

// ---- #5 — deterministic bounds -----------------------------------------------

describe("parseConsoleDraftSnapshot — bounds", () => {
  it("#5 rejects over-cap tabs and over-cap buffers, accepts the exact caps", () => {
    expect(CONSOLE_DRAFTS_MAX_TABS).toBe(20);
    expect(CONSOLE_DRAFTS_MAX_BUFFER_CHARS).toBe(64_000);
    // 21 tabs (cap + 1) — corrupt → null.
    const manyTabs = Array.from({ length: CONSOLE_DRAFTS_MAX_TABS + 1 }, (_, i) => ({
      id: `tab-${i}`,
      name: `T${i}`,
      buffer: "SELECT 1;",
    }));
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({
          version: 1,
          tabs: manyTabs,
          activeTabId: "tab-0",
        }),
      ),
    ).toBeNull();
    // One 64_001-char buffer — corrupt → null.
    const overBuffer = "x".repeat(CONSOLE_DRAFTS_MAX_BUFFER_CHARS + 1);
    expect(
      parseConsoleDraftSnapshot(
        JSON.stringify({
          version: 1,
          tabs: [{ id: "tab-1", name: "Users", buffer: overBuffer }],
          activeTabId: "tab-1",
        }),
      ),
    ).toBeNull();
    // Exactly 64_000 chars — parses.
    const exactBuffer = "x".repeat(CONSOLE_DRAFTS_MAX_BUFFER_CHARS);
    const exact = JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", name: "Users", buffer: exactBuffer }],
      activeTabId: "tab-1",
    });
    const parsed = parseConsoleDraftSnapshot(exact);
    expect(parsed).not.toBeNull();
    expect(parsed?.tabs[0]?.buffer).toHaveLength(CONSOLE_DRAFTS_MAX_BUFFER_CHARS);
  });
});

// ---- #6 — active-tab integrity ------------------------------------------------

describe("parseConsoleDraftSnapshot — active-tab integrity", () => {
  it("#6 rejects an activeTabId that matches no tab", () => {
    const ghost = JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", name: "Users", buffer: "SELECT 1;" }],
      activeTabId: "ghost",
    });
    expect(parseConsoleDraftSnapshot(ghost)).toBeNull();
  });
});

// ---- #7 — forward compatibility: tolerated-and-stripped -----------------------

describe("parseConsoleDraftSnapshot — forward compat", () => {
  it("#7 strips unknown top-level fields and re-encodes without them", () => {
    const withExtra = JSON.stringify({
      ...makeValidSnapshot(),
      extra: { x: 1 },
    });
    const parsed = parseConsoleDraftSnapshot(withExtra);
    // Tolerated (parses) and stripped (clean object, no `extra`).
    expect(parsed).toEqual(makeValidSnapshot());
    expect(parsed).not.toHaveProperty("extra");
    // Re-encoding the parsed value omits the unknown field forever.
    expect(encodeConsoleDraftSnapshot(parsed as ConsoleDraftSnapshot)).not.toContain(
      "extra",
    );
  });
});

// ---- TASK-CL-003 — tab name cap (ARP-08 minor) -------------------------------
//
// Pure-unit coverage for CONSOLE_DRAFTS_MAX_NAME_CHARS:
//   - parse REJECTS over-cap names (fail-closed) but accepts the exact cap
//     and the empty name (cap is an upper bound).
//   - The existing non-string-name reject path is preserved (composes after,
//     not instead of).
//   - A short ("Query 1") name round-trips losslessly through the codec.

describe("parseConsoleDraftSnapshot — tab name cap (TASK-CL-003)", () => {
  it("#1 name exactly at cap round-trips through encode→parse losslessly", () => {
    const exactName = "n".repeat(CONSOLE_DRAFTS_MAX_NAME_CHARS);
    const snapshot: ConsoleDraftSnapshot = {
      version: 1,
      tabs: [{ id: "tab-1", name: exactName, buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    };
    const encoded = encodeConsoleDraftSnapshot(snapshot);
    const parsed = parseConsoleDraftSnapshot(encoded);
    expect(parsed).toEqual(snapshot);
    expect(parsed?.tabs[0]?.name).toHaveLength(CONSOLE_DRAFTS_MAX_NAME_CHARS);
  });

  it("#1b short name unaffected: 'Query 1' round-trips verbatim", () => {
    const snapshot: ConsoleDraftSnapshot = {
      version: 1,
      tabs: [
        { id: "tab-1", name: "Query 1", buffer: "SELECT 1;" },
        { id: "tab-2", name: "Query 2", buffer: "SELECT 2;" },
      ],
      activeTabId: "tab-1",
    };
    const encoded = encodeConsoleDraftSnapshot(snapshot);
    const parsed = parseConsoleDraftSnapshot(encoded);
    expect(parsed).toEqual(snapshot);
    expect(parsed?.tabs.map((t) => t.name)).toEqual(["Query 1", "Query 2"]);
  });

  it("#3 name 201 chars (cap + 1) → parse rejects (fail-closed)", () => {
    const overName = "n".repeat(CONSOLE_DRAFTS_MAX_NAME_CHARS + 1);
    const raw = JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", name: overName, buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    });
    expect(parseConsoleDraftSnapshot(raw)).toBeNull();
  });

  it("#5 empty name '' is still valid (cap is an upper bound only)", () => {
    const snapshot: ConsoleDraftSnapshot = {
      version: 1,
      tabs: [{ id: "tab-1", name: "", buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    };
    const parsed = parseConsoleDraftSnapshot(encodeConsoleDraftSnapshot(snapshot));
    expect(parsed).toEqual(snapshot);
    expect(parsed?.tabs[0]?.name).toBe("");
  });

  it("#6 non-string name still rejected: new cap check composes after typeof check", () => {
    // The pre-existing typeof guard still rejects non-strings (numeric `name`
    // would fail BEFORE the length check runs — both checks are independent
    // and both must hold).
    const raw = JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", name: 42, buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    });
    expect(parseConsoleDraftSnapshot(raw)).toBeNull();
    // null name is also rejected by the existing typeof path.
    const rawNull = JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", name: null, buffer: "SELECT 1;" }],
      activeTabId: "tab-1",
    });
    expect(parseConsoleDraftSnapshot(rawNull)).toBeNull();
  });
});

describe("clearDrafts wire (ARP-08)", () => {
  it("#8 accepts the type-only clearDrafts message and narrows it", () => {
    const raw: unknown = { type: "clearDrafts" };
    expect(isConsoleToHostMessage(raw)).toBe(true);
    if (isConsoleToHostMessage(raw)) {
      expect(raw.type).toBe("clearDrafts");
      expect(Object.keys(raw).sort()).toEqual(["type"]);
    }
  });

  it("#9 keeps the guard type-only (extra fields ignored) and rejects the singular typo", () => {
    expect(isConsoleToHostMessage({ type: "clearDrafts", junk: 42 })).toBe(true);
    expect(isConsoleToHostMessage({ type: "clearDrafts", tabId: "x" })).toBe(true);
    expect(isConsoleToHostMessage({ type: "clearDraft" })).toBe(false);
  });

  it("#10 does not disturb pre-existing message families", () => {
    expect(
      isConsoleToHostMessage({ type: "runConsole", sql: "SELECT 1" }),
    ).toBe(true);
    expect(
      isConsoleToHostMessage({ type: "updateBuffer", tabId: "t", buffer: "SELECT 1" }),
    ).toBe(true);
    expect(
      isConsoleToHostMessage({
        type: "requestAutocomplete",
        tabId: "t",
        requestId: "r",
        cursorOffset: 0,
        documentText: "SELECT 1",
      }),
    ).toBe(true);
  });
});
