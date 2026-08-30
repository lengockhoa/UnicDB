// src/ui/__tests__/largeValueEditor.test.ts
// DBX-01-004 — large-value content provider serves values verbatim.

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  window: { showTextDocument: vi.fn(async () => undefined) },
  Uri: {
    parse: (s: string) => ({
      toString: () => s,
      scheme: s.split(":")[0],
      path: s.slice(s.indexOf(":") + 1),
    }),
  },
}));


import { LargeValueProvider } from "../largeValueEditor";

describe("LargeValueProvider", () => {
  it("serves the value verbatim through the vsdb-lv: URI", () => {
    const provider = new LargeValueProvider();
    const uri = provider.put("users.payload", '{"a":1}');
    expect(uri.scheme).toBe("vsdb-lv");
    expect(provider.provideTextDocumentContent(uri)).toBe('{"a":1}');
  });

  it("passes a 200 KB string through unchanged (never truncates)", () => {
    const provider = new LargeValueProvider();
    const big = "x".repeat(200 * 1024);
    const uri = provider.put("big", big);
    const out = provider.provideTextDocumentContent(uri);
    expect(out.length).toBe(big.length);
    expect(out).toBe(big);
  });

  it("returns empty string for an unknown URI", () => {
    const provider = new LargeValueProvider();
    provider.put("known", "v");
    const fakeUri = { toString: () => "vsdb-lv:/never-put" };
    expect(provider.provideTextDocumentContent(fakeUri as never)).toBe("");
  });

  it("dispose clears every entry", () => {
    const provider = new LargeValueProvider();
    const uri = provider.put("k", "v");
    provider.dispose();
    expect(provider.provideTextDocumentContent(uri)).toBe("");
  });
});
