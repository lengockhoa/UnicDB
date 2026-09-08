// webview/aiChatPanelHeader.ts — TASK-AGTUI-003
//
// Claude Code–style header bar for the AI Chat webview: large BLUE "U"
// brand glyph, engine-aware title, and the AIX-05 session-state chip.
// Pure-DOM, no vscode imports — `renderHeader(root)` is wired into the
// live document by TASK-AGTUI-007.
//
// Engine label map is the LEGACY closed-set from `webview/aiChatPanelMain.ts`
// (the pinned 15-task-AGTUI-007-unmodified test contract). Anything outside
// the closed set falls back to `builtin` so the banner DOM class +
// textContent are never derived from a raw wire value (defense-in-depth
// against hostile / migrated / corrupted `name` payloads).

/** Closed union for the four engine values that the legacy banner accepts. */
export type HeaderEngine = "omp" | "claude-code" | "codex" | "builtin";

/** Closed union for the OMP turn-lifecycle session states (AIX-05). */
export type HeaderSessionState =
  | "connecting"
  | "running"
  | "done"
  | "error";

/** Legacy closed-set label map. Verbatim from `webview/aiChatPanelMain.ts:1437`. */
const ENGINE_LABELS: Readonly<Record<HeaderEngine, string>> = {
  "builtin": "builtin",
  "omp": "oh-my-pi (omp)",
  "claude-code": "Claude Code",
  "codex": "Codex",
};

/** Closed-set CSS-class suffix whitelist (mirrors legacy `safeEngineClassName`). */
function safeEngineClassName(rawName: unknown): HeaderEngine {
  switch (rawName) {
    case "omp":
    case "claude-code":
    case "codex":
    case "builtin":
      return rawName;
    default:
      return "builtin";
  }
}

/** Closed-set display label whitelist (mirrors legacy `safeEngineLabel`). */
function safeEngineLabel(rawName: unknown): HeaderEngine {
  return safeEngineClassName(rawName);
}

/** Lookup the label string for a (whitelisted) engine. */
function engineDisplayLabel(rawName: unknown): string {
  return ENGINE_LABELS[safeEngineLabel(rawName)];
}

/** The literal state string appended after the engine banner body. The legacy
 *  banner always used `"streaming"` (the engine is always live once rendered);
 *  per-call state lives on the `#sessionChip` element, not the banner. */
const STREAMING_STATE = "streaming";

/** Session state -> label (legacy map, pinned by
 *  aiChatPanelSessionStateWebview.test.ts:85-118). */
const SESSION_LABELS: Readonly<Record<HeaderSessionState, string>> = {
  connecting: "Connecting…",
  running: "Running…",
  done: "Done",
  error: "Error",
};

/** Build the engine banner body for a whitelisted engine.
 *  Format: `Engine: <label>[ v<version>] — streaming`
 *  (no version fragment when version is absent or empty). */
function buildBannerText(engine: HeaderEngine, version: string | undefined): string {
  const label = engineDisplayLabel(engine);
  const hasVersion = typeof version === "string" && version.length > 0;
  return hasVersion
    ? `Engine: ${label} v${version} — ${STREAMING_STATE}`
    : `Engine: ${label} — ${STREAMING_STATE}`;
}

export interface UnicDBHeader {
  /** Root element: `.UnicDB-chat-header`. Contains `#engineBanner`,
   *  `#chatBrandMark`, the static `.UnicDB-chat-title` node, and
   *  (when active) `#sessionChip`. */
  el: HTMLElement;

  /** Update the engine banner. `null` falls back to `builtin`. Unknown
   *  string values are also closed-mapped to `builtin` (never raw). */
  setEngine(name: HeaderEngine | null, version?: string): void;

  /** Update or remove the session-state chip. `null` removes the chip. */
  setSessionState(state: HeaderSessionState | null): void;
}

/**
 * Append a header bar to `root` and return its controller.
 *
 * Public so callers (TASK-AGTUI-007 wiring + tests) can call `setEngine` /
 * `setSessionState` after host events land. No event listeners are installed.
 */
export function renderHeader(root: HTMLElement): UnicDBHeader {
  // Root bar
  const el = document.createElement("div");
  el.className = "UnicDB-chat-header";

  // Brand glyph — plain text "U" (TASK-AGTUI-001 .UnicDB-chat-brand token
  // sizes + colors it BLUE at 28px+ sans-serif). No image/SVG asset.
  const brandMark = document.createElement("span");
  brandMark.id = "chatBrandMark";
  brandMark.className = "UnicDB-chat-brand";
  brandMark.textContent = "U";
  brandMark.setAttribute("aria-hidden", "true");
  brandMark.setAttribute("title", "UnicDB");
  el.appendChild(brandMark);

  // Static, hard-coded product title — NEVER wire-derived. The banner
  // already carries the engine info; this node is the persistent brand.
  const staticTitle = document.createElement("span");
  staticTitle.className = "UnicDB-chat-title";
  staticTitle.textContent = "UnicDB AI";
  el.appendChild(staticTitle);

  // Engine banner — id pinned by 15 tasks in
  // aiChatPanelWebview.test.ts:424-461,880-935 (TASK-AGTUI-007 must pass
  // UNMODIFIED).
  const banner = document.createElement("div");
  banner.id = "engineBanner";
  banner.textContent = "";
  el.appendChild(banner);

  // Mount into the host element.
  root.appendChild(el);

  // Module-scoped state refs (closed over by the controller methods).
  let chip: HTMLSpanElement | null = null;

  function setEngine(
    name: HeaderEngine | null | unknown,
    version?: string,
  ): void {
    const safe = safeEngineClassName(name);
    banner.className = `UnicDB-chat-engine UnicDB-chat-engine-${safe}`;
    banner.textContent = buildBannerText(safe, version);
  }

  function setSessionState(state: HeaderSessionState | null): void {
    if (state === null) {
      if (chip) {
        chip.remove();
        chip = null;
      }
      return;
    }
    if (!chip) {
      chip = document.createElement("span");
      chip.id = "sessionChip";
      // Live inside the header bar so it sits beside the banner.
      el.appendChild(chip);
    }
    // Legacy classes (`UnicDB-chat-session UnicDB-chat-session-<state>`)
    // remain pinned by aiChatPanelSessionStateWebview.test.ts:85-118.
    // The clone `UnicDB-chat-sessionchip` class is ADDITIVE — never a
    // replacement for the legacy pair.
    chip.className =
      `UnicDB-chat-session UnicDB-chat-session-${state}` +
      ` UnicDB-chat-sessionchip`;
    chip.textContent = SESSION_LABELS[state];
  }

  return { el, setEngine, setSessionState };
}
