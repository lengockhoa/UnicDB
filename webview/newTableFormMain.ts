// webview/newTableFormMain.ts
// Webview entry cho NewTableForm — DataGrip-style table designer dialog.
// Vanilla DOM (no framework). Protocol mirror src/ui/newTableFormMessages.ts.
//
// State model:
//   - in-memory `spec: TableSpec` (host owns lastPreviewSql + persistence).
//   - `syncIdColumn(spec, prevName): {spec, tracking}` runs every render to
//     keep the id_<table> first-column auto-name in sync while user only edits
//     the table-name input. A manual rename away from the auto value stops
//     tracking forever (per task spec).
declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

interface KeySpec {
  kind: "primaryKey" | "unique" | "check" | "foreignKey";
  columns?: string[];
  name?: string;
  expr?: string;
  references?: { table: string; columns: string[] };
}
interface ColumnSpec {
  name: string;
  type: string;
  default?: string;
  nullable?: boolean;
  comment?: string;
  originalName?: string;
  isPrimaryKey?: boolean;
}
interface TableSpec {
  name: string;
  schema: string;
  columns: ColumnSpec[];
  keys: KeySpec[];
  ifNotExists?: boolean;
}

interface InitMsg {
  type: "init";
  mode: "create" | "modify";
  schema: string;
  originalTableName?: string;
  spec: TableSpec;
  loadError?: string;
}
interface PreviewMsg {
  type: "preview";
  sql: string;
  errors: string[];
}

const root = document.getElementById("vsdb-root") as HTMLDivElement;
let spec: TableSpec = { name: "table_name", schema: "public", columns: [], keys: [] };
let mode: "create" | "modify" = "create";
let selectedColumn: number | null = null;
let selectedKey: number | null = null;
/** syncIdColumn: id_<prevName> tracking. null = tracking broken forever. */
let idColumnTracking: { autoName: string } | null = null;
let lastPreviewSql = "";
let lastErrors: string[] = [];

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

function emitSpecChanged(tableChanged = false): void {
  post({ type: "specChanged", spec, tableChanged });
}

/**
 * Keep first column name in sync with table name while user only edits the
 * table-name input. Returns {spec, tracking} so the caller can persist the
 * tracking state for next render.
 *
 *  - If no tracking: scan columns, if first column.name === `id_<prevName>`
 *    AND table.name !== prevName → start tracking + rename first column.
 *  - If tracking: if first column.name !== tracking.autoName → user has
 *    manually renamed → drop tracking forever (null). Else continue renaming.
 */
function syncIdColumn(
  currentSpec: TableSpec,
  prevTableName: string,
  tracking: { autoName: string } | null,
): { spec: TableSpec; tracking: { autoName: string } | null } {
  const newTableName = currentSpec.name;
  const expectedAutoForNew = `id_${newTableName}`;
  if (tracking === null) {
    // No active tracking → see if first column matches the previous auto.
    const first = currentSpec.columns[0];
    if (
      first &&
      prevTableName !== newTableName &&
      first.name === `id_${prevTableName}`
    ) {
      const next: TableSpec = {
        ...currentSpec,
        columns: [{ ...first, name: expectedAutoForNew }, ...currentSpec.columns.slice(1)],
      };
      return { spec: next, tracking: { autoName: expectedAutoForNew } };
    }
    return { spec: currentSpec, tracking: null };
  }
  // Active tracking: if first column name still equals the previously expected
  // auto, rename to current table. If user has touched it, drop tracking.
  const first = currentSpec.columns[0];
  if (!first) return { spec: currentSpec, tracking: null };
  if (first.name !== tracking.autoName) {
    // User renamed manually — tracking is broken forever.
    return { spec: currentSpec, tracking: null };
  }
  if (tracking.autoName === expectedAutoForNew) {
    return { spec: currentSpec, tracking };
  }
  const next: TableSpec = {
    ...currentSpec,
    columns: [{ ...first, name: expectedAutoForNew }, ...currentSpec.columns.slice(1)],
  };
  return { spec: next, tracking: { autoName: expectedAutoForNew } };
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}
function div(id: string): HTMLDivElement {
  return document.getElementById(id) as HTMLDivElement;
}

