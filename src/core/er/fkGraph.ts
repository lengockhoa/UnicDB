// src/core/er/fkGraph.ts — TASK-DBX04-001
// FK introspection results -> closed-world ER graph model. Pure module:
// no vscode import, no I/O, deterministic output ordering.

import type { TableDetail } from "../../adapters/types";

export interface ErNode {
  /** "schema.table" — unique node key. */
  id: string;
  schema: string;
  table: string;
  columnCount: number;
  pkColumns: string[];
}

export interface ErEdge {
  /** Constraint name (unique within the graph only if the DB names them
   *  uniquely — the id is the constraint name as a stable sort/order key). */
  id: string;
  /** FK child table node id. */
  source: string;
  /** Referenced parent table node id. */
  target: string;
  sourceColumns: string[];
  targetColumns: string[];
}

export interface ErGraph {
  nodes: ErNode[];
  /** Sorted by id. */
  edges: ErEdge[];
  /** FK constraints dropped because their parent table is outside the
   *  captured detail set (closed-world graph). */
  droppedEdges: number;
}

export interface ErGraphInputEntry {
  schema: string;
  table: string;
  detail: TableDetail;
}

export type ErGraphInput = ErGraphInputEntry[];

/** Resolve a 1-based conkey ordinal list into column names using the
 *  detail's column order (same convention as schemaDiff.shapeFromTableDetail). */
function conkeyToColumns(detail: TableDetail, conkey: number[]): string[] {
  return conkey
    .map((ord) => detail.columns[ord - 1]?.column_name)
    .filter((n): n is string => typeof n === "string");
}

/**
 * Build a closed-world ER graph from captured table details.
 *
 * - One node per input entry, in input order (stable).
 * - One edge per `contype === "f"` constraint, direction child -> parent.
 * - Self-references are kept.
 * - Edges whose parent table is not among the captured entries are
 *   dropped and counted in `droppedEdges`.
 * - Edges are sorted by constraint id for byte-stable output.
 */
export function buildErGraph(input: ErGraphInput): ErGraph {
  const ids = new Set(input.map((e) => `${e.schema}.${e.table}`));

  const nodes: ErNode[] = input.map((e) => {
    const pk = e.detail.constraints.find((c) => c.contype === "p");
    return {
      id: `${e.schema}.${e.table}`,
      schema: e.schema,
      table: e.table,
      columnCount: e.detail.columns.length,
      pkColumns: pk ? conkeyToColumns(e.detail, pk.conkey) : [],
    };
  });

  const edges: ErEdge[] = [];
  let dropped = 0;
  for (const e of input) {
    const sourceId = `${e.schema}.${e.table}`;
    for (const con of e.detail.constraints) {
      if (con.contype !== "f") continue;
      const targetId = con.confrelidname;
      if (targetId === null || !ids.has(targetId)) {
        dropped += 1;
        continue;
      }
      edges.push({
        id: con.conname,
        source: sourceId,
        target: targetId,
        sourceColumns: conkeyToColumns(e.detail, con.conkey),
        targetColumns: con.confkeycols ?? [],
      });
    }
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { nodes, edges, droppedEdges: dropped };
}
