# Cycle DBX-04 Plan — Relationship Explorer

Date: 2026-08-30 · Base: main @ dfad338 (v1.17.0) · Roadmap: PRODUCT_ROADMAP.md wave 2
Status: planned · Executor: unic-code · Reviewer: unic-smart (mandatory, handoff.reviewer.enabled)

## §1 Intent

Explore foreign-key relationships of the active PostgreSQL connection as a
pan/zoom ER diagram webview, and export a static SVG for documentation.

Non-goals (hard): no editable physical modeling, no SQL execution from the
panel, no cross-database graph, no MySQL/MSSQL support (graceful refusal),
no layout persistence.

## §2 Architecture

Pure modules (NO vscode import — scaffold hygiene guards apply):

- `src/core/er/fkGraph.ts` — FK introspection result → graph model.
  - `ErNode { id: "schema.table"; schema; table; columnCount; pkColumns }`
  - `ErEdge { id; source: node id; target: node id; constraintName;
    sourceColumns; targetColumns }` (edge direction: FK child → referenced
    parent)
  - `buildErGraph(details: Array<{ schema; table; detail }>): ErGraph`
    - nodes for every table, edges from `contype === "f"` constraints;
    conkey ordinals resolved via column names (same convention as
    schemaDiff.shapeFromTableDetail);
    self-references (table → itself) kept;
    edges to tables OUTSIDE the captured detail set are dropped (graph is
    closed-world over introspected tables) and counted in `droppedEdges`;
  - `ErGraph { nodes; edges; droppedEdges }`.
- `src/core/er/layout.ts` — deterministic layered layout (no deps):
  - `layoutErGraph(graph): LayoutResult` — longest-path layering by
    in-degree from FK edges (parents above children), per-layer
    column-major placement; cycles broken by DFS order;
  - cyclic graphs MUST terminate (visited-set guard); 0-node graph →
    empty result; deterministic: same input → byte-identical output;
  - `LayoutNode { id; x; y; w; h }`, `LayoutResult { nodes; width; height }`.
- `src/core/er/svgExport.ts` — static SVG renderer (pure string):
  - `renderErSvg(graph, layout, title): string` — boxes + labels + edges
    with plain lines + cardinality labels "1"/"N";
    XML-escapes ALL text; deterministic ordering (nodes by id, edges by
    id).

Host modules:

- `src/ui/erService.ts` — orchestrator (mirrors compareService):
  - `runErExplorer(adapter, schema): Promise<ErResult>` —
    driver gate BEFORE adapter calls (postgres only → otherwise
    `{ ok:false, reason:"unsupported-driver" }` with ZERO adapter calls);
    `adapter.listTables(schema)` (graceful failure → empty),
    `adapter.listTableDetail(schema, table)` per table with per-table
    catch → table omitted;
    layout via layoutErGraph; never throws;
  - `ErResult = { ok: true; graph; layout; truncated } | { ok:false; reason }`;
    node cap: top 200 tables by FK degree, deterministic tie-break by
    id, `truncated: true` when capped.
- `src/ui/erPanel.ts` — singleton webview panel host (mirrors
  ComparePanel): `ErPanel.get({ extensionUri })`; owns zoom state
  (clamped 0.25..4); message contract:
  - host→webview: `{ type:"er_model", graph, layout }`
    / `{ type:"er_error", message }`;
  - webview→host: `{ type:"er_ready" }` / `{ type:"er_export_request" }`
    / `{ type:"er_export_svg", svg, schema }` (host saves via workspace
    save dialog as `vsdb-er-<schema>.svg`) / unknown types ignored by a
    `isErPanelMessage` guard;
  - host posts model on `er_ready` (webview may load after first post).
- `src/ui/erPanelHtml.ts` — pure CSP shell (mirror of comparePanelHtml:
  no nonce, style-src cspSource 'unsafe-inline', script-src cspSource).