function render(): void {
  root.innerHTML = `
  <h2 id="formTitle">${mode === "modify" ? `Modify — ${spec.schema}.${spec.originalName ?? spec.name}` : "New Table"}</h2>
  ${spec && (spec as unknown as { loadError?: string }).loadError ? `<div class="vsdb-designer-load-error">Load failed: ${escapeHtml(((spec as unknown as { loadError?: string }).loadError) ?? "")}</div>` : ""}
  <div class="vsdb-designer">
    <div class="vsdb-designer-header">
      <label for="tableName">Table name</label>
      <input id="tableName" type="text" />
      <label>Schema</label>
      <span id="schemaLabel" class="vsdb-designer-item-meta"></span>
    </div>
    <div class="vsdb-designer-sections">
      <div class="vsdb-designer-section">
        <div class="vsdb-designer-section-title">COLUMNS (${spec.columns.length})</div>
        <ul id="columnsList"></ul>
        <div class="vsdb-designer-toolbar">
          <button id="addColBtn" title="Add column">+</button>
          <button id="removeColBtn" title="Remove">−</button>
          <button id="upColBtn" title="Up">↑</button>
          <button id="downColBtn" title="Down">↓</button>
        </div>
      </div>
      <div class="vsdb-designer-section">
        <div class="vsdb-designer-section-title">KEYS (${spec.keys.length})</div>
        <ul id="keysList"></ul>
        <div class="vsdb-designer-toolbar">
          <button id="addKeyBtn" title="Add key">+</button>
          <button id="removeKeyBtn" title="Remove">−</button>
          <button id="upKeyBtn" title="Up">↑</button>
          <button id="downKeyBtn" title="Down">↓</button>
        </div>
      </div>
    </div>
    <div class="vsdb-designer-edit" id="editPane">
      <div class="vsdb-designer-placeholder">Select a column or key from the left panel to edit.</div>
    </div>
    <pre id="sql-preview">${escapeHtml(lastPreviewSql || "—")}</pre>
    <div class="vsdb-designer-errors" id="sql-errors">
      ${lastErrors.length > 0 ? `<ul>${lastErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="vsdb-designer-actions">
      <button id="cancelBtn">Cancel</button>
      <button id="okBtn" class="vsdb-form-primary">OK — Execute</button>
    </div>
  </div>`;

  input("tableName").value = spec.name;
  div("schemaLabel").textContent = spec.schema;
  renderColumnsList();
  renderKeysList();
  renderEditPane();
  refreshOkButton();

  input("tableName").addEventListener("input", () => {
    const prevName = spec.name;
    spec = { ...spec, name: input("tableName").value.trim() || spec.name };
    const synced = syncIdColumn(spec, prevName, idColumnTracking);
    spec = synced.spec;
    idColumnTracking = synced.tracking;
    renderColumnsList();
    emitSpecChanged(true);
  });
  document.getElementById("addColBtn")?.addEventListener("click", () => {
    spec = {
      ...spec,
      columns: [...spec.columns, { name: `col_${spec.columns.length + 1}`, type: "varchar" }],
    };
    selectedColumn = spec.columns.length - 1;
    renderColumnsList();
    renderEditPane();
    emitSpecChanged();
  });
  document.getElementById("removeColBtn")?.addEventListener("click", () => {
    if (selectedColumn === null) return;
    const next = spec.columns.filter((_, i) => i !== selectedColumn);
    spec = { ...spec, columns: next };
    selectedColumn = null;
    renderColumnsList();
    renderEditPane();
    emitSpecChanged();
  });
  document.getElementById("upColBtn")?.addEventListener("click", () => {
    if (selectedColumn === null || selectedColumn <= 0) return;
    const cols = spec.columns.slice();
    [cols[selectedColumn - 1], cols[selectedColumn]] = [cols[selectedColumn], cols[selectedColumn - 1]];
    spec = { ...spec, columns: cols };
    selectedColumn = selectedColumn - 1;
    renderColumnsList();
    emitSpecChanged();
  });
  document.getElementById("downColBtn")?.addEventListener("click", () => {
    if (selectedColumn === null || selectedColumn >= spec.columns.length - 1) return;
    const cols = spec.columns.slice();
    [cols[selectedColumn + 1], cols[selectedColumn]] = [cols[selectedColumn], cols[selectedColumn + 1]];
    spec = { ...spec, columns: cols };
    selectedColumn = selectedColumn + 1;
    renderColumnsList();
    emitSpecChanged();
  });
  document.getElementById("addKeyBtn")?.addEventListener("click", () => {
    spec = {
      ...spec,
      keys: [...spec.keys, { kind: "unique", columns: spec.columns.length > 0 ? [spec.columns[0].name] : [] }],
    };
    selectedKey = spec.keys.length - 1;
    renderKeysList();
    renderEditPane();
    emitSpecChanged();
  });
  document.getElementById("removeKeyBtn")?.addEventListener("click", () => {
    if (selectedKey === null) return;
    const next = spec.keys.filter((_, i) => i !== selectedKey);
    spec = { ...spec, keys: next };
    selectedKey = null;
    renderKeysList();
    renderEditPane();
    emitSpecChanged();
  });
  document.getElementById("upKeyBtn")?.addEventListener("click", () => {
    if (selectedKey === null || selectedKey <= 0) return;
    const keys = spec.keys.slice();
    [keys[selectedKey - 1], keys[selectedKey]] = [keys[selectedKey], keys[selectedKey - 1]];
    spec = { ...spec, keys };
    selectedKey = selectedKey - 1;
    renderKeysList();
    emitSpecChanged();
  });
  document.getElementById("downKeyBtn")?.addEventListener("click", () => {
    if (selectedKey === null || selectedKey >= spec.keys.length - 1) return;
    const keys = spec.keys.slice();
    [keys[selectedKey + 1], keys[selectedKey]] = [keys[selectedKey], keys[selectedKey + 1]];
    spec = { ...spec, keys };
    selectedKey = selectedKey + 1;
    renderKeysList();
    emitSpecChanged();
  });
  document.getElementById("cancelBtn")?.addEventListener("click", () => {
    post({ type: "cancel" });
  });
  document.getElementById("okBtn")?.addEventListener("click", () => {
    post({ type: "submit", spec });
  });
}

function renderColumnsList(): void {
  const ul = document.getElementById("columnsList") as HTMLUListElement;
  const title = document.querySelector(".vsdb-designer-section-title");
  if (title) title.textContent = `COLUMNS (${spec.columns.length})`;
  ul.innerHTML = spec.columns
    .map(
      (c, i) =>
        `<li data-section="columns" data-index="${i}" class="${selectedColumn === i ? "selected" : ""}">` +
        `<span class="vsdb-designer-item-name">${escapeHtml(c.name)}</span>` +
        `<span class="vsdb-designer-item-meta">${escapeHtml(c.type)}</span>` +
        `</li>`,
    )
    .join("");
  ul.querySelectorAll("li[data-section='columns']").forEach((li) => {
    li.addEventListener("click", () => {
      const idx = Number((li as HTMLElement).dataset.index);
      selectedColumn = idx;
      selectedKey = null;
      renderColumnsList();
      renderKeysList();
      renderEditPane();
    });
  });
}

function renderKeysList(): void {
  const ul = document.getElementById("keysList") as HTMLUListElement;
  const titles = document.querySelectorAll(".vsdb-designer-section-title");
  if (titles[1]) titles[1].textContent = `KEYS (${spec.keys.length})`;
  ul.innerHTML = spec.keys
    .map((k, i) => {
      const label =
        k.kind === "primaryKey"
          ? `PRIMARY KEY (${(k.columns ?? []).join(", ")})`
          : k.kind === "unique"
            ? `UNIQUE (${(k.columns ?? []).join(", ")})`
            : k.kind === "check"
              ? `CHECK (${k.expr ?? ""})`
              : `FK (${(k.columns ?? []).join(", ")}) → ${k.references?.table ?? "?"}`;
      return (
        `<li data-section="keys" data-index="${i}" class="${selectedKey === i ? "selected" : ""}">` +
        `<span class="vsdb-designer-item-name">${escapeHtml(k.name ?? label)}</span>` +
        `<span class="vsdb-designer-item-meta">${escapeHtml(k.kind)}</span>` +
        `</li>`
      );
    })
    .join("");
  ul.querySelectorAll("li[data-section='keys']").forEach((li) => {
    li.addEventListener("click", () => {
      const idx = Number((li as HTMLElement).dataset.index);
      selectedKey = idx;
      selectedColumn = null;
      renderColumnsList();
      renderKeysList();
      renderEditPane();
    });
  });
}

function renderEditPane(): void {
  const pane = div("editPane");
  if (selectedColumn !== null) {
    const c = spec.columns[selectedColumn];
    pane.innerHTML = `
      <h3>Column</h3>
      <div class="vsdb-field"><label>Name</label><input id="colName" type="text" value="${escapeHtml(c.name)}" /></div>
      <div class="vsdb-field"><label>Type</label><input id="colType" type="text" value="${escapeHtml(c.type)}" /></div>
      <div class="vsdb-field"><label>Default</label><input id="colDefault" type="text" value="${escapeHtml(c.default ?? "")}" /></div>
      <div class="vsdb-field"><label><input id="colNullable" type="checkbox" ${c.nullable === false ? "" : "checked"} /> Nullable</label></div>
      <div class="vsdb-field"><label><input id="colPrimaryKey" type="checkbox" ${c.isPrimaryKey ? "checked" : ""} /> Primary Key</label></div>
    `;
    wireColumnEdit(c);
    return;
  }
  if (selectedKey !== null) {
    const k = spec.keys[selectedKey];
    pane.innerHTML = `
      <h3>Key</h3>
      <div class="vsdb-field"><label>Kind</label>
        <select id="keyKind">
          <option value="primaryKey" ${k.kind === "primaryKey" ? "selected" : ""}>PRIMARY KEY</option>
          <option value="unique" ${k.kind === "unique" ? "selected" : ""}>UNIQUE</option>
          <option value="foreignKey" ${k.kind === "foreignKey" ? "selected" : ""}>FOREIGN KEY</option>
          <option value="check" ${k.kind === "check" ? "selected" : ""}>CHECK</option>
        </select>
      </div>
      <div class="vsdb-field"><label>Name</label><input id="keyName" type="text" value="${escapeHtml(k.name ?? "")}" /></div>
      <div class="vsdb-field"><label>Columns (comma separated)</label><input id="keyColumns" type="text" value="${escapeHtml((k.columns ?? []).join(", "))}" /></div>
      <div class="vsdb-field" id="fkRefs" style="${k.kind === "foreignKey" ? "" : "display:none"}">
        <label>References table</label><input id="fkTable" type="text" value="${escapeHtml(k.references?.table ?? "")}" />
        <label>References columns</label><input id="fkColumns" type="text" value="${escapeHtml((k.references?.columns ?? []).join(", "))}" />
      </div>
      <div class="vsdb-field" id="checkExpr" style="${k.kind === "check" ? "" : "display:none"}">
        <label>CHECK expression</label><input id="keyExpr" type="text" value="${escapeHtml(k.expr ?? "")}" />
      </div>
    `;
    wireKeyEdit(k);
    return;
  }
  pane.innerHTML = `<div class="vsdb-designer-placeholder">Select a column or key from the left panel to edit.</div>`;
}

function wireColumnEdit(c: ColumnSpec): void {
  const nameEl = input("colName");
  const typeEl = input("colType");
  const defaultEl = input("colDefault");
  const nullableEl = input("colNullable") as HTMLInputElement;
  const pkEl = input("colPrimaryKey") as HTMLInputElement;
  function commit(): void {
    if (selectedColumn === null) return;
    const cols = spec.columns.slice();
    cols[selectedColumn] = {
      name: nameEl.value.trim(),
      type: typeEl.value.trim(),
      default: defaultEl.value,
      nullable: nullableEl.checked,
      isPrimaryKey: pkEl.checked,
    };
    spec = { ...spec, columns: cols };
    renderColumnsList();
    emitSpecChanged();
  }
  nameEl.addEventListener("input", commit);
  typeEl.addEventListener("input", commit);
  defaultEl.addEventListener("input", commit);
  nullableEl.addEventListener("change", commit);
  pkEl.addEventListener("change", commit);
}

function wireKeyEdit(k: KeySpec): void {
  const kindEl = select("keyKind");
  const nameEl = input("keyName");
  const colsEl = input("keyColumns");
  const fkRefs = document.getElementById("fkRefs") as HTMLDivElement;
  const fkTable = input("fkTable");
  const fkCols = input("fkColumns");
  const checkExpr = document.getElementById("checkExpr") as HTMLDivElement;
  const exprEl = input("keyExpr");
  function commit(): void {
    if (selectedKey === null) return;
    const next: KeySpec = {
      kind: kindEl.value as KeySpec["kind"],
      name: nameEl.value.trim() || undefined,
      columns: colsEl.value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    if (next.kind === "check") next.expr = exprEl.value;
    if (next.kind === "foreignKey") {
      next.references = {
        table: fkTable.value.trim(),
        columns: fkCols.value.split(",").map((s) => s.trim()).filter(Boolean),
      };
    }
    const keys = spec.keys.slice();
    keys[selectedKey] = next;
    spec = { ...spec, keys };
    renderKeysList();
    emitSpecChanged();
  }
  kindEl.addEventListener("change", () => {
    fkRefs.style.display = kindEl.value === "foreignKey" ? "" : "none";
    checkExpr.style.display = kindEl.value === "check" ? "" : "none";
    commit();
  });
  nameEl.addEventListener("input", commit);
  colsEl.addEventListener("input", commit);
  fkTable.addEventListener("input", commit);
  fkCols.addEventListener("input", commit);
  exprEl.addEventListener("input", commit);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function refreshOkButton(): void {
  const ok = document.getElementById("okBtn") as HTMLButtonElement | null;
  if (!ok) return;
  const errored = lastErrors.length > 0;
  const noSql = lastPreviewSql === "";
  ok.disabled = errored || noSql;
}

function applyInit(msg: InitMsg): void {
  mode = msg.mode;
  spec = msg.spec;
  if (mode === "create") {
    // start tracking if first column matches default id_<tableName>
    const first = spec.columns[0];
    idColumnTracking = first && first.name === `id_${spec.name}` ? { autoName: first.name } : null;
  } else {
    idColumnTracking = null;
  }
  render();
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg && msg.type === "init") {
    applyInit(msg as InitMsg);
    return;
  }
  if (msg && msg.type === "preview") {
    const p = msg as PreviewMsg;
    lastPreviewSql = p.sql;
    lastErrors = p.errors;
    const pre = document.getElementById("sql-preview") as HTMLPreElement | null;
    if (pre) pre.textContent = p.sql || "—";
    const errs = document.getElementById("sql-errors");
    if (errs) {
      errs.innerHTML =
        p.errors.length > 0
          ? `<ul>${p.errors.map((e: string) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`
          : "";
    }
    refreshOkButton();
    return;
  }
});

function refreshOkButton(): void {
  const ok = document.getElementById("okBtn") as HTMLButtonElement | null;
  if (!ok) return;
  // OK disabled khi errors > 0, hoặc modify mode với preview SQL rỗng.
  const errored = lastErrors.length > 0;
  const emptyModify = mode === "modify" && lastPreviewSql === "";
  ok.disabled = errored || emptyModify;
}
window.addEventListener("keydown", (ev: KeyboardEvent) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    post({ type: "cancel" });
  }
});
render();
post({ type: "ready" });
