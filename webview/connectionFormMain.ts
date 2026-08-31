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

type Driver = "postgres" | "mysql" | "mssql";
type SslMode = "disable" | "require" | "verify-ca" | "verify-full";
type SslField = "sslCaPath" | "sslCertPath" | "sslKeyPath";

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
};

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

function readForm() {
  return {
    name: input("name").value.trim(),
    driver: select("driver").value as Driver,
    host: input("host").value.trim(),
    port: parseInt(input("port").value, 10) || 0,
    user: input("user").value.trim(),
    database: input("database").value.trim(),
    sslMode: (useSsl() ? select("sslMode").value : "disable") as SslMode,
    sslCaPath: input("sslCaPath").value.trim(),
    sslCertPath: input("sslCertPath").value.trim(),
    sslKeyPath: input("sslKeyPath").value.trim(),
    manualCommit: manualCommit(),
    folder: input("folder").value.trim(),
    color: input("color").value.trim(),
    readOnly: (document.getElementById("readOnly") as HTMLInputElement).checked,
    tunnelHost: input("tunnelHost").value.trim(),
    tunnelPort: parseInt(input("tunnelPort").value, 10) || 0,
    tunnelUser: input("tunnelUser").value.trim(),
    tunnelIdentityFile: input("tunnelIdentityFile").value.trim(),
   };
}

/** TASK-001 — per-connection manual transaction mode (luôn boolean cụ thể). */
function manualCommit(): boolean {
  return (document.getElementById("manualCommit") as HTMLInputElement).checked;
}

function useSsl(): boolean {
  return (document.getElementById("useSsl") as HTMLInputElement).checked;
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

  driver.addEventListener("change", () => {
    input("port").value = String(DRIVER_PORTS[driver.value as Driver]);
  });
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
    if (!f.name || !f.host || !f.user || !f.database || !f.port) {
      setStatus(false, "\u0110i\u1ec1n \u0111\u1ee7 c\u00e1c \u00f4 c\u00f3 *.");
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
