// webview/aiSettingsFormMain.ts
// Webview entry cho AiSettingsForm — one place to configure the OpenAI-
// compatible AI backend (baseUrl, method, timeout, maxSteps, both model
// roles + vision flag, apiKey write-only). Vanilla DOM, no framework.
//
// SECURITY:
//   - The apiKey input is WRITE-ONLY from webview → host; host replies only
//     with `hasApiKey: boolean`.
//   - When `hasApiKey` is true the placeholder reads "•••• stored"; an empty
//     submit with `hasApiKey` ⇒ keep stored key (host decides).
//
// Protocol: src/ui/aiSettingsFormMessages.ts.
declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

type Method = "responses" | "chat/completions";
type Role = "work" | "smart" | "autocomplete";

interface InitMsg {
  type: "init";
  settings: {
    baseUrl: string;
    method: Method;
    timeoutMs: number;
    maxSteps: number;
    models: Record<Role, { modelId: string; vision: boolean }>;
  };
  hasApiKey: boolean;
}

interface TestResultMsg {
  type: "testResult";
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface SavedMsg {
  type: "saved";
}

interface SaveResultMsg {
  type: "saveResult";
  ok: false;
  error: string;
}

type HostMsg = InitMsg | TestResultMsg | SavedMsg | SaveResultMsg;

const root = document.getElementById("UnicDB-root") as HTMLDivElement;

interface State {
  settings: {
    baseUrl: string;
    method: Method;
    timeoutMs: number;
    maxSteps: number;
    models: Record<Role, { modelId: string; vision: boolean }>;
  };
  hasApiKey: boolean;
  testing: boolean;
  lastStatus: { ok: boolean; message: string } | null;
}

const state: State = {
  settings: {
    baseUrl: "",
    method: "chat/completions",
    timeoutMs: 60000,
    maxSteps: 12,
    models: {
      work: { modelId: "", vision: true },
      smart: { modelId: "", vision: false },
      autocomplete: { modelId: "", vision: false },
    },
  },
  hasApiKey: false,
  testing: false,
  lastStatus: null,
};

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

function readSettings(): {
  baseUrl: string;
  method: Method;
  timeoutMs: number;
  maxSteps: number;
  models: Record<Role, { modelId: string; vision: boolean }>;
} {
  return {
    baseUrl: input("baseUrl").value.trim(),
    method: select("method").value as Method,
    timeoutMs: Number(input("timeoutMs").value),
    maxSteps: Number(input("maxSteps").value),
    models: {
      work: {
        modelId: input("modelWork").value.trim(),
        vision: input("visionWork").checked,
      },
      smart: {
        modelId: input("modelSmart").value.trim(),
        vision: input("visionSmart").checked,
      },
      autocomplete: {
        modelId: input("modelAutocomplete").value.trim(),
        vision: false,
      },
    },
  };
}

// Local minimal validation mirror of aiSettingsErrors (webview cannot import
// src/ai/* when bundled in a different module graph easily; messages stay in
// lockstep with the host-side validator so the OK gate matches exactly).
function validateSettings(s: State["settings"]): string[] {
  const errors: string[] = [];
  if (typeof s.baseUrl !== "string" || s.baseUrl.trim() === "") {
    errors.push("Base URL is required");
  } else if (!/^https?:\/\//i.test(s.baseUrl.trim())) {
    errors.push("Base URL must start with http:// or https://");
  }
  if (s.method !== "responses" && s.method !== "chat/completions") {
    errors.push("Method must be responses or chat/completions");
  }
  if (
    typeof s.timeoutMs !== "number" ||
    s.timeoutMs < 1000 ||
    s.timeoutMs > 600000
  ) {
    errors.push("Timeout must be between 1000 and 600000 ms");
  }
  if (typeof s.maxSteps !== "number" || s.maxSteps < 1 || s.maxSteps > 100) {
    errors.push("Max steps must be between 1 and 100");
  }
  if (!s.models || typeof s.models !== "object") {
    errors.push("models must define work, smart, and autocomplete roles");
  } else {
    for (const role of ["work", "smart"] as const) {
      const m = s.models[role];
      if (m && typeof m.modelId === "string" && m.modelId.trim() === "") {
        errors.push(`Model is required for role: ${role}`);
      }
    }
    // Cycle AIC: empty autocomplete is allowed (feature disabled), not invalid.
  }
  return errors;
}

function setBusy(busy: boolean): void {
  const testBtn = document.getElementById("testBtn") as HTMLButtonElement | null;
  const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement | null;
  if (testBtn) testBtn.disabled = busy;
  if (saveBtn) saveBtn.disabled = busy;
  const status = document.getElementById("status");
  if (status) {
    status.textContent = busy ? "Testing connection…" : (state.lastStatus?.message ?? "");
    status.className = busy
      ? "UnicDB-form-status busy"
      : state.lastStatus
        ? `UnicDB-form-status ${state.lastStatus.ok ? "ok" : "err"}`
        : "UnicDB-form-status";
  }
}

function setStatus(ok: boolean, message: string): void {
  state.lastStatus = { ok, message };
  const status = document.getElementById("status");
  if (status) {
    status.textContent = message;
    status.className = `UnicDB-form-status ${ok ? "ok" : "err"}`;
  }
}

function refreshOkButton(errors: string[]): void {
  const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement | null;
  const testBtn = document.getElementById("testBtn") as HTMLButtonElement | null;
  const apiKeyValue = input("apiKey").value;
  // apiKey can be empty ONLY if hasApiKey is true (host decides "keep").
  const apiKeyOk = apiKeyValue !== "" || state.hasApiKey;
  const errorsList = document.getElementById("errors");
  if (errorsList) {
    errorsList.innerHTML = errors.length
      ? errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")
      : "";
  }
  if (saveBtn) saveBtn.disabled = errors.length > 0 || !apiKeyOk;
  if (testBtn) testBtn.disabled = errors.length > 0 || !apiKeyOk || state.testing;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

function modelBlock(role: Role, label: string, defaultVision: boolean, opts: { placeholder?: string; showVision?: boolean } = {}): string {
  const id = role[0].toUpperCase() + role.slice(1);
  const placeholder = opts.placeholder ?? "gpt-4o-mini";
  const showVision = opts.showVision ?? true;
  const visionHtml = showVision
    ? `<div class="UnicDB-field">
          <label class="UnicDB-form-check">
            <input id="vision${id}" type="checkbox"${defaultVision ? " checked" : ""} /> Vision-capable
          </label>
        </div>`
    : "";
  return `
    <div class="UnicDB-form-section">
      <h3>${label} model</h3>
      <div class="UnicDB-row">
        <div class="UnicDB-field grow">
          <label for="model${id}">Model ID <span class="req">*</span></label>
          <input id="model${id}" type="text" placeholder="${escapeHtml(placeholder)}" />
        </div>
        ${visionHtml}
      </div>
    </div>`;
}

function render(): void {
  root.innerHTML = `
  <h2>AI Settings</h2>
  <p class="UnicDB-form-help">Configure your OpenAI-compatible backend. The API key is stored in VS Code SecretStorage; this form only ever <em>writes</em> it.</p>

  <div class="UnicDB-form-section">
    <div class="UnicDB-row">
      <div class="UnicDB-field grow">
        <label for="baseUrl">Base URL <span class="req">*</span></label>
        <input id="baseUrl" type="text" placeholder="https://api.openai.com/v1" />
      </div>
      <div class="UnicDB-field">
        <label for="method">Method</label>
        <select id="method">
          <option value="responses">responses</option>
          <option value="chat/completions">chat/completions</option>
        </select>
      </div>
    </div>
    <div class="UnicDB-row">
      <div class="UnicDB-field">
        <label for="timeoutMs">Timeout (ms) <span class="req">*</span></label>
        <input id="timeoutMs" type="number" min="1000" max="600000" step="1000" value="60000" />
      </div>
      <div class="UnicDB-field">
        <label for="maxSteps">Max steps <span class="req">*</span></label>
        <input id="maxSteps" type="number" min="1" max="100" step="1" value="12" />
      </div>
    </div>
  </div>

  ${modelBlock("work", "Work", true)}
  ${modelBlock("smart", "Smart", false)}
  ${modelBlock("autocomplete", "Autocomplete (SQL ghost text)", false, { placeholder: "vendor/free-fast-sql", showVision: false })}



  <div class="UnicDB-form-section">
    <h3>API key</h3>
    <div class="UnicDB-row">
      <div class="UnicDB-field grow">
        <label for="apiKey">API key</label>
        <input id="apiKey" type="password" autocomplete="off" />
      </div>
    </div>
  </div>

  <ul id="errors" class="UnicDB-form-errors"></ul>
  <div id="status" class="UnicDB-form-status"></div>
  <div class="UnicDB-form-actions">
    <button id="cancelBtn">Cancel</button>
    <button id="testBtn">Test</button>
    <button id="saveBtn" class="UnicDB-form-primary">Save</button>
  </div>`;

  // Wire change handlers — live-validate on every edit.
  for (const id of ["baseUrl", "timeoutMs", "maxSteps", "modelWork", "modelSmart", "modelAutocomplete", "apiKey"]) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.addEventListener("input", () => refreshOkButton(validateSettings(readSettings())));
    el?.addEventListener("change", () => refreshOkButton(validateSettings(readSettings())));
  }
  for (const id of ["method"]) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    el?.addEventListener("change", () => refreshOkButton(validateSettings(readSettings())));
  }
  for (const id of ["visionWork", "visionSmart"]) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.addEventListener("change", () => refreshOkButton(validateSettings(readSettings())));
  }
  document.getElementById("cancelBtn")?.addEventListener("click", () => {
    post({ type: "cancel" });
  });
  document.getElementById("testBtn")?.addEventListener("click", () => {
    const settings = readSettings();
    if (validateSettings(settings).length > 0) return;
    state.testing = true;
    setBusy(true);
    post({ type: "test", settings, apiKey: input("apiKey").value });
  });
  document.getElementById("saveBtn")?.addEventListener("click", () => {
    const settings = readSettings();
    if (validateSettings(settings).length > 0) return;
    const apiKey = input("apiKey").value;
    if (apiKey === "" && !state.hasApiKey) {
      setStatus(false, "API key is required");
      return;
    }
    post({ type: "save", settings, apiKey });
  });
}

