// webview/main.ts
// Webview entry — nhận state từ extension host, render tabs + grid + Messages.
//
// Message protocol: see src/ui/messages.ts (mirror of types).
import { VirtualGrid, formatCell } from "./grid";
import type { GridColumn } from "./grid";

// ---- Types (mirror of src/ui/messages.ts) ----------------------------------

interface StateMsg {
  type: "state";
  header: string;
  results: StatementResult[];
  busy: boolean;
}

interface BusyMsg {
  type: "busy";
  busy: boolean;
}

type HostMsg = StateMsg | BusyMsg;

interface StatementResult {
  index: number;
  sql: string;
  status: "running" | "done" | "error" | "cancelled";
  result?: {
    columns: string[];
    rows: any[][];
    rowCount: number | null;
    commandTag?: string;
    durationMs: number;
  };
  batched?: boolean;
  error?: string;
  durationMs: number;
}

type LoadMoreMsg = { type: "loadMore"; index: number };
type CancelMsg = { type: "cancel" };
type CopyMsg = { type: "copy"; text: string };
type ReadyMsg = { type: "ready" };
type WebviewMsg = LoadMoreMsg | CancelMsg | CopyMsg | ReadyMsg;

// ---- Acquire VS Code API ---------------------------------------------------

declare const acquireVsCodeApi: undefined | (() => any);
const vscodeApi = (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);

function postToHost(msg: WebviewMsg): void {
  if (vscodeApi) {
    vscodeApi.postMessage(msg);
  } else {
    // Dev fallback (outside VS Code): log to console.
    // eslint-disable-next-line no-console
    console.log("[vsdb webview → host]", msg);
  }
}

// ---- App state -------------------------------------------------------------

const root = document.getElementById("vsdb-root") as HTMLDivElement;
let headerText = "";
let results: StatementResult[] = [];
let busy = false;
let activeTab = 0;
let grid: VirtualGrid | null = null;
let currentColumns: GridColumn[] = [];

// ---- Render ----------------------------------------------------------------

function render(): void {
  root.innerHTML = "";

  // Header.
  const headerEl = document.createElement("div");
  headerEl.className = "vsdb-header";
  headerEl.textContent = headerText || "VSDB Results";
  root.appendChild(headerEl);

  // Toolbar.
  const toolbar = document.createElement("div");
  toolbar.className = "vsdb-toolbar";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "vsdb-btn vsdb-btn-danger";
  cancelBtn.disabled = !busy;
  cancelBtn.addEventListener("click", () => postToHost({ type: "cancel" }));
  toolbar.appendChild(cancelBtn);
  root.appendChild(toolbar);

  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vsdb-empty";
    empty.textContent = busy ? "Running…" : "No results yet.";
    root.appendChild(empty);
    return;
  }

  // Tabs.
  const tabsEl = document.createElement("div");
  tabsEl.className = "vsdb-tabs";
  results.forEach((r, i) => {
    const tab = document.createElement("button");
    tab.className = "vsdb-tab" + (i === activeTab ? " vsdb-tab-active" : "");
    if (r.status === "error") tab.classList.add("vsdb-tab-error");
    if (r.status === "cancelled") tab.classList.add("vsdb-tab-cancelled");
    tab.textContent = `Statement ${i + 1} ${tabBadge(r)}`;
    tab.addEventListener("click", () => {
      activeTab = i;
      render();
    });
    tabsEl.appendChild(tab);
  });
  // Messages tab.
  const msgTab = document.createElement("button");
  msgTab.className = "vsdb-tab vsdb-tab-messages" + (activeTab === results.length ? " vsdb-tab-active" : "");
  const hasErrors = results.some((r) => r.status === "error");
  msgTab.textContent = `Messages${hasErrors ? " ⚠" : ""}`;
  msgTab.addEventListener("click", () => {
    activeTab = results.length;
    render();
  });
  tabsEl.appendChild(msgTab);
  root.appendChild(tabsEl);

  // Active panel.
  if (activeTab === results.length) {
    renderMessages();
  } else {
    renderGrid();
  }
}

function tabBadge(r: StatementResult): string {
  if (r.status === "done") return "✓";
  if (r.status === "error") return "✗";
  if (r.status === "cancelled") return "⌀";
  return "…";
}

