// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown; matchMedia?: unknown };
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

describe("input listener fires", () => {
  it("works", () => {
    const inp = document.createElement("input");
    inp.className = "vsdb-search-input";
    let fired = false;
    inp.addEventListener("input", () => { fired = true; console.log("FIRES"); });
    document.body.appendChild(inp);
    inp.value = "beta";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    console.log("fired:", fired);
    expect(fired).toBe(true);
  });
});
