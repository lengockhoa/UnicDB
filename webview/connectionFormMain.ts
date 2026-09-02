// webview/connectionFormMain.ts
// Webview entry cho ConnectionForm — form 2 cột theo chuẩn DataGrip/DBeaver:
// Label+Host / Port+Database / Username+Password, Use SSL checkbox, Mode
// dropdown (Disable/Require/Verify-CA/Verify-Full), 3 file fields độc lập.
// Protocol: src/ui/connectionFormMessages.ts.
declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

type Driver = "postgres" | "mysql" | "mssql" | "bigquery";
type SslMode = "disable" | "require" | "verify-ca" | "verify-full";
type SslField = "sslCaPath" | "sslCertPath" | "sslKeyPath";
type SqlDriver = Exclude<Driver, "bigquery">;

interface FormConfig {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode?: SslMode;
  sslCaPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  /** TASK-001 — legacy records omit this; omitted renders unchecked. */
  manualCommit?: boolean;
  /** DBX-05 — connection workspace fields (optional). */
  folder?: string;
  color?: string;
  readOnly?: boolean;
  tunnel?: { host: string; port?: number; user?: string; identityFile?: string };
  /** TASK-BQ01-004 — BigQuery safe metadata (optional; only meaningful when driver === "bigquery"). */
  bigquery?: {
    billingProject?: string;
    location?: string;
    maxBytesBilled?: string;
    datasetProject?: string;
  };
}

const root = document.getElementById("vsdb-root") as HTMLDivElement;
let lastTestMessage = "";

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

const DRIVER_PORTS: Record<Driver, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  bigquery: 0,
};

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

/** Optional accessor — null-safe wrapper for fields that may be absent
 *  from the DOM (e.g. SQL fields when driver === "bigquery", or BQ fields
 *  when driver is a SQL driver). Returns "" when the input isn't present. */
function optionalInput(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return el ? String(el.value ?? "").trim() : "";
}

function readForm() {
  return {
    name: input("name").value.trim(),
    driver: select("driver").value as Driver,
    // SQL-only fields. When the BQ driver is selected the SQL group is
    // removed from DOM; optionalInput returns "" so the wire payload stays
    // symmetric (never undefined).
    host: optionalInput("host"),
    port: parseInt(optionalInput("port"), 10) || 0,
    user: optionalInput("user"),
    database: optionalInput("database"),
    password: optionalInput("password"),
    sslMode: (useSsl() ? select("sslMode").value : "disable") as SslMode,
    sslCaPath: optionalInput("sslCaPath"),
    sslCertPath: optionalInput("sslCertPath"),
    sslKeyPath: optionalInput("sslKeyPath"),
    manualCommit: manualCommit(),
    folder: input("folder").value.trim(),
    color: input("color").value.trim(),
    readOnly: (document.getElementById("readOnly") as HTMLInputElement).checked,
    tunnelHost: input("tunnelHost").value.trim(),
    tunnelPort: parseInt(input("tunnelPort").value, 10) || 0,
    tunnelUser: input("tunnelUser").value.trim(),
    tunnelIdentityFile: input("tunnelIdentityFile").value.trim(),
    /** TASK-BQ01-004 — BigQuery-only safe metadata; empty string when absent. */
    billingProject: optionalInput("billingProject"),
    bqLocation: optionalInput("bqLocation"),
    bqMaxBytesBilled: optionalInput("bqMaxBytesBilled"),
   };
}

/** TASK-001 — per-connection manual transaction mode (luôn boolean cụ thể). */
function manualCommit(): boolean {
  return (document.getElementById("manualCommit") as HTMLInputElement).checked;
}

function useSsl(): boolean {
  const el = document.getElementById("useSsl") as HTMLInputElement | null;
  // SQL-only checkbox — absent for bigquery (group removed from DOM).
  return el ? el.checked : false;
}

function setBusy(busy: boolean): void {
  (document.getElementById("testBtn") as HTMLButtonElement).disabled = busy;
  (document.getElementById("saveBtn") as HTMLButtonElement).disabled = busy;
  const status = document.getElementById("status");
  if (status) {
    status.textContent = busy ? "Đang kết nối thử…" : lastTestMessage;
    status.className = busy ? "vsdb-form-status busy" : "vsdb-form-status";
  }
}

