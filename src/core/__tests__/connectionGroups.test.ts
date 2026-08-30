// src/core/__tests__/connectionGroups.test.ts
// DBX-05 TASK-DBX05-001 — pure folder/color helpers.
import { describe, it, expect } from "vitest";
import {
  GROUP_COLOR_PALETTE,
  assignColor,
  listGroups,
  groupConnections,
} from "../connectionGroups";

describe("connectionGroups", () => {
  it("palette has 8 unique colors", () => {
    expect(GROUP_COLOR_PALETTE.length).toBe(8);
    expect(new Set(GROUP_COLOR_PALETTE).size).toBe(8);
  });

  it("assignColor is deterministic and spreads across folders", () => {
    expect(assignColor("prod")).toBe(assignColor("prod"));
    const colors = new Set(
      ["prod", "staging", "dev", "qa", "temp", "a", "b", "c"].map(assignColor),
    );
    // Hash spread: at least 3 distinct colors across 8 folder names.
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it("listGroups excludes missing folder and sorts", () => {
    const groups = listGroups([
      { folder: "prod" },
      {},
      { folder: "dev" },
      { folder: "prod" },
      { folder: "" },
    ]);
    expect(groups).toEqual(["dev", "prod"]);
  });

  it("groupConnections: alphabetical groups, ungrouped last, stable item order", () => {
    const a = { id: "a", folder: "prod" };
    const b = { id: "b" };
    const c = { id: "c", folder: "dev" };
    const d = { id: "d", folder: "prod" };
    const groups = groupConnections([a, b, c, d]);
    expect(groups.map((g) => g.folder)).toEqual(["dev", "prod", undefined]);
    expect(groups[1].items).toEqual([a, d]);
    expect(groups[2].items).toEqual([b]);
  });

  it("groupConnections with no folders returns single ungrouped bucket", () => {
    const x = { id: "x" };
    const groups = groupConnections([x]);
    expect(groups.length).toBe(1);
    expect(groups[0].folder).toBeUndefined();
    expect(groups[0].items).toEqual([x]);
  });
});
