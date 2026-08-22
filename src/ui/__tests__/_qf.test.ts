// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { createGrid, getGridApi, AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import type { GridApi } from "ag-grid-community";

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown; matchMedia?: unknown };
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!g.matchMedia) g.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
});

ModuleRegistry.registerModules([AllCommunityModule]);

describe("quick filter via setGridOption", () => {
  it("works in jsdom", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let api: GridApi | undefined;
    try {
      createGrid(el, {
        columnDefs: [{ field: "name" }],
        rowData: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      });
      api = getGridApi(el);
      console.log("Initial:", api.getDisplayedRowCount());
      api.setGridOption("quickFilterText", "beta");
      console.log("Sync after setGridOption:", api.getDisplayedRowCount());
      // Force re-filter
      try { api.refreshClientSideRowModel("filter"); } catch {}
      console.log("After refreshClientSideRowModel:", api.getDisplayedRowCount());
    } finally {
      api?.destroy();
      el.remove();
    }
  });
});