function setStatus(ok: boolean, message: string): void {
  lastTestMessage = message;
  const status = document.getElementById("status");
  if (status) {
    status.textContent = message;
    status.className = `vsdb-form-status ${ok ? "ok" : "err"}`;
  }
}

/** Hiện/ẩn panel SSL theo checkbox Use SSL + mode (CA chỉ cần khi verify). */
function updateSslVisibility(): void {
  const on = useSsl();
  const panel = document.getElementById("sslPanel");
  if (panel) panel.style.display = on ? "" : "none";
  const mode = select("sslMode").value;
  const caRow = document.getElementById("row-sslCaPath");
  if (caRow) caRow.style.display = mode === "verify-ca" || mode === "verify-full" ? "" : "none";
}

/**
 * TASK-BQ01-004 — pure validation gate before submit. Returns null on
 * success or an inline-status error string describing the first failure.
 * No mutation of form state; the caller is responsible for posting the
 * submit message after a null return. Copy-safe by construction — no user
 * input is concatenated into the returned strings.
 */
function validateBeforeSubmit(f: ReturnType<typeof readForm>): string | null {
  if (!f.name) {
    return "Điền đủ các ô có *.";
  }
  if (f.driver === "bigquery") {
    if (!f.billingProject) {
      return "BigQuery cần billing project — điền GCP project ID chịu charge cho queries.";
    }
    if (f.bqMaxBytesBilled !== "" && !/^[1-9][0-9]*$/.test(f.bqMaxBytesBilled)) {
      return "Max bytes billed phải là số nguyên dương (vd 1000000) hoặc để trống.";
    }
    return null;
  }
  // SQL drivers: existing required-field gate (mirrors prior behavior).
  if (!f.host || !f.user || !f.database || !f.port) {
    return "Điền đủ các ô có *.";
  }
  return null;
}

/**
 * TASK-BQ01-004 — caches for the two driver-specific field groups. The
 * render() function builds BOTH nodes, then immediately removes the one
 * that doesn't match the initial driver (so the DOM starts with exactly
 * one). On driver change, `updateDriverVisibility` swaps which group is
 * attached. This is the structural "render ONLY" guarantee the bundle
 * tests assert via `document.getElementById` returning null for the
 * inactive group's inputs.
 */
let _sqlGroupCache: HTMLElement | null = null;
let _bqGroupCache: HTMLElement | null = null;

function rememberGroupCaches(): void {
  // Called once at the end of render() to snapshot the freshly built groups
  // so the swap function can re-attach them across driver changes.
  _sqlGroupCache = document.getElementById("sqlFields");
  _bqGroupCache = document.getElementById("bqFields");
}

