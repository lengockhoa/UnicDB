// webview/schemaFormMain.ts
// Webview entry cho SchemaForm (Create New Schema). Vanilla DOM. Self-contained:
// redeclare message interfaces inline (mirror src/ui/schemaForm.ts shape).
// State: lastName (string) + lastPreview (from host). User typing → post nameChanged;
// host posts preview back; render errors + disable OK when errors>0.
declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

interface InitMsg {
  type: "init";
  existingNames: string[];
}
interface PreviewMsg {
  type: "preview";
  sql: string;
  errors: string[];
  okEnabled: boolean;
}
type HostMessage = InitMsg | PreviewMsg;

interface ReadyMsg { type: "ready"; }
interface NameChangedMsg { type: "nameChanged"; name: string; }
interface SubmitMsg { type: "submit"; name: string; }
interface CancelMsg { type: "cancel"; }
type WebviewMessage = ReadyMsg | NameChangedMsg | SubmitMsg | CancelMsg;

const root = document.getElementById("vsdb-root") as HTMLDivElement;
let lastName = "";
let lastErrors: string[] = [];
let lastSql = "—";
let okEnabled = false;

function post(msg: WebviewMessage): void {
  vscodeApi?.postMessage(msg);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: {
    id?: string;
    type?: string;
    className?: string;
    text?: string;
    placeholder?: string;
    value?: string;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.id) node.id = opts.id;
  if (opts.type) (node as HTMLInputElement).type = opts.type;
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.placeholder) (node as HTMLInputElement).placeholder = opts.placeholder;
  if (opts.value !== undefined) (node as HTMLInputElement).value = opts.value;
  return node;
}

function render(): void {
  root.innerHTML = "";

  const header = el("div", { className: "vsdb-form-header" });
  header.appendChild(el("h2", { text: "Create New Schema" }));
  root.appendChild(header);

  const fieldRow = el("div", { className: "vsdb-form-row" });
  fieldRow.appendChild(el("label", { text: "Name" }));
  const input = el("input", {
    id: "schemaName",
    type: "text",
    placeholder: "schema_name",
  }) as HTMLInputElement;
  input.value = lastName;
  input.autofocus = true;
  input.addEventListener("input", () => {
    lastName = input.value;
    post({ type: "nameChanged", name: lastName });
  });
  fieldRow.appendChild(input);
  root.appendChild(fieldRow);

  const previewLabel = el("label", { text: "Preview" });
  root.appendChild(previewLabel);
  const pre = el("pre", { id: "sql-preview", text: lastSql }) as HTMLPreElement;
  root.appendChild(pre);

  const errorsBox = el("div", { id: "vsdb-errors", className: "vsdb-form-errors" });
  for (const e of lastErrors) {
    const item = el("div", { className: "vsdb-form-error", text: e });
    errorsBox.appendChild(item);
  }
  root.appendChild(errorsBox);

  const actions = el("div", { className: "vsdb-form-actions" });
  const ok = el("button", { id: "vsdb-ok", text: "OK" }) as HTMLButtonElement;
  ok.disabled = !okEnabled;
  ok.addEventListener("click", () => {
    post({ type: "submit", name: lastName });
  });
  actions.appendChild(ok);
  const cancel = el("button", { id: "vsdb-cancel", text: "Cancel" }) as HTMLButtonElement;
  cancel.addEventListener("click", () => {
    post({ type: "cancel" });
  });
  actions.appendChild(cancel);
  root.appendChild(actions);
}

function applyPreview(msg: PreviewMsg): void {
  lastSql = msg.sql;
  lastErrors = msg.errors;
  okEnabled = msg.okEnabled;
  render();
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostMessage;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "init":
      // existingNames tracked host-side; nothing to render here.
      return;
    case "preview":
      applyPreview(msg);
      return;
  }
});

document.addEventListener("keydown", (ev: KeyboardEvent) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    post({ type: "cancel" });
  }
});

render();
post({ type: "ready" });