function renderGrid(): void {
  const r = results[activeTab];
  if (!r) return;
  const container = document.createElement("div");
  container.className = "vsdb-grid-host";
  root.appendChild(container);

  if (r.status === "error") {
    const err = document.createElement("div");
    err.className = "vsdb-error";
    err.textContent = `Error: ${r.error ?? "unknown"}`;
    container.appendChild(err);
    return;
  }

  if (!r.result) {
    const empty = document.createElement("div");
    empty.className = "vsdb-empty";
    empty.textContent = "No result.";
    container.appendChild(empty);
    return;
  }

  // Footer.
  const footer = document.createElement("div");
  footer.className = "vsdb-grid-footer";

  const cols: GridColumn[] = r.result.columns.map((c) => {
    // Lightweight type inference: first non-null row.
    let sample: any = undefined;
    for (const row of r.result!.rows) {
      if (row !== null && row !== undefined) {
        sample = row[r.result!.columns.indexOf(c)];
        if (sample !== null && sample !== undefined) break;
      }
    }
    const type: GridColumn["type"] =
      typeof sample === "number" || typeof sample === "bigint"
        ? "number"
        : sample instanceof Date
          ? "date"
          : typeof sample === "boolean"
            ? "boolean"
            : "string";
    return { name: c, type };
  });

  const gridHost = document.createElement("div");
  container.appendChild(gridHost);

  const loaded = r.result.rows.length;
  const total = r.batched ? null : r.result.rowCount ?? loaded;
  const hasMore = !!r.batched && loaded < (r.result.rowCount ?? Number.MAX_SAFE_INTEGER);

  grid = new VirtualGrid(gridHost, cols, {
    onLoadMore: () => {
      if (!busy) postToHost({ type: "loadMore", index: activeTab });
    },
    onCopy: (text) => postToHost({ type: "copy", text }),
  });

  grid.setColumns(cols);
  grid.setData(r.result.rows, total, hasMore);
  currentColumns = cols;

  // Footer text.
  if (r.batched) {
    footer.textContent = `${loaded} rows — scroll down to load more  ⏱ ${r.durationMs}ms`;
  } else {
    footer.textContent = `${loaded} rows${r.result.commandTag ? ` — ${r.result.commandTag}` : ""}  ⏱ ${r.durationMs}ms`;
  }
  container.appendChild(footer);
}

function renderMessages(): void {
  const wrap = document.createElement("div");
  wrap.className = "vsdb-messages";
  results.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "vsdb-msg-card";
    if (r.status === "error") card.classList.add("vsdb-msg-error");
    if (r.status === "cancelled") card.classList.add("vsdb-msg-cancelled");

    const title = document.createElement("div");
    title.className = "vsdb-msg-title";
    title.textContent = `Statement ${i + 1} — ${r.status.toUpperCase()}`;
    card.appendChild(title);

    const sql = document.createElement("pre");
    sql.className = "vsdb-msg-sql";
    sql.textContent = r.sql;
    card.appendChild(sql);

    const meta = document.createElement("div");
    meta.className = "vsdb-msg-meta";
    meta.textContent = `Duration: ${r.durationMs}ms`;
    if (r.result?.commandTag) meta.textContent += ` — ${r.result.commandTag}`;
    if (r.result?.rowCount !== undefined && r.result?.rowCount !== null) {
      meta.textContent += ` — ${r.result.rowCount} row(s)`;
    }
    card.appendChild(meta);

    if (r.error) {
      const err = document.createElement("div");
      err.className = "vsdb-msg-error-text";
      err.textContent = r.error;
      card.appendChild(err);
    }
    wrap.appendChild(card);
  });
  root.appendChild(wrap);
}

// ---- Message handling ------------------------------------------------------

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostMsg;
  if (msg.type === "state") {
    headerText = msg.header;
    results = msg.results || [];
    busy = msg.busy;
    if (activeTab >= results.length) activeTab = Math.max(0, results.length - 1);
    render();
  } else if (msg.type === "busy") {
    busy = msg.busy;
    render();
  }
});

// Tell host we're ready.
postToHost({ type: "ready" });

// Initial render.
render();

// Expose for debugging.
(window as any).__vsdb = { render, postToHost, formatCell };