- `webview/erPanelMain.ts` — IIFE webview script; textContent-only DOM
  building (NO innerHTML / insertAdjacentHTML / eval / new Function —
  same convention as comparePanelMain); renders SVG via createElementNS;
  pan (pointer drag) + wheel zoom applied as viewBox transform;
  serializes its own SVG (XMLSerializer) for the export round-trip.

Wiring:

- `src/extension.ts` — `vsdb.relationshipExplorer` command:
  driver gate (same refusal UX as vsdb.compareTables) + schema QuickPick,
  then `runErExplorer` → `ErPanel.show(result, { schema })`.
- `package.json` — command `vsdb.relationshipExplorer`
  (category VSDB, icon `$(circuit-board)`), placed after vsdb.compareTables.
- `esbuild.js` — `erPanelConfig` entry (webview/erPanelMain.ts →
  dist/erPanel.js), ctx10 + matching build-list entry.

## §3 Tests (TDD, targeted file per task)

- `src/core/er/__tests__/fkGraph.test.ts` (~8): node/edge building,
  conkey ordinal resolution, self-reference kept, closed-world drop +
  droppedEdges count, empty detail list, multi-column FK, determinism.
- `src/core/er/__tests__/layout.test.ts` (~8): layering (parents above
  children), cycle termination (self-loop + 2-cycle), 0/1-node, column
  placement, deterministic byte output, no NaN coordinates.
- `src/core/er/__tests__/svgExport.test.ts` (~7): XML escaping of
  table/constraint names, cardinality labels, determinism, viewBox
  matches layout dims, no `<script>` in output, empty graph.
- `src/ui/__tests__/erService.test.ts` (~8): driver gate (mysql →
  unsupported-driver, ZERO adapter calls), adapter null, listTables
  failure → empty graph, per-table detail failure → table omitted,
  happy path wiring layout+graph, node cap + truncated flag.
- `src/ui/__tests__/erPanel.test.ts` (~6): singleton, CSP shell via
  erPanelHtml, message guard (unknown types ignored), zoom clamp,
  export round-trip wiring, dispose guard.
- `src/__tests__/dbx04Scaffold.test.ts` (~5): purity guards —
  `src/core/er/*.ts` + erPanelHtml.ts + erService.ts contain no
  `vscode` import; erPanelMain.ts contains no innerHTML /
  insertAdjacentHTML / eval / new Function; word-boundary regexes
  (DBX-03 lesson: comment text like "uses innerHTML" trips naive greps).
- `src/extension.test.ts` — extend the later-cycles registration list
  with `vsdb.relationshipExplorer` (T18 wiring contracts).

## §4 Task split

- TASK-DBX04-001: fkGraph.ts + tests (wave 1).
- TASK-DBX04-002: layout.ts + svgExport.ts + tests (wave 1, parallel
  with 001 — depends only on the ErGraph types, which 001 commits).
- TASK-DBX04-003: erService.ts + erPanel.ts + erPanelHtml.ts +
  webview/erPanelMain.ts + extension wiring + package.json + esbuild
  (wave 2).
- TASK-DBX04-004: dbx04Scaffold.test.ts + extension registration test +
  full regression (wave 3).

## §5 Risks

- SVG text escaping: mandatory — table/constraint names arrive from the
  database; `&<>"'` must never hit the export string unescaped. The
  interactive webview path uses createElementNS + textContent; svgExport's
  string path is file-export only.
- Deterministic layout with cycles: DFS visited-guard, tested with
  self-loop and 2-cycle fixtures.
- Large schemas: 200-node cap in the service (FK degree, tie-break by
  id) with `truncated` flag surfaced in the panel.

## Reviewer gate

Dbx04Reviewer (unic-smart — different model than the unic-code executor)
re-runs typecheck + targeted tests fresh and appends its verdict to
TASK-DBX04-003.md and TASK-DBX04-004.md. CHANGES-REQUESTED → fix rounds →
superseding APPROVED, same protocol as DBX-03.
