// webview/consolePanelMain.ts — TASK-002
// DataGrip-style SQL Console browser entry: empty SQL textarea, Run / Save
// toolbar controls, Cmd/Ctrl+Enter execution, and an in-webview right-click
// menu offering "Save as SQL file". TASK-003 owns the host panel HTML/CSP
// that loads this bundle plus dist/webview.css.
//
// Protocol: src/ui/consolePanelMessages.ts (TASK-001). Message shapes are
// mirrored structurally here — a `../src/...` import would add a TS6059
// rootDir error to the per-file webview tsc gate (same policy as main.ts).
//
// SECURITY: this entry only POSTS runConsole/saveConsoleAsSql with the raw
// editor text. The host MUST pass every inbound message through
// isConsoleToHostMessage before routing; no other message type is emitted,
// and none of the host's messages are consumed by this panel yet.

declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

// ---- Webview → Host message shapes (mirror of consolePanelMessages.ts) -----

interface RunConsoleMsg {
  type: "runConsole";
  sql: string;
}
interface SaveConsoleAsSqlMsg {
  type: "saveConsoleAsSql";
  sql: string;
}
type ConsoleToHostMsg = RunConsoleMsg | SaveConsoleAsSqlMsg;

const root = document.getElementById("vsdb-root") as HTMLDivElement;

function post(msg: ConsoleToHostMsg): void {
  vscodeApi?.postMessage(msg);
}

/** Editor text as sent on the wire: verbatim payload, trimmed for the
 * emptiness gate so whitespace-only content never reaches the host. */
function currentSql(): string {
  const editor = document.getElementById(
    "consoleSqlEditor",
  ) as HTMLTextAreaElement | null;
  return editor ? editor.value : "";
}

function postRun(): void {
  const sql = currentSql();
  if (sql.trim().length === 0) return;
  post({ type: "runConsole", sql });
}

function postSave(): void {
  const sql = currentSql();
  if (sql.trim().length === 0) return;
  post({ type: "saveConsoleAsSql", sql });
}

// ---- Custom context menu ----------------------------------------------------

/** The menu node is created up-front (hidden) so the DOM contract — a
 * `.vsdb-console-contextmenu` element present from the first render — holds
 * before any right-click, and so the document-level dismissers (click-away,
 * Escape) are bound exactly once for the panel's lifetime. */
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
  // Snapshot the SQL at click time; empty executions are ignored exactly
  // like the toolbar Save.
  saveItem.addEventListener("click", () => {
    postSave();
    hideContextMenu();
  });
  menu.appendChild(saveItem);
  root.appendChild(menu);
  // Click anywhere else closes the menu (capture phase, before item
  // handlers — clicks ON the menu stop bubbling via contains() guard).
  document.addEventListener(
    "click",
    (ev) => {
      if (
        !menu.hidden &&
        ev.target instanceof Node &&
        !menu.contains(ev.target)
      ) {
        menu.hidden = true;
      }
    },
    true,
  );
  // Escape closes an open menu. Capture phase mirrors main.ts's overlay
  // keydown handling; targeted at the key only when something is open.
  document.addEventListener(
    "keydown",
    (ev: KeyboardEvent) => {
      if (!menu.hidden && ev.key === "Escape") {
        menu.hidden = true;
        ev.stopPropagation();
      }
    },
    true,
  );
  contextMenu = menu;
  return menu;
}

function hideContextMenu(): void {
  if (contextMenu && !contextMenu.hidden) contextMenu.hidden = true;
}

// ---- Rendering --------------------------------------------------------------

function renderInitial(): void {
  root.innerHTML = `
  <div class="vsdb-console">
    <div class="vsdb-console-toolbar">
      <button id="consoleRunBtn" class="vsdb-console-primary" title="Run (Cmd/Ctrl+Enter)">Run</button>
      <button id="consoleSaveBtn" class="vsdb-console-secondary" title="Save as SQL file">Save</button>
    </div>
    <textarea id="consoleSqlEditor" class="vsdb-console-editor" rows="12"
      placeholder="Type SQL here…" spellcheck="false"></textarea>
  </div>`;
  ensureContextMenu();
  wireControls();
}

function wireControls(): void {
  const editor = document.getElementById(
    "consoleSqlEditor",
  ) as HTMLTextAreaElement | null;
  const runBtn = document.getElementById(
    "consoleRunBtn",
  ) as HTMLButtonElement | null;
  const saveBtn = document.getElementById(
    "consoleSaveBtn",
  ) as HTMLButtonElement | null;

  runBtn?.addEventListener("click", () => {
    postRun();
  });

  saveBtn?.addEventListener("click", () => {
    postSave();
  });

  // Cmd/Ctrl+Enter executes and dismisses the right-click menu first, so a
  // keyboard run never leaves the stale menu hovering over results.
  // preventDefault keeps the keystroke from inserting a newline into the
  // textarea; plain Enter types normally.
  editor?.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      ev.preventDefault();
      hideContextMenu();
      postRun();
    }
  });

  // In-webview right-click menu replaces the browser menu on the editor.
  // The menu itself is a singleton (ensureContextMenu reuses one node), so
  // repeated right-clicks reposition it instead of stacking copies.
  editor?.addEventListener("contextmenu", (ev: MouseEvent) => {
    ev.preventDefault();
    const menu = ensureContextMenu();
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    menu.hidden = false;
  });
}

// ---- Boot ------------------------------------------------------------------
renderInitial();

/** Module marker (see header): keeps this entry out of the webview combined
 * tsc program's global-scope collision set — script-style entries are what
 * produce the 25 pre-existing TS2451/TS2393 errors there; module entries
 * contribute zero. */
export {};
