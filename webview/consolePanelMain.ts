// SQL Console v2 webview — TASK-AF-004 (cycle AF).
// Tab bar, Run / Run Selection / Explain (Analyze) / Format / Save toolbar,
// ArrowUp/ArrowDown history recall, plan pane, context menu (TASK-002
// regression surface preserved).
declare const acquireVsCodeApi: undefined | (() => { postMessage: (msg: unknown) => void });
const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

type Msg = Record<string, unknown>;
interface Tab { id: string; name: string; buffer: string; active?: boolean }
const root = document.getElementById("vsdb-root") as HTMLDivElement;
let tabs: Tab[] = [{ id: "tab-1", name: "Query 1", buffer: "", active: true }];
let activeTabId = "tab-1";
let history: string[] = [];
let historyIndex = -1;
let plan = "";

function post(msg: Msg): void { vscodeApi?.postMessage(msg); }
function activeTab(): Tab { return tabs.find((t) => t.id === activeTabId) ?? tabs[0]; }
function editor(): HTMLTextAreaElement | null { return document.getElementById("consoleSqlEditor") as HTMLTextAreaElement | null; }
function syncBuffer(): void { const e = editor(); if (e) activeTab().buffer = e.value; }

// ---- Context menu (TASK-002 regression surface) ----------------------------
let contextMenu: HTMLDivElement | null = null;
function ensureContextMenu(): HTMLDivElement {
  if (contextMenu) return contextMenu;
  const menu = document.createElement("div");
  menu.className = "vsdb-console-contextmenu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const saveItem = document.createElement("button");
  saveItem.type = "button";
  saveItem.className = "vsdb-console-context-item";
  saveItem.setAttribute("role", "menuitem");
  saveItem.textContent = "Save as SQL file";
  saveItem.addEventListener("click", () => {
    syncBuffer();
    const b = activeTab().buffer;
    if (b.trim()) post({ type: "saveConsoleAsSql", sql: b });
    hideContextMenu();
  });
  menu.appendChild(saveItem);
  root.appendChild(menu);
  document.addEventListener("click", (ev) => {
    if (!menu.hidden && ev.target instanceof Node && !menu.contains(ev.target)) menu.hidden = true;
  }, true);
  document.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (!menu.hidden && ev.key === "Escape") { menu.hidden = true; ev.stopPropagation(); }
  }, true);
  contextMenu = menu;
  return menu;
}
function hideContextMenu(): void { if (contextMenu && !contextMenu.hidden) contextMenu.hidden = true; }

