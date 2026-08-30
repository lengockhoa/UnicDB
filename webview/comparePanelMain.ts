// webview/comparePanelMain.ts
// TASK-DBX03-004 — compare panel webview. CSP-clean: textContent-only
// rendering only (no raw-HTML injection APIs). Receives one
// `vsdb-compare` message; Copy SQL posts back to the host.

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface CellDiffView { column: string; from: unknown; to: unknown }
interface EntryView { kind: string; column?: string; change?: string; from?: unknown; to?: unknown; position?: number }
interface PlanStatement { sql: string; summary: string; dangerous?: boolean }
interface PlanGroup { id: string; statements: PlanStatement[] }
interface ResultView {
  ok: boolean;
  error?: string;
  truncated?: boolean;
  shapeDiff?: { identical: boolean; compatible: boolean; entries: EntryView[] };
  dataDiff?: {
    addedRows?: Array<{ key: unknown[] }>;
    removedRows?: Array<{ key: unknown[] }>;
    changedRows?: Array<{ key: unknown[]; cellDiffs: CellDiffView[] }>;
    duplicateKeyCount?: number;
    skipped?: string;
  };
  plan?: { executable: boolean; reasons: string[]; groups: PlanGroup[]; totals: { ddl: number; data: number } };
}

declare global {
  interface Window { compareData?: { result: ResultView } }
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("vsdb-root") as HTMLDivElement | null;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only — CSP
  return node;
}

function render(result: ResultView): void {
  if (!root) return;
  root.textContent = "";
  root.appendChild(el("h2", "vsdb-compare-title", "Schema & Data Compare (preview only)"));

  if (!result.ok) {
    root.appendChild(el("p", "vsdb-compare-error", result.error ?? "Compare failed."));
    return;
  }

  if (result.truncated) {
    root.appendChild(
      el("p", "vsdb-compare-warn", `Row fetch exceeded the compare limit — only the first ${10000} rows per side were diffed.`),
    );
  }

  // Section: schema diff
  const schema = result.shapeDiff;
  const schemaBox = el("section", "vsdb-compare-section");
  schemaBox.appendChild(el("h3", "", `Schema (${schema && schema.identical ? "identical" : "differs"})`));
  if (schema) {
    for (const entry of schema.entries) {
      schemaBox.appendChild(el("div", "vsdb-compare-row", describeEntry(entry)));
    }
    if (schema.entries.length === 0) schemaBox.appendChild(el("div", "", "No schema differences."));
    if (!schema.compatible) {
      schemaBox.appendChild(el("p", "vsdb-compare-warn", "Shapes are incompatible — data sync is disabled."));
    }
  }
  root.appendChild(schemaBox);

  // Section: data diff
  const data = result.dataDiff;
  const dataBox = el("section", "vsdb-compare-section");
  if (data && data.skipped) {
    dataBox.appendChild(el("h3", "", "Data (skipped)"));
    dataBox.appendChild(el("p", "", "No primary key — safe row-level diff is not possible."));
  } else if (data) {
    const added = data.addedRows?.length ?? 0;
    const removed = data.removedRows?.length ?? 0;
    const changed = data.changedRows?.length ?? 0;
    dataBox.appendChild(el("h3", "", `Data (${added} to insert, ${changed} to update, ${removed} to delete)`));
    for (const change of data.changedRows ?? []) {
      for (const cell of change.cellDiffs) {
        dataBox.appendChild(el("div", "vsdb-compare-row", `Row ${JSON.stringify(change.key)} · ${cell.column}: ${fmt(cell.from)} → ${fmt(cell.to)}`));
      }
    }
    if (added + removed + changed === 0) dataBox.appendChild(el("div", "", "No data differences."));
  }
  root.appendChild(dataBox);

  // Section: sync plan
  const plan = result.plan;
  const planBox = el("section", "vsdb-compare-section");
  if (plan) {
    planBox.appendChild(
      el("h3", "", plan.executable ? `Sync plan (${plan.totals.ddl} DDL, ${plan.totals.data} data statements)` : "Sync plan (not executable)"),
    );
    for (const reason of plan.reasons) planBox.appendChild(el("p", "vsdb-compare-warn", reason));
    for (const group of plan.groups) {
      for (const stmt of group.statements) {
        const line = el("div", stmt.dangerous ? "vsdb-compare-row vsdb-compare-dangerous" : "vsdb-compare-row", "");
        line.appendChild(el("code", "", stmt.sql));
        line.appendChild(el("span", "vsdb-compare-summary", ` — ${stmt.summary}${stmt.dangerous ? " (dangerous)" : ""}`));
        planBox.appendChild(line);
      }
    }
    const copy = el("button", "vsdb-compare-copy", "Copy sync SQL");
    copy.addEventListener("click", () => {
      const sql = plan.groups.map((g) => g.statements.map((s) => s.sql).join("\n")).join("\n");
      vscode.postMessage({ type: "copySql", sql });
    });
    planBox.appendChild(copy);
  }
  root.appendChild(planBox);
}

function describeEntry(entry: EntryView): string {
  if (entry.kind === "added") return `Column "${entry.column}" added (position ${entry.position})`;
  if (entry.kind === "dropped") return `Column "${entry.column}" exists only in target`;
  if (entry.kind === "pk-changed") return `Primary key changed: ${JSON.stringify(entry.from)} → ${JSON.stringify(entry.to)}`;
  return `Column "${entry.column}" ${entry.change}: ${fmt(entry.from)} → ${fmt(entry.to)}`;
}

function fmt(v: unknown): string {
  return v === null || v === undefined ? "(null)" : String(v);
}

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as { type?: string; result?: ResultView };
  if (msg?.type === "vsdb-compare" && msg.result) {
    window.compareData = { result: msg.result };
    render(msg.result);
  }
});

// Render from retained state (panel restore).
if (window.compareData) render(window.compareData.result);
