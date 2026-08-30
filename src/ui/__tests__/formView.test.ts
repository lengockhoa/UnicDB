// src/ui/__tests__/formView.test.ts
// DBX-01-004 — form view host: labeled rows, JSON expansion without
// truncation, null rendering.

import { describe, it, expect } from "vitest";
import {
  buildFormEntries,
  renderFormMessage,
  NULL_LABEL,
  LARGE_VALUE_THRESHOLD,
} from "../formView";

describe("buildFormEntries", () => {
  it("produces one labeled entry per column in key order", () => {
    const entries = buildFormEntries({ id: 1, name: "Ann", active: true });
    expect(entries.map((e) => e.column)).toEqual(["id", "name", "active"]);
    expect(entries.map((e) => e.value)).toEqual(["1", "Ann", "true"]);
  });

  it("keeps large JSON intact — no truncation at any size", () => {
    const payload = JSON.stringify({ data: "x".repeat(10 * 1024) });
    const entries = buildFormEntries({ payload });
    expect(entries[0]?.large).toBe(true);
    expect(entries[0]?.value).toBe(payload);
    expect(entries[0]?.value?.length).toBe(payload.length);
    expect(entries[0]?.value).not.toContain("…");
  });

  it("renders null as the NULL label (not empty string)", () => {
    const entries = buildFormEntries({ id: 1, note: null });
    expect(entries[1]?.value).toBeNull();
    expect(NULL_LABEL).toBe("(NULL)");
  });

  it("marks entries above the threshold as large", () => {
    const short = "a".repeat(10);
    const long = "b".repeat(LARGE_VALUE_THRESHOLD + 10);
    const entries = buildFormEntries({ short, long });
    expect(entries[0]?.large).toBe(false);
    expect(entries[1]?.large).toBe(true);
  });
});

describe("renderFormMessage", () => {
  it("produces a webview message payload without raw rows", () => {
    const msg = renderFormMessage({ id: 1, name: "Ann" }, "users · row 1");
    expect(msg.type).toBe("formView");
    expect(msg.title).toBe("users · row 1");
    expect(msg.entries.length).toBe(2);
    expect(msg.entries[0]?.column).toBe("id");
  });
});