function updateDriverVisibility(opts: { resetPort?: boolean } = {}): void {
  const driverEl = document.getElementById("driver") as HTMLSelectElement | null;
  const driver = (driverEl?.value ?? "postgres") as Driver;
  const isBq = driver === "bigquery";
  // Determine which group should currently be visible.
  const liveSql = document.getElementById("sqlFields");
  const liveBq = document.getElementById("bqFields");
  if (isBq) {
    // Detach SQL, attach BQ.
    liveSql?.remove();
    if (!liveBq && _bqGroupCache) {
      // Clear the initial display:none inline style so the re-attached
      // group is actually visible.
      _bqGroupCache.style.display = "";
      const manualCommit = document.getElementById("manualCommit");
      const parent = manualCommit?.parentElement ?? root;
      const beforeNode = manualCommit ?? null;
      parent.insertBefore(_bqGroupCache, beforeNode);
    }
  } else {
    // Detach BQ, attach SQL.
    liveBq?.remove();
    if (!liveSql && _sqlGroupCache) {
      _sqlGroupCache.style.display = "";
      const manualCommit = document.getElementById("manualCommit");
      const parent = manualCommit?.parentElement ?? root;
      const beforeNode = manualCommit ?? null;
      parent.insertBefore(_sqlGroupCache, beforeNode);
    }
    // Reset port default ONLY when the user actively switched drivers (or on
    // first render with no prefill). Skip when applyInit() called us AFTER
    // pre-filling the stored port — otherwise editing a connection with a
    // custom port (e.g. mysql:6544) would clobber it back to the driver
    // default (3306) and silently corrupt the persisted value.
    if (opts.resetPort) {
      const portEl = document.getElementById("port") as HTMLInputElement | null;
      if (portEl) portEl.value = String(DRIVER_PORTS[driver]);
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "") continue;
    node.setAttribute(k, v);
  }
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function fieldLabel(text: string, htmlFor: string, required = false): HTMLElement {
  const l = el("label", { for: htmlFor }, text);
  if (required) l.appendChild(el("span", { class: "req" }, "*"));
  return l;
}

function fileRow(id: SslField, text: string, placeholder: string): HTMLElement {
  const inputEl = el("input", { id, type: "text", placeholder });
  const pick = el(
    "button",
    { id: `pick-${id}`, class: "vsdb-form-pick", title: "Chọn file…" },
    "Choose File",
  );
  pick.addEventListener("click", () => {
    post({ type: "pickFile", field: id });
  });
  return el(
    "div",
    { class: "vsdb-file-row", id: `row-${id}` },
    fieldLabel(text, id),
    inputEl,
    pick,
  );
}

  /** Render the form with DOM APIs only — no HTML-string sinks (CSP + XSS hygiene). */
function render(): void {
  root.textContent = "";

  const driver = el(
    "select",
    { id: "driver" },
    el("option", { value: "postgres" }, "PostgreSQL"),
    el("option", { value: "mysql" }, "MySQL / MariaDB"),
    el("option", { value: "mssql" }, "SQL Server"),
    el("option", { value: "bigquery" }, "Google BigQuery"),
  );

  const sslMode = el(
    "select",
    { id: "sslMode" },
    el("option", { value: "require" }, "Require — TLS, kh\u00f4ng verify cert"),
    el("option", { value: "verify-ca" }, "Verify-CA — verify cert, b\u1ecf qua hostname"),
    el("option", { value: "verify-full" }, "Verify-Full — verify cert + hostname"),
  );

  const sslPanel = el(
    "div",
    { id: "sslPanel", class: "vsdb-form-ssl", style: "display:none" },
    el("label", { class: "vsdb-form-mode" }, "Mode", sslMode),
    fileRow("sslCaPath", "CA certificate:", "/path/to/server-ca.pem"),
    fileRow("sslCertPath", "Client certificate:", "/path/to/client-cert.pem"),
    fileRow("sslKeyPath", "Client key:", "/path/to/client-key.pem"),
  );

  const tunnel = el(
    "details",
    { id: "tunnelPanel", class: "vsdb-form-tunnel" },
    el("summary", {}, "SSH tunnel"),
    el(
      "div",
      { class: "vsdb-row" },
      el(
        "div",
        { class: "vsdb-field grow" },
        fieldLabel("Bastion host", "tunnelHost"),
        el("input", { id: "tunnelHost", type: "text", placeholder: "jump.example.com" }),
      ),
      el(
        "div",
        { class: "vsdb-field" },
        fieldLabel("Bastion port", "tunnelPort"),
        el("input", { id: "tunnelPort", type: "number", placeholder: "22" }),
      ),
    ),
    el(
      "div",
      { class: "vsdb-row" },
      el(
        "div",
        { class: "vsdb-field grow" },
        fieldLabel("SSH user", "tunnelUser"),
        el("input", { id: "tunnelUser", type: "text", placeholder: "devops" }),
      ),
      el(
        "div",
        { class: "vsdb-field grow" },
        fieldLabel("Identity file", "tunnelIdentityFile"),
        el("input", {
          id: "tunnelIdentityFile",
          type: "text",
          placeholder: "/Users/me/.ssh/id_ed25519",
        }),
      ),
    ),
  );

  root.append(
    el("h2", { id: "formTitle" }, "Add Connection"),
    el(
      "div",
      { class: "vsdb-row" },
      el(
        "div",
        { class: "vsdb-field grow" },
        fieldLabel("Label", "name", true),
        el("input", { id: "name", type: "text", placeholder: "Local Dev" }),
      ),
      el("div", { class: "vsdb-field" }, fieldLabel("Driver", "driver"), driver),
    ),
    // TASK-BQ01-004 — SQL-only field group. Hidden entirely for bigquery.
    el(
      "div",
      { id: "sqlFields" },
      el(
        "div",
        { class: "vsdb-row" },
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Host", "host", true),
          el("input", { id: "host", type: "text", value: "localhost" }),
        ),
        el(
          "div",
          { class: "vsdb-field" },
          fieldLabel("Port", "port", true),
          el("input", { id: "port", type: "text", value: "5432" }),
        ),
      ),
      el(
        "div",
        { class: "vsdb-row" },
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Username", "user", true),
          el("input", { id: "user", type: "text" }),
        ),
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Password", "password"),
          el("input", { id: "password", type: "password", autocomplete: "off" }),
        ),
      ),
      el(
        "div",
        { class: "vsdb-row" },
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Database", "database", true),
          el("input", { id: "database", type: "text" }),
        ),
      ),
      el(
        "label",
        { class: "vsdb-form-check" },
        el("input", { id: "useSsl", type: "checkbox" }),
        " Use SSL",
      ),
      sslPanel,
    ),
    // TASK-BQ01-004 — BigQuery field group. Hidden for SQL drivers.
    el(
      "div",
      { id: "bqFields", style: "display:none" },
      el(
        "div",
        { class: "vsdb-row" },
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Billing project", "billingProject", true),
          el("input", {
            id: "billingProject",
            type: "text",
            placeholder: "my-gcp-billing-project",
          }),
        ),
      ),
      el(
        "div",
        { class: "vsdb-row" },
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Location", "bqLocation"),
          el("input", {
            id: "bqLocation",
            type: "text",
            placeholder: "US / EU / us-central1",
          }),
        ),
        el(
          "div",
          { class: "vsdb-field grow" },
          fieldLabel("Max bytes billed", "bqMaxBytesBilled"),
          el("input", {
            id: "bqMaxBytesBilled",
            type: "text",
            placeholder: "1000000",
          }),
        ),
      ),
      el(
        "p",
        { class: "vsdb-form-hint" },
        "BigQuery dùng Application Default Credentials (ADC) từ máy local. Chạy ",
        el("code", {}, "gcloud auth application-default login"),
        " nếu chưa có.",
      ),
    ),
    el(
      "label",
      { class: "vsdb-form-check" },
      el("input", { id: "manualCommit", type: "checkbox" }),
      " Manual commit (gi\u1eef save trong transaction \u0111\u1ebfn khi Commit/Rollback)",
    ),
    el("h3", { class: "vsdb-form-section" }, "Workspace"),
    el(
      "div",
      { class: "vsdb-row" },
      el(
        "div",
        { class: "vsdb-field grow" },
        fieldLabel("Folder", "folder"),
        el("input", { id: "folder", type: "text", placeholder: "prod / staging / dev" }),
      ),
      el(
        "div",
        { class: "vsdb-field" },
        fieldLabel("Color (hex)", "color"),
        el("input", { id: "color", type: "text", placeholder: "#4fc1ff" }),
      ),
    ),
    el(
      "label",
      { class: "vsdb-form-check" },
      el("input", { id: "readOnly", type: "checkbox" }),
      " Read-only — ch\u1eb7n m\u1ecdi c\u00e2u l\u1ec7nh thay \u0111\u1ed5i (INSERT/UPDATE/DELETE/DDL/GRANT) tr\u01b0\u1edbc khi g\u1eedi t\u1edbi server",
    ),
    tunnel,
    el("div", { id: "status", class: "vsdb-form-status" }),
    el(
      "div",
      { class: "vsdb-form-actions" },
      el("button", { id: "cancelBtn" }, "Cancel"),
      el("button", { id: "testBtn" }, "Test"),
      el("button", { id: "saveBtn", class: "vsdb-form-primary" }, "Save"),
    ),
  );

  // TASK-BQ01-004 — driver change toggles SQL vs BigQuery field groups.
  // resetPort:true on USER-driven change so swapping to a new SQL driver
  // shows the matching default port (mysql→3306, mssql→1433, …).
  driver.addEventListener("change", () => updateDriverVisibility({ resetPort: true }));
  // Snapshot the freshly built groups BEFORE the initial visibility swap
  // detaches the inactive one — needed so subsequent driver changes can
  // re-attach the right group.
  rememberGroupCaches();
  // Initial state — SQL by default (postgres selected on first render).
  // resetPort:true so the markup default 5432 is reaffirmed for add-form;
  // applyInit() will explicitly call WITHOUT resetPort to preserve any
  // stored custom port from the existing connection record.
  updateDriverVisibility({ resetPort: true });
  (document.getElementById("useSsl") as HTMLInputElement).addEventListener(
    "change",
    updateSslVisibility,
  );
  sslMode.addEventListener("change", updateSslVisibility);
  document.getElementById("cancelBtn")?.addEventListener("click", () => {
    post({ type: "cancel" });
  });
  document.getElementById("testBtn")?.addEventListener("click", () => {
    setBusy(true);
    post({ type: "test", ...readForm() });
  });
  document.getElementById("saveBtn")?.addEventListener("click", () => {
    const f = readForm();
    // TASK-BQ01-004 \u2014 driver-specific submit gate. SQL drivers need
    // host/port/user/database; bigquery needs billingProject (+ valid
    // optional maxBytesBilled). Returns inline-status string on failure;
    // NO submit posted, NO host round-trip on failure.
    const err = validateBeforeSubmit(f);
    if (err !== null) {
      setStatus(false, err);
      return;
    }
    post({ type: "submit", ...f });
  });
  updateSslVisibility();
}

