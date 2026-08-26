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
    password: input("password").value,
    sslMode: (useSsl() ? select("sslMode").value : "disable") as SslMode,
    sslCaPath: input("sslCaPath").value.trim(),
    sslCertPath: input("sslCertPath").value.trim(),
    sslKeyPath: input("sslKeyPath").value.trim(),
    manualCommit: manualCommit(),
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

function fileRow(id: SslField, label: string, placeholder: string): string {
  return `
    <div class="vsdb-file-row" id="row-${id}">
      <label for="${id}">${label}</label>
      <input id="${id}" type="text" placeholder="${placeholder}" />
      <button id="pick-${id}" class="vsdb-form-pick" title="Chọn file…">Choose File</button>
    </div>`;
}

function render(): void {
  root.innerHTML = `
  <h2 id="formTitle">Add Connection</h2>
  <div class="vsdb-row">
    <div class="vsdb-field grow">
      <label for="name">Label <span class="req">*</span></label>
      <input id="name" type="text" placeholder="Local Dev" />
    </div>
    <div class="vsdb-field">
      <label for="driver">Driver</label>
      <select id="driver">
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL / MariaDB</option>
        <option value="mssql">SQL Server</option>
      </select>
    </div>
  </div>
  <div class="vsdb-row">
    <div class="vsdb-field grow">
      <label for="host">Host <span class="req">*</span></label>
      <input id="host" type="text" value="localhost" />
    </div>
    <div class="vsdb-field">
      <label for="port">Port <span class="req">*</span></label>
      <input id="port" type="text" value="5432" />
    </div>
  </div>
  <div class="vsdb-row">
    <div class="vsdb-field grow">
      <label for="user">Username <span class="req">*</span></label>
      <input id="user" type="text" />
    </div>
    <div class="vsdb-field grow">
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="off" />
    </div>
  </div>
  <div class="vsdb-row">
    <div class="vsdb-field grow">
      <label for="database">Database <span class="req">*</span></label>
      <input id="database" type="text" />
    </div>
  </div>
  <label class="vsdb-form-check">
    <input id="useSsl" type="checkbox" /> Use SSL
  </label>
  <div id="sslPanel" class="vsdb-form-ssl" style="display:none">
    <label class="vsdb-form-mode">Mode
      <select id="sslMode">
        <option value="require">Require — TLS, không verify cert</option>
        <option value="verify-ca">Verify-CA — verify cert, bỏ qua hostname</option>
        <option value="verify-full">Verify-Full — verify cert + hostname</option>
      </select>
    </label>
    ${fileRow("sslCaPath", "CA certificate:", "/path/to/server-ca.pem")}
    ${fileRow("sslCertPath", "Client certificate:", "/path/to/client-cert.pem")}
    ${fileRow("sslKeyPath", "Client key:", "/path/to/client-key.pem")}
  </div>
  <label class="vsdb-form-check">
    <input id="manualCommit" type="checkbox" /> Manual commit (giữ save trong
    transaction đến khi Commit/Rollback)
  </label>
  <div id="status" class="vsdb-form-status"></div>
  <div class="vsdb-form-actions">
    <button id="cancelBtn">Cancel</button>
    <button id="testBtn">Test</button>
    <button id="saveBtn" class="vsdb-form-primary">Save</button>
  </div>`;

  select("driver").addEventListener("change", () => {
    input("port").value = String(DRIVER_PORTS[select("driver").value as Driver]);
  });
  document.getElementById("useSsl")?.addEventListener("change", updateSslVisibility);
  select("sslMode").addEventListener("change", updateSslVisibility);
  for (const f of ["sslCaPath", "sslCertPath", "sslKeyPath"] as SslField[]) {
    document.getElementById(`pick-${f}`)?.addEventListener("click", () => {
      post({ type: "pickFile", field: f });
    });
  }
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
      setStatus(false, "Điền đủ các ô có *.");
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
