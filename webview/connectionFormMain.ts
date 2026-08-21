// webview/connectionFormMain.ts
// Webview entry cho ConnectionForm — form một chỗ thay cho 7 input box tuần tự.
// Protocol: src/ui/connectionFormMessages.ts.
declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

interface FormConfig {
  id: string;
  name: string;
  driver: "postgres" | "mysql" | "mssql";
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode?: "disable" | "prefer" | "verify" | "verify-full";
  sslCaPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
}

type SslField = "sslCaPath" | "sslCertPath" | "sslKeyPath";

const root = document.getElementById("vsdb-root") as HTMLDivElement;
let editMode = false;
let lastTestMessage = "";

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

const DRIVER_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
};

function field(id: string): HTMLInputElement | HTMLSelectElement {
  return document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
}

function readForm() {
  return {
    name: (field("name") as HTMLInputElement).value.trim(),
    driver: field("driver").value as FormConfig["driver"],
    host: (field("host") as HTMLInputElement).value.trim(),
    port: parseInt((field("port") as HTMLInputElement).value, 10) || 0,
    user: (field("user") as HTMLInputElement).value.trim(),
    database: (field("database") as HTMLInputElement).value.trim(),
    password: (field("password") as HTMLInputElement).value,
    sslMode: field("sslMode").value as FormConfig["sslMode"],
    sslCaPath: (field("sslCaPath") as HTMLInputElement).value.trim(),
    sslCertPath: (field("sslCertPath") as HTMLInputElement).value.trim(),
    sslKeyPath: (field("sslKeyPath") as HTMLInputElement).value.trim(),
  };
}

function setBusy(busy: boolean): void {
  const testBtn = document.getElementById("testBtn") as HTMLButtonElement;
  const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
  testBtn.disabled = busy;
  saveBtn.disabled = busy;
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

function updateSslVisibility(): void {
  const mode = field("sslMode").value;
  const showCa = mode === "verify" || mode === "verify-full";
  const showClient = mode === "verify-full";
  const caRow = document.getElementById("row-sslCaPath");
  const certRow = document.getElementById("row-sslCertPath");
  const keyRow = document.getElementById("row-sslKeyPath");
  if (caRow) caRow.style.display = showCa ? "" : "none";
  if (certRow) certRow.style.display = showClient ? "" : "none";
  if (keyRow) keyRow.style.display = showClient ? "" : "none";
}

function render(): void {
  root.innerHTML = `
  <h2 id="formTitle">New Connection</h2>
  <div class="vsdb-form-grid">
    <label for="name">Name</label>
    <input id="name" type="text" placeholder="Local PG" />

    <label for="driver">Driver</label>
    <select id="driver">
      <option value="postgres">PostgreSQL</option>
      <option value="mysql">MySQL / MariaDB</option>
      <option value="mssql">SQL Server</option>
    </select>

    <label for="host">Host</label>
    <input id="host" type="text" value="127.0.0.1" />

    <label for="port">Port</label>
    <input id="port" type="text" value="5432" />

    <label for="user">User</label>
    <input id="user" type="text" />

    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="off" />

    <label for="database">Database</label>
    <input id="database" type="text" />

    <label for="sslMode">SSL Mode</label>
    <select id="sslMode">
      <option value="disable">Disable — không TLS</option>
      <option value="prefer">Prefer — TLS, chấp nhận self-signed</option>
      <option value="verify">Verify — TLS, verify CA</option>
      <option value="verify-full">Verify-Full — TLS + client cert</option>
    </select>

    <label for="sslCaPath" id="row-sslCaPath">CA cert (.pem)</label>
    <div class="vsdb-form-path">
      <input id="sslCaPath" type="text" placeholder="/path/to/ca.pem" />
      <button id="pickCa" class="vsdb-form-pick" title="Chọn file…">…</button>
    </div>

    <label for="sslCertPath" id="row-sslCertPath">Client cert (.pem)</label>
    <div class="vsdb-form-path">
      <input id="sslCertPath" type="text" placeholder="/path/to/client-cert.pem" />
      <button id="pickCert" class="vsdb-form-pick" title="Chọn file…">…</button>
    </div>

    <label for="sslKeyPath" id="row-sslKeyPath">Client key</label>
    <div class="vsdb-form-path">
      <input id="sslKeyPath" type="text" placeholder="/path/to/client-key.pem" />
      <button id="pickKey" class="vsdb-form-pick" title="Chọn file…">…</button>
    </div>
  </div>
  <div id="status" class="vsdb-form-status"></div>
  <div class="vsdb-form-actions">
    <button id="cancelBtn">Cancel</button>
    <button id="testBtn">Test Connection</button>
    <button id="saveBtn" class="vsdb-form-primary">Save</button>
  </div>`;

  field("driver").addEventListener("change", () => {
    (field("port") as HTMLInputElement).value = String(
      DRIVER_PORTS[field("driver").value] ?? 5432,
    );
  });
  field("sslMode").addEventListener("change", updateSslVisibility);
  document.getElementById("pickCa")?.addEventListener("click", () => {
    post({ type: "pickFile", field: "sslCaPath" });
  });
  document.getElementById("pickCert")?.addEventListener("click", () => {
    post({ type: "pickFile", field: "sslCertPath" });
  });
  document.getElementById("pickKey")?.addEventListener("click", () => {
    post({ type: "pickFile", field: "sslKeyPath" });
  });
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
      setStatus(false, "Điền đủ Name / Host / Port / User / Database.");
      return;
    }
    post({ type: "submit", ...f });
  });
  updateSslVisibility();
}

function applyInit(existing: FormConfig | null): void {
  if (!existing) return;
  editMode = true;
  document.getElementById("formTitle")!.textContent = `Edit — ${existing.name}`;
  (field("name") as HTMLInputElement).value = existing.name;
  field("driver").value = existing.driver;
  (field("host") as HTMLInputElement).value = existing.host;
  (field("port") as HTMLInputElement).value = String(existing.port);
  (field("user") as HTMLInputElement).value = existing.user;
  (field("database") as HTMLInputElement).value = existing.database;
  field("sslMode").value = existing.sslMode ?? "disable";
  (field("sslCaPath") as HTMLInputElement).value = existing.sslCaPath ?? "";
  (field("sslCertPath") as HTMLInputElement).value = existing.sslCertPath ?? "";
  (field("sslKeyPath") as HTMLInputElement).value = existing.sslKeyPath ?? "";
  (field("password") as HTMLInputElement).placeholder = "•••• (để trống giữ nguyên)";
  updateSslVisibility();
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      applyInit(msg.existing);
      post({ type: "ready" });
      break;
    case "pickFileResult":
      (field(msg.field as SslField) as HTMLInputElement).value = msg.path;
      break;
    case "testResult":
      setBusy(false);
      setStatus(msg.ok, msg.message);
      break;
  }
});

render();
post({ type: "ready" });