// ---- Render ------------------------------------------------------------------
function render(): void {
  const a = activeTab();
  root.innerHTML = `<div class="vsdb-console">
    <div class="vsdb-console-tabs" role="tablist"></div>
    <div class="vsdb-console-toolbar">
      <button id="consoleRunBtn" class="vsdb-console-primary" title="Run (Cmd/Ctrl+Enter)">Run</button>
      <button id="consoleRunSelectionBtn" class="vsdb-console-secondary">Run Selection</button>
      <button id="consoleExplainBtn" class="vsdb-console-secondary">Explain</button>
      <button id="consoleExplainAnalyzeBtn" class="vsdb-console-secondary">Explain Analyze</button>
      <button id="consoleFormatBtn" class="vsdb-console-secondary">Format</button>
      <button id="consoleSaveBtn" class="vsdb-console-secondary">Save</button>
      <button id="consoleNewTabBtn" class="vsdb-console-secondary">+ Tab</button>
      <button id="consoleHistoryBtn" class="vsdb-console-secondary">History</button>
    </div>
    <textarea id="consoleSqlEditor" class="vsdb-console-editor" rows="12" placeholder="Type SQL here…" spellcheck="false"></textarea>
    <pre id="consolePlanPane" class="vsdb-console-plan" hidden></pre>
    <div id="consoleHistoryPane" class="vsdb-console-history" hidden></div>
  </div>`;
  const e = editor();
  if (e) e.value = a?.buffer ?? "";
  renderTabs();
  wireControls();
  const p = document.getElementById("consolePlanPane") as HTMLElement | null;
  if (p && plan) { p.hidden = false; p.textContent = plan; }
  // The menu node exists from the first render (TASK-002 DOM contract:
  // `.vsdb-console-contextmenu` present, hidden, before any right-click).
  ensureContextMenu();
}
function renderTabs(): void {
  const bar = document.querySelector(".vsdb-console-tabs") as HTMLElement | null;
  if (!bar) return;
  bar.innerHTML = "";
  for (const tab of tabs) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `vsdb-console-tab${tab.id === activeTabId ? " vsdb-console-tab-active" : ""}`;
    node.setAttribute("role", "tab");
    node.textContent = tab.name;
    node.addEventListener("click", () => { syncBuffer(); post({ type: "switchTab", tabId: tab.id }); });
    const close = document.createElement("span");
    close.className = "vsdb-console-tab-close";
    close.textContent = "×";
    close.addEventListener("click", (ev) => { ev.stopPropagation(); post({ type: "closeTab", tabId: tab.id }); });
    node.appendChild(close);
    bar.appendChild(node);
  }
}
function runCurrent(): void {
  syncBuffer();
  const e = editor();
  if (!e || !e.value.trim()) return;
  if (e.selectionStart !== e.selectionEnd) {
    post({ type: "runSelection", tabId: activeTabId, text: e.value.slice(e.selectionStart, e.selectionEnd) });
  } else {
    post({ type: "runConsole", sql: e.value });
  }
}
function wireControls(): void {
  const e = editor();
  document.getElementById("consoleRunBtn")?.addEventListener("click", () => runCurrent());
  document.getElementById("consoleRunSelectionBtn")?.addEventListener("click", () => {
    syncBuffer();
    if (e && e.selectionStart !== e.selectionEnd) {
      post({ type: "runSelection", tabId: activeTabId, text: e.value.slice(e.selectionStart, e.selectionEnd) });
    }
  });
  document.getElementById("consoleExplainBtn")?.addEventListener("click", () => {
    syncBuffer();
    if (activeTab().buffer.trim()) post({ type: "explain", tabId: activeTabId, sql: activeTab().buffer, analyze: false });
  });
  document.getElementById("consoleExplainAnalyzeBtn")?.addEventListener("click", () => {
    syncBuffer();
    if (activeTab().buffer.trim()) post({ type: "explain", tabId: activeTabId, sql: activeTab().buffer, analyze: true });
  });
  document.getElementById("consoleFormatBtn")?.addEventListener("click", () => {
    syncBuffer();
    if (activeTab().buffer.trim()) post({ type: "format", tabId: activeTabId });
  });
  document.getElementById("consoleSaveBtn")?.addEventListener("click", () => {
    syncBuffer();
    if (activeTab().buffer.trim()) post({ type: "saveConsoleAsSql", sql: activeTab().buffer });
  });
  document.getElementById("consoleNewTabBtn")?.addEventListener("click", () => post({ type: "createTab" }));
  document.getElementById("consoleHistoryBtn")?.addEventListener("click", () => {
    post({ type: "historyList" });
    const h = document.getElementById("consoleHistoryPane") as HTMLElement;
    h.hidden = !h.hidden;
    renderHistory();
  });
  e?.addEventListener("input", () => { activeTab().buffer = e.value; });
  e?.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); hideContextMenu(); runCurrent(); return; }
    // History recall: only when the caret is at an edge and nothing is selected.
    if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && e.selectionStart === e.selectionEnd && history.length > 0) {
      const atStart = ev.key === "ArrowUp" && e.selectionStart === 0;
      const atEnd = ev.key === "ArrowDown" && e.selectionStart === e.value.length;
      if (!atStart && !atEnd) return;
      ev.preventDefault();
      historyIndex = ev.key === "ArrowUp"
        ? (historyIndex + 1) % history.length
        : (historyIndex - 1 + history.length) % history.length;
      e.value = history[historyIndex];
      activeTab().buffer = e.value;
    }
  });
  // In-webview right-click menu on the editor.
  e?.addEventListener("contextmenu", (ev: MouseEvent) => {
    ev.preventDefault();
    const menu = ensureContextMenu();
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    menu.hidden = false;
  });
}
function renderHistory(): void {
  const h = document.getElementById("consoleHistoryPane") as HTMLElement | null;
  if (!h) return;
  h.innerHTML = "";
  history.forEach((sql, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "vsdb-console-history-item";
    b.textContent = sql;
    b.addEventListener("click", () => {
      const ed = editor();
      if (ed) { ed.value = sql; activeTab().buffer = sql; }
      historyIndex = i;
    });
    h.appendChild(b);
  });
}
window.addEventListener("message", (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "state" && Array.isArray(msg.tabs)) {
    tabs = msg.tabs as unknown as Tab[];
    activeTabId = typeof msg.activeTabId === "string"
      ? msg.activeTabId
      : (tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? activeTabId);
    history = Array.isArray(msg.history) ? msg.history.filter((x): x is string => typeof x === "string") : history;
    render();
    return;
  }
  if (msg.type === "historyList" && Array.isArray(msg.items)) {
    history = msg.items.filter((x): x is string => typeof x === "string");
    renderHistory();
    return;
  }
  if (msg.type === "explainResult") {
    plan = typeof msg.plan === "string" ? msg.plan : "";
    const p = document.getElementById("consolePlanPane") as HTMLElement | null;
    if (p) { p.hidden = false; p.textContent = typeof msg.error === "string" ? msg.error : plan; }
  }
});
render();
export {};
