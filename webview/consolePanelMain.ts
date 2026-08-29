// SQL Console v2 webview — TASK-AF-004 (cycle AF) + AIC-004 (cycle AIC).
// Tab bar, Run / Run Selection / Explain (Analyze) / Format / Save toolbar,
// ArrowUp/ArrowDown history recall, plan pane, context menu (TASK-002
// regression surface preserved). AIC-004: ghost-text autocomplete overlay
// — posts requestAutocomplete on input, renders a positioned escaped
// overlay (no textarea mutation), accepts via Tab/right-arrow at eligible
// caret, clears on edit / tab switch / dispose.
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

// ---- AIC-004 ghost-text state ---------------------------------------------
let ghostRequestSeq = 0;
let ghostRequestIdByTab = new Map<string, string>();
let ghostSuffixByTab = new Map<string, string>();
let ghostVisible = false;
let ghostEl: HTMLDivElement | null = null;
let ghostMirror: HTMLDivElement | null = null;

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
    <div class="vsdb-console-editor-wrap">
      <textarea id="consoleSqlEditor" class="vsdb-console-editor" rows="12" placeholder="Type SQL here…" spellcheck="false"></textarea>
      <div id="consoleGhostOverlay" class="vsdb-console-ghost" hidden aria-hidden="true"></div>
    </div>
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
  e?.addEventListener("input", () => {
    activeTab().buffer = e.value;
    requestGhost();
  });
  e?.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); hideContextMenu(); runCurrent(); return; }
    if (ev.key === "Tab" && ghostVisible && isGhostEligible(e)) {
      ev.preventDefault();
      acceptGhost();
      return;
    }
    if (ev.key === "ArrowRight" && ghostVisible && isGhostEligible(e)) {
      // Right-arrow at end of buffer (no selection) commits the suffix and
      // moves the caret to the end. We only post accept; the host updates
      // the buffer and posts state back, which triggers render() and the
      // caret lands naturally.
      acceptGhost();
      return;
    }
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
// ---- AIC-004 ghost-text functions -----------------------------------------

function requestGhost(): void {
  const e = editor();
  if (!e) return;
  ghostRequestSeq += 1;
  const requestId = `r${ghostRequestSeq}`;
  ghostRequestIdByTab.set(activeTabId, requestId);
  // Hide any visible ghost while a new request is in flight.
  clearGhostOverlay();
  post({
    type: "requestAutocomplete",
    tabId: activeTabId,
    requestId,
    cursorOffset: e.selectionStart,
    documentText: e.value,
  });
}

function isGhostEligible(e: HTMLTextAreaElement): boolean {
  // Eligible when the caret sits at the end of the buffer with no selection
  // — both Tab and right-arrow commit semantics. Other positions leave the
  // ghost visible but inert.
  return e.selectionStart === e.value.length && e.selectionEnd === e.value.length;
}

function acceptGhost(): void {
  const e = editor();
  if (!e) return;
  const requestId = ghostRequestIdByTab.get(activeTabId);
  const suffix = ghostSuffixByTab.get(activeTabId);
  if (!requestId || !suffix) return;
  // Mutate the local tab buffer (single source of truth) and let the
  // editor's input event re-fire, then post the accept for the host to
  // apply the same change atomically.
  activeTab().buffer = activeTab().buffer + suffix;
  e.value = activeTab().buffer;
  e.selectionStart = e.value.length;
  e.selectionEnd = e.value.length;
  post({ type: "acceptAutocomplete", tabId: activeTabId, requestId, suffix });
  clearGhostForTab(activeTabId);
}

function clearGhostOverlay(): void {
  ghostVisible = false;
  if (ghostEl) {
    ghostEl.textContent = "";
    ghostEl.hidden = true;
  }
}

function clearGhostForTab(tabId: string): void {
  ghostRequestIdByTab.delete(tabId);
  ghostSuffixByTab.delete(tabId);
  if (tabId === activeTabId) clearGhostOverlay();
}

function showGhostOverlay(suffix: string, caretOffset: number, fullText: string): void {
  if (!ghostEl) ghostEl = document.getElementById("consoleGhostOverlay") as HTMLDivElement | null;
  if (!ghostEl) return;
  // Escape via textContent — overlay is plain text, never interpreted.
  ghostEl.textContent = suffix;
  ghostEl.hidden = false;
  ghostVisible = true;
  positionGhost(caretOffset, fullText);
}

function positionGhost(caretOffset: number, fullText: string): void {
  const e = editor();
  if (!e || !ghostEl) return;
  // Use a text-mirror to compute caret pixel offset within the textarea.
  if (!ghostMirror) {
    const mirror = document.createElement("div");
    mirror.className = "vsdb-console-ghost-mirror";
    mirror.setAttribute("aria-hidden", "true");
    document.body.appendChild(mirror);
    ghostMirror = mirror;
  }
  const m = ghostMirror;
  const style = getComputedStyle(e);
  m.style.font = style.font;
  m.style.lineHeight = style.lineHeight;
  m.style.padding = style.padding;
  m.style.border = style.border;
  m.style.boxSizing = style.boxSizing;
  m.style.whiteSpace = "pre-wrap";
  m.style.wordWrap = "break-word";
  m.style.width = `${e.clientWidth}px`;
  m.textContent = fullText.slice(0, caretOffset);
  // The trailing span holds a zero-width marker so we can read offsetLeft.
  const span = document.createElement("span");
  span.textContent = "\u200b";
  m.appendChild(span);
  const rect = e.getBoundingClientRect();
  const mirrorRect = m.getBoundingClientRect();
  const left = span.offsetLeft - e.scrollLeft;
  const top = span.offsetTop - e.scrollTop;
  ghostEl.style.left = `${left}px`;
  ghostEl.style.top = `${top}px`;
  // Mirror dimensions must match the textarea so coordinates agree.
  void rect;
  void mirrorRect;
  // The mirror is hidden — only used to measure.
  m.style.position = "absolute";
  m.style.visibility = "hidden";
  m.style.left = "-9999px";
  m.style.top = "0";
}

window.addEventListener("message", (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "state" && Array.isArray(msg.tabs)) {
    // Tab registry or active tab changed → clear ghost for the previous tab.
    const prev = activeTabId;
    tabs = msg.tabs as unknown as Tab[];
    activeTabId = typeof msg.activeTabId === "string"
      ? msg.activeTabId
      : (tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? activeTabId);
    if (prev !== activeTabId) {
      // Tab switch — drop the ghost entirely.
      clearGhostForTab(prev);
      clearGhostOverlay();
    }
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
  // AIC-004 — autocomplete result.
  if (msg.type === "autocompleteResult" && typeof msg.tabId === "string") {
    const tabId = msg.tabId as string;
    const currentRequestId = ghostRequestIdByTab.get(activeTabId);
    if (msg.requestId !== currentRequestId) return;
    if (msg.suffix === null || msg.suffix === undefined || (typeof msg.suffix === "string" && msg.suffix.length === 0)) {
      ghostSuffixByTab.delete(tabId);
      clearGhostOverlay();
      return;
    }
    const suffix = msg.suffix as string;
    ghostSuffixByTab.set(tabId, suffix);
    if (tabId !== activeTabId) return;
    const e = editor();
    if (!e) return;
    showGhostOverlay(suffix, e.selectionStart, e.value);
    return;
  }
  if (msg.type === "autocompleteClear" && typeof msg.tabId === "string") {
    clearGhostForTab(msg.tabId as string);
    return;
  }
});
render();
export {};