function applyInit(msg: InitMsg): void {
  state.settings = msg.settings;
  state.hasApiKey = msg.hasApiKey;
  state.lastStatus = null;
  input("baseUrl").value = msg.settings.baseUrl;
  select("method").value = msg.settings.method;
  input("timeoutMs").value = String(msg.settings.timeoutMs);
  input("modelWork").value = msg.settings.models.work.modelId;
  input("modelSmart").value = msg.settings.models.smart.modelId;
  input("modelAutocomplete").value = msg.settings.models.autocomplete?.modelId ?? "";
  (input("visionWork") as HTMLInputElement).checked =
    msg.settings.models.work.vision;
  (input("visionSmart") as HTMLInputElement).checked =
    msg.settings.models.smart.vision;
  // Placeholder tells the user the key is stored; empty submit ⇒ keep.
  input("apiKey").placeholder = msg.hasApiKey ? "•••• stored" : "";
  input("apiKey").value = "";
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "";
    status.className = "UnicDB-form-status";
  }
  refreshOkButton(validateSettings(state.settings));
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostMsg;
  switch (msg.type) {
    case "init":
      applyInit(msg);
      break;
    case "testResult":
      state.testing = false;
      if (msg.ok) {
        const ms = msg.latencyMs ?? 0;
        setStatus(true, `Connection OK (${ms} ms)`);
      } else {
        setStatus(false, msg.error ?? "Connection failed");
      }
      setBusy(false);
      break;
    case "saved":
      setStatus(true, "Saved.");
      // After save, we assume a key was set (either new or kept); update hasApiKey
      // so subsequent empty submits keep the (possibly updated) stored key.
      state.hasApiKey = true;
      input("apiKey").value = "";
      input("apiKey").placeholder = "•••• stored";
      refreshOkButton(validateSettings(state.settings));
      break;
    case "saveResult":
      // B13: a failed SAVE renders through its own status message — never
      // conflated with a failed connection Test.
      setStatus(false, msg.error || "Save failed");
      break;
  }
});

window.addEventListener("keydown", (ev: KeyboardEvent) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    post({ type: "cancel" });
  }
});

render();
post({ type: "ready" });