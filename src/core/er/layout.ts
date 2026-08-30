// src/core/er/layout.ts — TASK-DBX04-002
// Deterministic layered layout for ER graphs. Pure module: no vscode
// import, no dependencies, same input -> byte-identical output.

import type { ErGraph } from "./fkGraph";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  /** Insertion-ordered by node id (sorted). */
  nodes: Map<string, LayoutNode>;
  width: number;
  height: number;
}

export const NODE_W = 180;
export const NODE_H = 56;
const GAP_X = 48;
const GAP_Y = 80;
const MARGIN = 24;

/**
 * Layered layout: FK children are drawn BELOW the tables they reference
 * (edges point child -> parent, so parents get layer 0). Cycles are broken
 * by DFS order — the algorithm always terminates because each node is
 * assigned a layer exactly once and remaining in-edges from already-visited
 * nodes are ignored.
 *
 * Nodes within a layer are placed left-to-right in sorted-id order.
 */
export function layoutErGraph(graph: ErGraph): LayoutResult {
  const nodes = new Map<string, LayoutNode>();
  if (graph.nodes.length === 0) {
    return { nodes, width: 0, height: 0 };
  }

  const layerOf = new Map<string, number>();
  const parentsOf = new Map<string, string[]>();
  for (const n of graph.nodes) {
    layerOf.set(n.id, -1);
    parentsOf.set(n.id, []);
  }
  // `parentsOf` maps child -> referenced parents (edge points child ->
  // parent), so a child resolves to parentLayer + 1 and lands BELOW its
  // parents on the canvas.
  for (const e of graph.edges) {
    parentsOf.get(e.source)?.push(e.target);
  }

  // DFS with visited guard: a node's layer is 1 + max(layer of fk-parents
  // that are still being resolved); self-loops and cycles fall back to the
  // resolved part (0 for roots).
  const resolving = new Set<string>();
  const resolve = (id: string): number => {
    const done = layerOf.get(id);
    if (done !== undefined && done >= 0) return done;
    if (resolving.has(id)) return 0; // cycle: treat as root
    resolving.add(id);
    let layer = 0;
    for (const parent of parentsOf.get(id) ?? []) {
      const pl = resolve(parent);
      if (pl + 1 > layer) layer = pl + 1;
    }
    resolving.delete(id);
    layerOf.set(id, layer);
    return layer;
  };

  const sortedIds = graph.nodes.map((n) => n.id).sort();
  for (const id of sortedIds) resolve(id);

  // Bucket by layer, place column-major per layer (sorted id order).
  const layers = new Map<number, string[]>();
  for (const id of sortedIds) {
    const l = layerOf.get(id) ?? 0;
    const bucket = layers.get(l);
    if (bucket) bucket.push(id);
    else layers.set(l, [id]);
  }

  let width = 0;
  let height = 0;
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);
  layerKeys.forEach((l, rowIndex) => {
    const bucket = layers.get(l) ?? [];
    bucket.forEach((id, colIndex) => {
      const x = MARGIN + colIndex * (NODE_W + GAP_X);
      const y = MARGIN + rowIndex * (NODE_H + GAP_Y);
      nodes.set(id, { id, x, y, w: NODE_W, h: NODE_H });
      const right = x + NODE_W + MARGIN;
      if (right > width) width = right;
      const bottom = y + NODE_H + MARGIN;
      if (bottom > height) height = bottom;
    });
  });

  return { nodes, width, height };
}
