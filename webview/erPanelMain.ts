// webview/erPanelMain.ts
// TASK-DBX04-003 — Relationship Explorer webview. CSP-clean:
// textContent/createElementNS-only rendering (no raw-HTML injection
// APIs). Pan via pointer drag, zoom via wheel; host relays zoom clamps.
// SVG export posts the serialized diagram back to the host (which owns
// the save dialog).

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface ErNodeView { id: string; schema: string; table: string; columnCount: number; pkColumns: string[] }
interface ErEdgeView { id: string; source: string; target: string; sourceColumns: string[]; targetColumns: string[] }
interface GraphView { nodes: ErNodeView[]; edges: ErEdgeView[]; droppedEdges: number }
interface LayoutNodeView { id: string; x: number; y: number; w: number; h: number }
interface LayoutView { nodes: Map<string, LayoutNodeView>; width: number; height: number }
interface ModelMessage {
  type: "er_model";
  graph: GraphView;
  layout: { nodes: Array<[string, LayoutNodeView]> | Record<string, LayoutNodeView>; width: number; height: number };
  truncated: boolean;
  schema: string;
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("vsdb-root") as HTMLDivElement | null;

const SVG_NS = "http://www.w3.org/2000/svg";
let current: { graph: GraphView; layout: LayoutView; schema: string } | null = null;
let viewBox = { x: 0, y: 0, w: 0, h: 0 };

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function layoutNodes(raw: ModelMessage["layout"]): Map<string, LayoutNodeView> {
  const out = new Map<string, LayoutNodeView>();
  if (Array.isArray(raw.nodes)) {
    for (const [k, v] of raw.nodes) out.set(k, v);
  } else {
    for (const [k, v] of Object.entries(raw.nodes)) out.set(k, v);
  }
  return out;
}

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyViewBox(): void {
  const svg = document.getElementById("vsdb-er-svg") as SVGSVGElement | null;
  if (svg) svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
}

function render(msg: ModelMessage): void {
  if (!root) return;
  root.replaceChildren();

  const layout = layoutNodes(msg.layout);
  current = { graph: msg.graph, layout, schema: msg.schema };
  viewBox = { x: 0, y: 0, w: msg.layout.width, h: msg.layout.height };

  const bar = el("div", "vsdb-er-bar");
  bar.appendChild(el("span", "vsdb-er-title", `Relationships — ${msg.schema}`));
  if (msg.truncated) {
    bar.appendChild(
      el("span", "vsdb-er-warning", `Showing the first ${msg.graph.nodes.length} tables (capped).`),
    );
  }
  const exportBtn = el("button", "vsdb-er-export", "Export SVG");
  exportBtn.addEventListener("click", () => {
    const svg = document.getElementById("vsdb-er-svg") as SVGSVGElement | null;
    if (!svg) return;
    const serialized = new XMLSerializer().serializeToString(svg);
    vscode.postMessage({ type: "er_export_svg", svg: serialized, schema: msg.schema });
  });
  bar.appendChild(exportBtn);
  root.appendChild(bar);

  if (msg.graph.droppedEdges > 0) {
    root.appendChild(
      el("div", "vsdb-er-note", `${msg.graph.droppedEdges} FK edge(s) point outside this schema and are not drawn.`),
    );
  }

  const svg = svgEl("svg", { id: "vsdb-er-svg", width: "100%", height: "100%" });
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.appendChild(svgEl("style", {}, "text{font:12px sans-serif;fill:var(--vscode-editor-foreground,#ddd)} .vsdb-er-box{fill:var(--vscode-editorWidget-background,#252526);stroke:var(--vscode-panelBorder,#888)} .vsdb-er-wire{stroke:var(--vscode-panelBorder,#888);stroke-width:1.5}"));

  // Edges under boxes.
  for (const e of msg.graph.edges) {
    const a = layout.get(e.source);
    const b = layout.get(e.target);
    if (!a || !b) continue;
    svg.appendChild(
      svgEl("line", {
        class: "vsdb-er-wire",
        x1: a.x + a.w / 2, y1: a.y + a.h / 2,
        x2: b.x + b.w / 2, y2: b.y + b.h / 2,
      }),
    );
  }
  // Boxes.
  for (const n of msg.graph.nodes) {
    const p = layout.get(n.id);
    if (!p) continue;
    svg.appendChild(svgEl("rect", { class: "vsdb-er-box", x: p.x, y: p.y, width: p.w, height: p.h, rx: 6 }));
    svg.appendChild(svgEl("text", { x: p.x + 10, y: p.y + 22 }, `${n.schema}.${n.table}`));
    svg.appendChild(
      svgEl("text", { x: p.x + 10, y: p.y + 42 }, n.pkColumns.length > 0 ? `PK: ${n.pkColumns.join(", ")}` : `${n.columnCount} cols`),
    );
  }
  root.appendChild(svg);

  // Pan: pointer drag moves the viewBox.
  let dragging: { px: number; py: number } | null = null;
  svg.addEventListener("pointerdown", (ev) => {
    dragging = { px: ev.clientX, py: ev.clientY };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const sx = viewBox.w / Math.max(rect.width, 1);
    const sy = viewBox.h / Math.max(rect.height, 1);
    viewBox.x -= (ev.clientX - dragging.px) * sx;
    viewBox.y -= (ev.clientY - dragging.py) * sy;
    dragging = { px: ev.clientX, py: ev.clientY };
    applyViewBox();
  });
  svg.addEventListener("pointerup", () => {
    dragging = null;
  });

  // Zoom: wheel scales the viewBox about its center. The webview applies
  // the same 0.25..4 clamp locally (base = the model's natural viewBox)
  // so rapid scrolling can never exceed the range; the host re-acknowledges
  // via er_zoom_set (its zoom accumulator), which we also honor.
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (!current) return;
    const base = { w: current.layout.width, h: current.layout.height };
    const proposed = Math.min(4, Math.max(0.25, (viewBox.w / base.w) * (ev.deltaY < 0 ? 1 / 1.1 : 1.1)));
    const delta = proposed / (viewBox.w / base.w);
    const w0 = viewBox.w;
    const h0 = viewBox.h;
    viewBox.w *= delta;
    viewBox.h *= delta;
    viewBox.x += (w0 - viewBox.w) / 2;
    viewBox.y += (h0 - viewBox.h) / 2;
    applyViewBox();
    vscode.postMessage({ type: "er_zoom", delta });
  }, { passive: false });
}

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as ModelMessage | { type: "er_zoom_set"; zoom: number } | { type?: unknown };
  if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "er_model") {
    render(msg as ModelMessage);
    return;
  }
  // Host zoom acknowledgment: reconcile the accumulator so the next
  // wheel step resumes from the clamped base.
  if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "er_zoom_set") {
    const z = (msg as { zoom: number }).zoom;
    if (current && Number.isFinite(z) && z > 0) {
      const targetW = current.layout.width / z;
      const targetH = current.layout.height / z;
      viewBox.x += (viewBox.w - targetW) / 2;
      viewBox.y += (viewBox.h - targetH) / 2;
      viewBox.w = targetW;
      viewBox.h = targetH;
      applyViewBox();
    }
  }
});

// Ready ping: the host (re)posts the model when the webview loads.
vscode.postMessage({ type: "er_ready" });
