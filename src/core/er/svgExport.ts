// src/core/er/svgExport.ts — TASK-DBX04-002
// Static SVG export for ER graphs. Pure string renderer: no vscode, no
// DOM. ALL text is XML-escaped — table names come from the database and
// must never break out of the document.

import type { ErGraph } from "./fkGraph";
import type { LayoutResult } from "./layout";

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const FONT = "13px sans-serif";

/**
 * Render the graph + layout as a standalone SVG string. Deterministic:
 * nodes in sorted-id order, edges in id order (already sorted by
 * buildErGraph). Cardinality: "N" at the child end, "1" at the parent end.
 */
export function renderErSvg(graph: ErGraph, layout: LayoutResult, title: string): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">`,
  );
  parts.push(`<title>${esc(title)}</title>`);
  parts.push(
    `<style>text{font:${FONT};fill:var(--vsdb-fg,#ddd)} .box{fill:var(--vsdb-box,#252526);stroke:var(--vsdb-edge,#888)} .wire{stroke:var(--vsdb-edge,#888);stroke-width:1.5}</style>`,
  );

  // Edges first (under the boxes), id order from buildErGraph.
  for (const e of graph.edges) {
    const a = layout.nodes.get(e.source);
    const b = layout.nodes.get(e.target);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w / 2;
    const y2 = b.y + b.h / 2;
    parts.push(`<line class="wire" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    parts.push(`<text x="${mx - 14}" y="${my - 4}">N</text>`);
    parts.push(`<text x="${mx + 4}" y="${my - 4}">1</text>`);
    parts.push(`<text x="${mx - 20}" y="${my + 12}">${esc(e.id)}</text>`);
  }

  // Boxes, sorted-id order (layout insertion order is already sorted).
  for (const n of layout.nodes.values()) {
    parts.push(
      `<rect class="box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6"/>`,
    );
    const node = graph.nodes.find((g) => g.id === n.id);
    const label = node ? `${node.schema}.${node.table}` : n.id;
    parts.push(
      `<text x="${n.x + 10}" y="${n.y + 22}">${esc(label)}</text>`,
    );
    if (node && node.pkColumns.length > 0) {
      parts.push(
        `<text x="${n.x + 10}" y="${n.y + 42}">PK: ${esc(node.pkColumns.join(", "))}</text>`,
      );
    } else if (node) {
      parts.push(
        `<text x="${n.x + 10}" y="${n.y + 42}">${node.columnCount} cols</text>`,
      );
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
}
