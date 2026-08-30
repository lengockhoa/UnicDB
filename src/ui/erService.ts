// src/ui/erService.ts — TASK-DBX04-003
// Orchestrator for the Relationship Explorer: introspect tables of one
// schema, build the closed-world FK graph, lay it out. Mirrors
// compareService's discipline: driver gate BEFORE any adapter call,
// graceful per-table degradation, never throws.

import type { DbAdapter } from "../adapters/types";
import { buildErGraph, type ErGraph } from "../core/er/fkGraph";
import { layoutErGraph, type LayoutResult } from "../core/er/layout";

/** Node cap: past this the graph is capped (FK degree, tie-break by id)
 *  and `truncated` flags the result. */
export const MAX_ER_NODES = 200;

export type ErResult =
  | { ok: true; graph: ErGraph; layout: LayoutResult; truncated: boolean }
  | { ok: false; reason: "unsupported-driver" | "no-adapter" };

export interface ErServiceOptions {
  maxNodes?: number;
}

/** Degree per table = number of FK edges touching it (in or out). Used
 *  for the deterministic cap ranking. */
function degreeMap(graph: ErGraph): Map<string, number> {
  const deg = new Map<string, number>();
  for (const n of graph.nodes) deg.set(n.id, 0);
  for (const e of graph.edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

/**
 * @param driver  active driver id ("postgres" only) — gate input.
 * @param schema  schema to explore.
 */
export async function runErExplorer(
  adapter: DbAdapter | null,
  driver: string | undefined,
  schema: string = "public",
  options: ErServiceOptions = {},
): Promise<ErResult> {
  if (driver !== "postgres") {
    return { ok: false, reason: "unsupported-driver" };
  }
  if (!adapter) {
    return { ok: false, reason: "no-adapter" };
  }

  let tables: Array<{ schema: string; name: string }> = [];
  try {
    const listed = await adapter.listTables(schema);
    tables = listed.map((t) => ({ schema: t.schema, name: t.name }));
  } catch {
    tables = [];
  }

  const maxNodes = options.maxNodes ?? MAX_ER_NODES;

  // Fetch details for ALL listed tables (per-table catch), THEN rank by
  // FK degree and cap — the reviewer's point: an alphabetical pre-slice
  // can never consider a high-degree table beyond the slice, so the
  // top-by-degree contract would be dead code.
  const collected: Array<{ schema: string; table: string; detail: Awaited<ReturnType<DbAdapter["listTableDetail"]>> }> = [];
  for (const t of tables) {
    try {
      const detail = await adapter.listTableDetail(t.schema, t.name);
      collected.push({ schema: t.schema, table: t.name, detail });
    } catch {
      // Table dropped mid-listing or introspection failed — omit.
    }
  }

  let graph = buildErGraph(collected);

  // Degree cap: keep the top `maxNodes` tables by FK edge count
  // (in + out), tie-break by schema-qualified id. Deterministic.
  const listedExceedsCap = tables.length > maxNodes;
  let truncated = listedExceedsCap;
  if (graph.nodes.length > maxNodes) {
    const deg = degreeMap(graph);
    const keep = new Set(
      [...graph.nodes]
        .map((n) => n.id)
        .sort((a, b) => {
          const d = (deg.get(b) ?? 0) - (deg.get(a) ?? 0);
          return d !== 0 ? d : a < b ? -1 : 1;
        })
        .slice(0, maxNodes),
    );
    graph = {
      nodes: graph.nodes.filter((n) => keep.has(n.id)),
      edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      droppedEdges: graph.droppedEdges,
    };
    truncated = true;
  }

  const layout = layoutErGraph(graph);
  return { ok: true, graph, layout, truncated };
}
