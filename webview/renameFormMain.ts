// webview/renameFormMain.ts — TASK-DBX06-003
// Webview entry cho RenameForm — minimal safe-rename dialog.
// Vanilla DOM only (textContent/createElement — no innerHTML sinks).
// Protocol mirror src/ui/renameFormMessages.ts.
import type {
  RenameFormHostMessage,
} from "../src/ui/renameFormMessages";

declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

function post(msg: unknown): void {
  vscodeApi?.postMessage(msg);
}

interface State {
  mode: "table" | "column";
  schema: string;
  table: string;
  oldName: string;
  approved: boolean;
}

let state: State = {
  mode: "table",
  schema: "",
  table: "",
  oldName: "",
  approved: false,
};

const root = document.getElementById("vsdb-root") as HTMLDivElement;

// ---- DOM helpers (textContent only — CSP/scaffold safe) --------------------

function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function line(e: HTMLElement, text: string): void {
  e.appendChild(el("div", "vsdb-rename-line", text));
}

// ---- render ----------------------------------------------------------------

function renderInit(): void {
  root.textContent = "";
  const form = el("div", "vsdb-rename-form");

  const title = el(
    "h2",
    "vsdb-rename-title",
    `Rename ${state.mode} — ${state.schema}.${state.table}`,
  );
  form.appendChild(title);

  const row = el("div", "vsdb-rename-row");
  row.appendChild(
    el("label", "vsdb-rename-label", `New ${state.mode} name for "${state.oldName}":`),
  );
  const input = el("input", "vsdb-rename-input") as HTMLInputElement;
  input.type = "text";
  input.id = "vsdb-rename-input";
  input.value = state.oldName;
  row.appendChild(input);
  form.appendChild(row);

  const analyzeBtn = el("button", "vsdb-rename-analyze", "Analyze");
  analyzeBtn.id = "vsdb-rename-analyze";
  analyzeBtn.addEventListener("click", () => {
    post({ type: "analyze", newName: input.value });
  });
  form.appendChild(analyzeBtn);

  const approveBtn = el("button", "vsdb-rename-approve", "Approve & Run");
  approveBtn.id = "vsdb-rename-approve";
  approveBtn.disabled = true; // enabled only after a clean analysis
  approveBtn.addEventListener("click", () => {
    state.approved = true;
    post({ type: "approve" });
  });
  form.appendChild(approveBtn);

  const cancelBtn = el("button", "vsdb-rename-cancel", "Cancel");
  cancelBtn.id = "vsdb-rename-cancel";
  cancelBtn.addEventListener("click", () => {
    post({ type: "cancel" });
    form.appendChild(el("div", "vsdb-rename-status", "Cancelling…"));
  });
  form.appendChild(cancelBtn);

  const analysis = el("div", "vsdb-rename-analysis");
  analysis.id = "vsdb-rename-analysis";
  form.appendChild(analysis);

  const progress = el("div", "vsdb-rename-progress");
  progress.id = "vsdb-rename-progress";
  form.appendChild(progress);

  root.appendChild(form);
}

function renderAnalysis(payload: {
  report: {
    views: Array<{ name: string; kind: string }>;
    fks: Array<{ constraint: string; fromTable: string }>;
    routines: Array<{ name: string }>;
    collisions: string[];
  };
  statements: string[];
  errors: string[];
}): void {
  const box = document.getElementById(
    "vsdb-rename-analysis",
  ) as HTMLDivElement | null;
  if (!box) return;
  box.textContent = "";

  const approveBtn = document.getElementById(
    "vsdb-rename-approve",
  ) as HTMLButtonElement | null;

  if (payload.errors.length > 0) {
    for (const e of payload.errors) line(box, `Error: ${e}`);
    if (approveBtn) approveBtn.disabled = true;
    return;
  }

  const r = payload.report;
  const usage = r.views.length + r.fks.length + r.routines.length;
  line(box, `Usage: ${usage} object(s) reference this ${state.mode}.`);
  for (const v of r.views) line(box, `View: ${v.name} (${v.kind})`);
  for (const f of r.fks) line(box, `FK: ${f.constraint} from ${f.fromTable}`);
  for (const rt of r.routines) line(box, `Routine: ${rt.name}`);
  for (const c of r.collisions) line(box, `Collision: ${c}`);

  const stmts = el("div", "vsdb-rename-statements");
  stmts.id = "vsdb-rename-statements";
  for (const s of payload.statements) line(stmts, s);
  box.appendChild(stmts);

  if (approveBtn) approveBtn.disabled = payload.statements.length === 0;
}

function renderProgress(payload: {
  index: number;
  total: number;
  statement: string;
}): void {
  const box = document.getElementById(
    "vsdb-rename-progress",
  ) as HTMLDivElement | null;
  if (!box) return;
  box.textContent = "";
  line(
    box,
    `Running ${payload.index + 1}/${payload.total}: ${payload.statement}`,
  );
}

function renderDone(payload: {
  applied: number;
  total: number;
  failedAt?: number;
  failedStatement?: string;
  error?: string;
  cancelled?: boolean;
  remaining?: number;
}): void {
  const box = document.getElementById(
    "vsdb-rename-progress",
  ) as HTMLDivElement | null;
  if (!box) return;
  box.textContent = "";
  if (payload.error !== undefined) {
    line(
      box,
      `FAILED after ${payload.applied} applied — statement ${payload.failedStatement ?? ""}: ${payload.error}`,
    );
    return;
  }
  if (payload.cancelled === true) {
    line(
      box,
      `Cancelled — ${payload.applied} applied, ${payload.remaining ?? 0} remaining.`,
    );
    return;
  }
  line(box, `Done — ${payload.applied} statement(s) applied.`);
}

// ---- host messages -----------------------------------------------------------

function isAnalysis(
  m: Record<string, unknown>,
): boolean {
  return m.type === "analysis";
}

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as Record<string, unknown>;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    state = {
      mode: msg.mode === "column" ? "column" : "table",
      schema: typeof msg.schema === "string" ? msg.schema : "",
      table: typeof msg.table === "string" ? msg.table : "",
      oldName: typeof msg.oldName === "string" ? msg.oldName : "",
      approved: false,
    };
    renderInit();
    return;
  }
  if (isAnalysis(msg)) {
    renderAnalysis(
      msg as unknown as Parameters<typeof renderAnalysis>[0],
    );
    return;
  }
  if (msg.type === "progress") {
    renderProgress(
      msg as unknown as Parameters<typeof renderProgress>[0],
    );
    return;
  }
  if (msg.type === "done") {
    renderDone(msg as unknown as Parameters<typeof renderDone>[0]);
    return;
  }
});

post({ type: "ready" });
