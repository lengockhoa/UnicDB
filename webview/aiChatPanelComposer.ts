// webview/aiChatPanelComposer.ts — TASK-AGTUI-004
//
// Claude Code-style sticky composer: attach strip + multiline textarea +
// bottom control row (`+` attach, model chip dropdown, `/` slash
// affordance, bypass-permissions toggle default OFF, mic placeholder,
// send button that swaps to a red square stop while busy) plus the three
// legacy icon-only action buttons (#resumeBtn / #clearBtn / #regenerateBtn)
// that live HERE per the PLAN §3 element-id contract.
//
// No `vscode` import; pure DOM. All consumer wiring flows through the
// `ComposerCallbacks` handle. The host (TASK-AGTUI-007 aiChatPanelMain.ts)
// owns slash interception, mention dropdown, liveTurnPending, and bubble
// echo — this module only emits intent and lets main keep its existing
// flow.
//
// CSS class hooks come from webview/styles.css (TASK-AGTUI-001).

export interface ComposerAttachment {
  id: string;
  mime: string;
  base64: string;
  bytes: number;
}

export interface ComposerModelEntry {
  role: string;
  modelId: string;
  vision: boolean;
}

export interface ComposerCallbacks {
  onSend(text: string, attachments: ComposerAttachment[]): void;
  onStop(): void;
  onModelSelect(role: string): void;
  onBypassChange(enabled: boolean): void;
  onAttachPicker(): void; // "+" click — main owns the hidden file input
}

export interface UnicDBComposer {
  el: HTMLElement;
  setBusy(busy: boolean): void;
  setModels(entries: ComposerModelEntry[], active: string): void;
  setBypass(enabled: boolean): void;
  setVisionCapable(capable: boolean): void;
  value(): string;
  setValue(v: string): void;
  attachments(): ComposerAttachment[];
  addAttachments(files: FileList): void;
  clearAttachments(): void;
}

/** Returns a fresh id usable for tracking attachments in the strip. */
function freshId(): string {
  return `att-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** Reads a File into a base64 payload. */
function fileToAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<payload>"
      const comma = result.indexOf(",");
      const header = result.slice(5, comma); // "data:" stripped
      const mime = header.split(";")[0] || file.type || "application/octet-stream";
      const base64 = result.slice(comma + 1);
      resolve({
        id: freshId(),
        mime,
        base64,
        bytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Builds a 16×16 inline SVG icon-only button with title + aria-label. */
function iconButton(
  id: string,
  label: string,
  svgInner: string,
  extraClass = "",
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = `UnicDB-chat-actions-btn ${extraClass}`.trim();
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML =
    `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" ` +
    `fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ` +
    `stroke-linejoin="round">${svgInner}</svg>`;
  return b;
}

/** Builds a small text label used inside the chip trigger. */
function buildChipLabel(active: ComposerModelEntry | null): string {
  if (!active) return "No models configured";
  return `${active.role} · ${active.modelId}`;
}

/**
 * Render the composer into `root`. The returned handle exposes the
 * imperative surface consumed by `webview/aiChatPanelMain.ts`.
 */