function applyInit(existing: FormConfig | null): void {
  if (!existing) return;
  document.getElementById("formTitle")!.textContent = `Edit — ${existing.name}`;
  input("name").value = existing.name;
  select("driver").value = existing.driver;
  input("host").value = existing.host;
  input("port").value = String(existing.port);
  input("user").value = existing.user;
  input("database").value = existing.database;
  input("sslCaPath").value = existing.sslCaPath ?? "";
  input("sslCertPath").value = existing.sslCertPath ?? "";
  input("sslKeyPath").value = existing.sslKeyPath ?? "";
  const mode = existing.sslMode ?? "disable";
  (document.getElementById("useSsl") as HTMLInputElement).checked = mode !== "disable";
  if (mode !== "disable") {
    select("sslMode").value = mode === "require" || mode === "verify-ca" || mode === "verify-full"
      ? mode
      : "require";
  }
  input("password").placeholder = "•••• (để trống giữ nguyên)";
  // TASK-001 — legacy records omitting the optional field stay unchecked.
  (document.getElementById("manualCommit") as HTMLInputElement).checked =
    existing.manualCommit === true;
  updateSslVisibility();
  // DBX-05 — workspace fields.
  input("folder").value = existing.folder ?? "";
  input("color").value = existing.color ?? "";
  (document.getElementById("readOnly") as HTMLInputElement).checked =
    existing.readOnly === true;
  input("tunnelHost").value = existing.tunnel?.host ?? "";
  input("tunnelPort").value = existing.tunnel?.port ? String(existing.tunnel.port) : "";
  input("tunnelUser").value = existing.tunnel?.user ?? "";
  input("tunnelIdentityFile").value = existing.tunnel?.identityFile ?? "";
  // TASK-BQ01-004 — toggle field group for the prefilled driver, then
  // prefill BQ inputs when editing a bigquery connection. Explicitly
  // OMIT resetPort so the stored port (e.g. mysql:6544) survives the
  // group swap instead of being clobbered by the driver default.
  updateDriverVisibility({ resetPort: false });
  const bp = (document.getElementById("billingProject") as HTMLInputElement | null);
  const bl = (document.getElementById("bqLocation") as HTMLInputElement | null);
  const bm = (document.getElementById("bqMaxBytesBilled") as HTMLInputElement | null);
  if (bp) bp.value = existing.bigquery?.billingProject ?? "";
  if (bl) bl.value = existing.bigquery?.location ?? "";
  if (bm) bm.value = existing.bigquery?.maxBytesBilled ?? "";
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      applyInit(msg.existing);
      break;
    case "pickFileResult":
      input(msg.field as SslField).value = msg.path;
      break;
    case "testResult":
      setBusy(false);
      setStatus(msg.ok, msg.message);
      break;
  }
});

render();
post({ type: "ready" });