export function renderComposer(
  root: HTMLElement,
  cb: ComposerCallbacks,
): UnicDBComposer {
  // --- DOM scaffold -------------------------------------------------------
  const wrap = document.createElement("div");
  wrap.className = "UnicDB-chat-composer";

  // Attach strip — sits above the textarea, scrollable horizontally.
  const attachStrip = document.createElement("div");
  attachStrip.id = "attachStrip";
  attachStrip.className = "UnicDB-chat-attachments";
  attachStrip.setAttribute("aria-label", "Attachments");
  wrap.appendChild(attachStrip);

  // Input column — textarea takes the bulk of the height.
  const inputCol = document.createElement("div");
  inputCol.className = "UnicDB-chat-input";
  wrap.appendChild(inputCol);

  const prompt = document.createElement("textarea");
  prompt.id = "prompt";
  prompt.className = "UnicDB-chat-textarea";
  prompt.rows = 3;
  prompt.placeholder = "Ask anything — Shift+Enter for newline";
  prompt.spellcheck = false;
  prompt.setAttribute("aria-label", "Prompt");
  inputCol.appendChild(prompt);

  // Bottom row: action buttons live here (legacy + new affordances).
  const actions = document.createElement("div");
  actions.className = "UnicDB-chat-actions";
  inputCol.appendChild(actions);

  // --- Legacy action buttons (live HERE per PLAN §3 id contract) -----------
  // Order: resume · clear · regenerate (legacy grouping), then chip + slash +
  // bypass + mic + attach + send.
  const resumeBtn = iconButton(
    "resumeBtn",
    "Resume session",
    // history / clock-rewind — arc + rewind arrow + clock hands.
    '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" />' +
      '<path d="M3.5 3.5 V6.5 H6.5" />' +
      '<path d="M8 5.5 V8 L9.8 9.5" />',
  );
  actions.appendChild(resumeBtn);

  const clearBtn = iconButton(
    "clearBtn",
    "Clear conversation",
    // trash — lid + body + handle.
    '<path d="M3 5 H13" />' +
      '<path d="M5 5 V13 a1 1 0 0 0 1 1 h4 a1 1 0 0 0 1 -1 V5" />' +
      '<path d="M6 5 V3.5 a0.5 0.5 0 0 1 0.5 -0.5 h3 a0.5 0.5 0 0 1 0.5 0.5 V5" />' +
      '<path d="M6.8 7.5 V11.5" />' +
      '<path d="M9.2 7.5 V11.5" />',
  );
  actions.appendChild(clearBtn);

  const regenerateBtn = iconButton(
    "regenerateBtn",
    "Regenerate",
    // counter-clockwise return arrow.
    '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" />' +
      '<path d="M12.5 3.5 V6.5 H9.5" />',
  );
  actions.appendChild(regenerateBtn);

  // Visual divider before the new affordances (purely cosmetic).
  const sep = document.createElement("div");
  sep.className = "UnicDB-chat-actions-sep";
  sep.setAttribute("aria-hidden", "true");
  actions.appendChild(sep);

  // --- Model chip dropdown -------------------------------------------------
  const chipBtn = document.createElement("button");
  chipBtn.type = "button";
  chipBtn.id = "modelChipBtn";
  chipBtn.className = "UnicDB-chat-chip";
  chipBtn.setAttribute("aria-haspopup", "listbox");
  chipBtn.setAttribute("aria-label", "Select model");
  chipBtn.title = "Select model";
  chipBtn.textContent = "No models configured";
  actions.appendChild(chipBtn);

  // The menu is appended to the wrap so it can be positioned absolutely.
  const chipMenu = document.createElement("div");
  chipMenu.className = "UnicDB-chat-chipmenu";
  chipMenu.setAttribute("role", "listbox");
  chipMenu.id = "modelChipMenu";
  chipMenu.style.display = "none";
  wrap.appendChild(chipMenu);

  // --- Slash affordance (`/N`) --------------------------------------------
  const slashHintBtn = document.createElement("button");
  slashHintBtn.type = "button";
  slashHintBtn.id = "slashHintBtn";
  slashHintBtn.className = "UnicDB-chat-slash-hint";
  slashHintBtn.textContent = "/";
  slashHintBtn.setAttribute("aria-label", "Insert slash command");
  slashHintBtn.title = "Insert slash command";
  actions.appendChild(slashHintBtn);

  // --- Bypass-permissions toggle (default OFF) ----------------------------
  const bypassToggle = document.createElement("button");
  bypassToggle.type = "button";
  bypassToggle.id = "bypassToggle";
  bypassToggle.className = "UnicDB-chat-toggle";
  bypassToggle.setAttribute("role", "switch");
  bypassToggle.setAttribute("aria-checked", "false");
  bypassToggle.setAttribute("aria-label", "Bypass permissions");
  bypassToggle.title = "Bypass permissions (session only)";
  bypassToggle.textContent = "Bypass";
  actions.appendChild(bypassToggle);

  // --- Mic placeholder ----------------------------------------------------
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.id = "micBtn";
  micBtn.className = "UnicDB-chat-mic";
  micBtn.disabled = true;
  micBtn.setAttribute("aria-label", "Voice input (coming soon)");
  micBtn.title = "Voice input (coming soon)";
  micBtn.innerHTML =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" ' +
    'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
    'stroke-linejoin="round">' +
    '<rect x="6" y="2" width="4" height="7" rx="2" />' +
    '<path d="M3.5 8a4.5 4.5 0 0 0 9 0" />' +
    '<path d="M8 12.5 V14.5" />' +
    "</svg>";
  actions.appendChild(micBtn);

  // --- Attach + send / stop (busy swap) -----------------------------------
  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.id = "attachBtn";
  attachBtn.className = "UnicDB-chat-attach-btn";
  attachBtn.setAttribute("aria-label", "Attach image");
  attachBtn.title = "Attach image";
  attachBtn.innerHTML =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" ' +
    'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
    'stroke-linejoin="round">' +
    '<path d="M14.3 7.4 8.2 13.5a4 4 0 0 1-5.7-5.7l5.7-5.7A2.7 2.7 0 1 1 12 5.9l-5.7 5.7a1.4 1.4 0 0 1-1.9-1.9l5.7-5.7" />' +
    "</svg>";
  actions.appendChild(attachBtn);

  const sendBtn = iconButton(
    "sendBtn",
    "Send",
    // paper plane — classic send glyph with fold line.
    '<path d="M14.7 1.3 7.3 8.7" />' +
      '<path d="M14.7 1.3 10 14.7 7.3 8.7 1.3 6 14.7 1.3 Z" />',
    "UnicDB-chat-primary",
  );
  actions.appendChild(sendBtn);

  const stopBtn = iconButton(
    "stopBtn",
    "Stop",
    '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />',
    "UnicDB-chat-stop",
  );
  stopBtn.style.display = "none";
  stopBtn.setAttribute("aria-label", "Stop generation");
  actions.appendChild(stopBtn);

  // Mount.
  root.appendChild(wrap);

  // --- Mutable runtime state ----------------------------------------------
  let busy = false;
  let bypassOn = false;
  let visionCapable = true;
  let models: ComposerModelEntry[] = [];
  let activeRole = "work";
  const atts: ComposerAttachment[] = [];

  // --- Helpers ------------------------------------------------------------
  function renderChipMenu(): void {
    chipMenu.innerHTML = "";
    if (models.length === 0) return;
    for (const m of models) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "UnicDB-chat-chipmenu-row";
      row.dataset.role = m.role;
      row.setAttribute("role", "option");
      row.textContent = `${m.role} · ${m.modelId}`;
      if (m.role === activeRole) {
        row.classList.add("UnicDB-chat-chipmenu-row-active");
        row.setAttribute("aria-selected", "true");
      }
      row.addEventListener("click", () => {
        activeRole = m.role;
        closeChipMenu();
        cb.onModelSelect(m.role);
      });
      chipMenu.appendChild(row);
    }
  }

  function refreshChipLabel(): void {
    const active = models.find((m) => m.role === activeRole) ?? null;
    chipBtn.textContent = buildChipLabel(active);
    chipBtn.disabled = models.length === 0;
  }

  function openChipMenu(): void {
    if (models.length === 0) return;
    renderChipMenu();
    chipMenu.style.display = "flex";
  }

  function closeChipMenu(): void {
    chipMenu.style.display = "none";
    chipMenu.innerHTML = "";
  }

  function applyBypassVisual(): void {
    bypassToggle.setAttribute("aria-checked", bypassOn ? "true" : "false");
    bypassToggle.classList.toggle("UnicDB-chat-toggle-on", bypassOn);
    bypassToggle.style.background = bypassOn ? "#f59e0b" : "#3b82f6";
    bypassToggle.style.color = bypassOn ? "#1f1300" : "#ffffff";
    bypassToggle.style.border = "1px solid transparent";
  }

  function applyBusyVisual(): void {
    if (busy) {
      sendBtn.style.display = "none";
      sendBtn.disabled = true;
      stopBtn.style.display = "inline-flex";
      stopBtn.disabled = false;
      stopBtn.classList.add("UnicDB-chat-stop-live");
      prompt.disabled = true;
    } else {
      sendBtn.style.display = "inline-flex";
      sendBtn.disabled = false;
      stopBtn.style.display = "none";
      stopBtn.disabled = false;
      stopBtn.classList.remove("UnicDB-chat-stop-live");
      prompt.disabled = false;
    }
    // Apply legacy contract: send/resume/regenerate/attach disabled while
    // busy; clearBtn is untouched.
    resumeBtn.disabled = busy;
    regenerateBtn.disabled = busy;
    // Attach: disabled while busy OR when the active model can't see
    // images (mirrors aiChatPanelMain.ts:466-478).
    attachBtn.disabled = busy || !visionCapable;
  }

  function rerenderAttachStrip(): void {
    attachStrip.innerHTML = "";
    for (const a of atts) {
      const thumb = document.createElement("div");
      thumb.className = "UnicDB-chat-thumb";
      thumb.dataset.id = a.id;
      if (a.mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = `data:${a.mime};base64,${a.base64}`;
        img.alt = a.mime;
        thumb.appendChild(img);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "UnicDB-chat-thumb-remove";
      rm.setAttribute("aria-label", "Remove attachment");
      rm.title = "Remove attachment";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        const idx = atts.findIndex((x) => x.id === a.id);
        if (idx >= 0) atts.splice(idx, 1);
        rerenderAttachStrip();
      });
      thumb.appendChild(rm);
      attachStrip.appendChild(thumb);
    }
  }

  // --- Wiring -------------------------------------------------------------
  sendBtn.addEventListener("click", () => {
    const text = prompt.value.trim();
    if (!text) return; // #6 — empty/whitespace guard
    cb.onSend(text, atts.slice());
  });

  stopBtn.addEventListener("click", () => {
    cb.onStop();
  });

  bypassToggle.addEventListener("click", () => {
    bypassOn = !bypassOn;
    applyBypassVisual();
    cb.onBypassChange(bypassOn);
  });

  attachBtn.addEventListener("click", () => {
    cb.onAttachPicker();
  });

  slashHintBtn.addEventListener("click", () => {
    // Insert a leading "/" if the textarea is empty; otherwise place "/" at
    // the current caret position. Then focus the textarea so the user can
    // type the command name. Dropdown behavior stays in main (TASK-AGTUI-007).
    const cur = prompt.value;
    const start = prompt.selectionStart ?? cur.length;
    const end = prompt.selectionEnd ?? start;
    const next = cur.slice(0, start) + "/" + cur.slice(end);
    prompt.value = next;
    const caret = start + 1;
    prompt.focus();
    try {
      prompt.setSelectionRange(caret, caret);
    } catch {
      // ignore — some jsdom versions disallow selection on textareas
    }
  });

  chipBtn.addEventListener("click", () => {
    if (models.length === 0) return;
    if (chipMenu.style.display === "none" || chipMenu.style.display === "") {
      openChipMenu();
    } else {
      closeChipMenu();
    }
  });

  // Outside-click + Escape close the menu.
  document.addEventListener("click", (ev) => {
    const t = ev.target as Node | null;
    if (!t) return;
    if (!wrap.contains(t)) {
      closeChipMenu();
      return;
    }
    if (chipMenu.style.display !== "none" && !chipMenu.contains(t) && t !== chipBtn) {
      closeChipMenu();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && chipMenu.style.display !== "none") {
      closeChipMenu();
    }
  });

  // Enter-to-send (Shift+Enter for newline) — mirrors Claude Code behavior.
  prompt.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const text = prompt.value.trim();
      if (!text) return;
      cb.onSend(text, atts.slice());
    }
  });

  // Initial visuals.
  applyBypassVisual();
  applyBusyVisual();

  return {
    el: wrap,
    setBusy(v: boolean): void {
      busy = v;
      applyBusyVisual();
    },
    setModels(entries: ComposerModelEntry[], active: string): void {
      models = entries.slice();
      activeRole = active;
      refreshChipLabel();
      if (chipMenu.style.display !== "none") renderChipMenu();
    },
    setBypass(enabled: boolean): void {
      bypassOn = enabled;
      applyBypassVisual();
    },
    setVisionCapable(capable: boolean): void {
      visionCapable = capable;
      applyBusyVisual();
    },
    value(): string {
      return prompt.value;
    },
    setValue(v: string): void {
      prompt.value = v;
    },
    attachments(): ComposerAttachment[] {
      return atts.slice();
    },
    addAttachments(files: FileList): void {
      const promises: Array<Promise<ComposerAttachment>> = [];
      for (let i = 0; i < files.length; i++) {
        const f = files.item(i);
        if (!f) continue;
        promises.push(fileToAttachment(f));
      }
      void Promise.all(promises).then((parsed) => {
        atts.push(...parsed);
        rerenderAttachStrip();
      });
    },
    clearAttachments(): void {
      atts.length = 0;
      rerenderAttachStrip();
    },
  };
}