// webview/aiChat/permissions.ts — TASK-CHATV2-014
//
// The permission POLICY control and the anchored permission REQUEST sheet.
//
// OWNERSHIP
// - Policy state is the HOST's. This module renders the policy it is told and
//   reports INTENT (open the bypass warning, enable bypass) through callbacks.
//   It never persists anything and never assumes the policy changed: the
//   caller adopts the new policy only after the host acknowledges the
//   `set_permission_policy` intent with a `permission_policy` frame.
// - The request sheet ECHOES opaque ids. `requestId` is host-generated and is
//   NEVER rendered into the DOM (it would leak a token into markup); it is
//   only carried by the single response object. An answer is emitted at most
//   once per request — every button disables the sheet before invoking the
//   callback, and a settled/replaced sheet is inert.
//
// SECURITY
// - Every label/detail is written with `textContent`. A hostile tool name or
//   detail renders as text and can never create an element, attribute or
//   class.
// - Escape NEVER approves. On an ordinary request Escape maps to Deny only
//   when the host contract explicitly says so (`escapeChoosesDeny`); on a
//   destructive/high-impact request Escape opens an explicit deny CONFIRMATION
//   whose default focus is the safe "keep waiting" choice.
// - The bypass warning is a MODAL focus trap with the safe `Cancel` default.
//   It can never weaken the destructive-SQL / workspace-trust gates, which are
//   enforced host-side and are outside this module entirely.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework, no timers.

import { createChatIcon } from "./icons";
import {
  createFocusTrap,
  createModalWarning,
  createOverlayMenu,
  type FocusTrap,
  type OverlayMenu,
  type OverlayMenuRow,
} from "./overlays";

/** The V2 root class every selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

function cls(name: string): string {
  return `${ROOT_CLASS}-${name}`;
}

/** The closed permission-policy vocabulary (mirrors the wire intent). */
export type PermissionPolicy = "default" | "bypass";

/** Marker attribute identifying the anchored permission request sheet. */
export const PERMISSION_REQUEST_MARKER = "data-chat-permission-request";

// ---- Exact copy (pinned by the task contract) -----------------------------

/** Composer chip label while every tool action asks first. */
export const PERMISSION_LABEL_ASK = "Permissions: Ask";
/** Composer chip label while bypass is on for this chat. */
export const PERMISSION_LABEL_BYPASS = "Permissions: Bypass";
/** Exactly one of these two is ever rendered on the composer chip. */
export function permissionChipLabel(policy: PermissionPolicy): string {
  return policy === "bypass" ? PERMISSION_LABEL_BYPASS : PERMISSION_LABEL_ASK;
}

/** Request sheet heading. */
export const PERMISSION_REQUEST_TITLE = "Allow tool action?";

/** Exact bypass warning copy (pinned). */
export const BYPASS_WARNING_COPY =
  "This may let the selected AI run supported tools without asking in this chat. Destructive SQL and workspace trust rules still apply.";
export const BYPASS_ENABLE_LABEL = "Enable for this chat";
export const BYPASS_CANCEL_LABEL = "Cancel";
export const BYPASS_WARNING_TITLE = "Allow tools without asking?";

/** Request action labels (pinned). */
export const PERMISSION_ALLOW_ONCE_LABEL = "Allow once";
export const PERMISSION_ALWAYS_ALLOW_LABEL = "Always allow for this chat";
export const PERMISSION_DENY_LABEL = "Deny";
export const PERMISSION_DETAILS_SHOW_LABEL = "Show tool details";
export const PERMISSION_DETAILS_HIDE_LABEL = "Hide tool details";

/** Destructive/high-impact Escape confirmation copy. */
export const PERMISSION_DENY_CONFIRM_TITLE = "Deny this action?";
export const PERMISSION_DENY_CONFIRM_BODY = "The requested tool action will not run.";
export const PERMISSION_DENY_CONFIRM_DENY_LABEL = "Deny";
export const PERMISSION_DENY_CONFIRM_KEEP_LABEL = "Keep waiting";
/** Action id of the safe choice in the deny confirmation (never the deny). */
export const PERMISSION_DENY_CONFIRM_SAFE_ACTION_ID = "keep-waiting";

/** Request sheet width clamp (PLAN §5: 360–560px). */
export const PERMISSION_REQUEST_WIDTH_MIN = 360;
export const PERMISSION_REQUEST_WIDTH_MAX = 560;

/** A detail longer than this — or one containing a newline — is collapsed. */
export const PERMISSION_DETAIL_COLLAPSE_THRESHOLD = 120;

/** Opaque option ids the host uses for the two allow kinds. */
export const PERMISSION_OPTION_ALLOW_ONCE = "allow-once";
export const PERMISSION_OPTION_ALLOW_SESSION = "allow-session";

/** The single opaque response emitted for one request. `optionId` is omitted
 * for Deny (the host treats a missing optionId as deny — never an allow). */
export interface PermissionResponse {
  readonly requestId: string;
  readonly optionId?: string;
}

/** One host-provided option on a request. */
export interface PermissionOption {
  readonly optionId: string;
  readonly label: string;
}

/** One pending permission request as the sheet renders it. */
export interface PermissionRequestInput {
  readonly requestId: string;
  readonly tool: {
    readonly id: string;
    readonly name: string;
    readonly detail: string;
    /** Host marks the detail copy-safe. Absent/false keeps copy disabled. */
    readonly copyable?: boolean;
    /** Host marks the action destructive/high-impact. */
    readonly destructive?: boolean;
  };
  readonly options: readonly PermissionOption[];
  /**
   * Host contract allows Escape to choose Deny. Applies to ORDINARY requests
   * only — a destructive request always requires the explicit confirmation.
   */
  readonly escapeChoosesDeny?: boolean;
  /** Optional scope selector entries. Rendered only when non-empty. */
  readonly scope?: {
    readonly options: readonly { readonly id: string; readonly label: string }[];
    readonly selectedId?: string;
  };
}

/** Optional scope change report. The protocol carries no scope field yet, so a
 * selection is reported to the caller and never invented onto the wire. */
export type PermissionScopeChange = (scopeId: string) => void;

export interface PermissionRequestSheetOptions {
  /** Element the sheet is anchored to (the composer column). */
  readonly anchor: HTMLElement;
  /** The composer focus target restored when the sheet is disposed. */
  readonly composer: HTMLElement;
  /** Assertive live region (shell alert region) for the single announcement. */
  readonly liveRegion?: HTMLElement;
  /** Convenience text holder (clipboard-free): the host decides copyability. */
  readonly onCopyDetail?: (detail: string) => void;
  /**
   * One answer per request. Called at most once for a requestId; a late click
   * on a settled/replaced sheet never reaches here.
   */
  readonly onRespond: (response: PermissionResponse) => void;
  readonly onScopeChange?: PermissionScopeChange;
}

/** The live request sheet handle. */
export interface PermissionRequestSheet {
  readonly element: HTMLElement;
  /** Show/replace the sheet for a request. Replacing discards the old one. */
  show(request: PermissionRequestInput): void;
  /** Remove the sheet without answering (timeout/terminal/cancelled). */
  settle(): void;
  isOpen(): boolean;
  requestId(): string | null;
  /** The response emitted for this sheet, or null. Test/observability aid. */
  lastResponse(): PermissionResponse | null;
  /** Announce + render once. Exported for the bypass-less caller. */
  readonly trap: FocusTrap;
  handleKey(event: KeyboardEvent): boolean;
  destroy(): void;
}

/** True when a detail must be collapsed behind the details toggle. */
export function shouldCollapseDetail(detail: string): boolean {
  return detail.length > PERMISSION_DETAIL_COLLAPSE_THRESHOLD || detail.includes("\n");
}

/** The host option ids a request actually offers. */
export interface PermissionOptionKinds {
  readonly allowOnce: PermissionOption | null;
  readonly allowSession: PermissionOption | null;
  readonly hasDeny: boolean;
}

/** Classify the host options into the two allow kinds + deny presence. */
export function classifyPermissionOptions(
  options: readonly PermissionOption[],
): PermissionOptionKinds {
  let allowOnce: PermissionOption | null = null;
  let allowSession: PermissionOption | null = null;
  let hasDeny = false;
  for (const option of options) {
    if (option.optionId === PERMISSION_OPTION_ALLOW_ONCE) allowOnce = option;
    else if (option.optionId === PERMISSION_OPTION_ALLOW_SESSION) allowSession = option;
    else if (option.optionId === "deny") hasDeny = true;
  }
  return { allowOnce, allowSession, hasDeny };
}

// ---------------------------------------------------------------------------
// Policy sheet
// ---------------------------------------------------------------------------

export interface PolicySheetOptions {
  readonly anchor: HTMLElement;
  readonly trigger: HTMLElement;
  /** `capabilities.supports.bypassPermissions`. False hides the bypass row. */
  readonly supportsBypass: boolean;
  readonly currentPolicy: PermissionPolicy;
  /** The bypass row was chosen — the caller opens the warning modal. */
  readonly onRequestBypass: () => void;
  readonly onClose?: () => void;
}

export interface PolicySheet {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Current rows: exactly the policy description, plus bypass when supported. */
  getRows(): readonly OverlayMenuRow[];
  handleKey(event: KeyboardEvent): boolean;
  /** Rebuild rows for a new policy/capability, without opening. */
  setState(supportsBypass: boolean, currentPolicy: PermissionPolicy): void;
  destroy(): void;
}

/** Description copy for the current policy row. */
export function policyDescription(policy: PermissionPolicy): string {
  return policy === "bypass"
    ? "Supported tools may run without asking in this chat"
    : "You are asked before each tool action";
}

/**
 * The anchored, NON-MODAL policy sheet. It DESCRIBES the current policy and,
 * only when the host capability allows it, offers the bypass row. It can never
 * resolve a pending request — the request sheet owns answers exclusively.
 */
export function createPolicySheet(options: PolicySheetOptions): PolicySheet {
  let supportsBypass = options.supportsBypass;
  let currentPolicy = options.currentPolicy;

  const menu: OverlayMenu = createOverlayMenu({
    anchor: options.anchor,
    trigger: options.trigger,
    ariaLabel: "Permission policy",
    onActivate: (row) => {
      if (row.id === "bypass" && currentPolicy !== "bypass") options.onRequestBypass();
    },
    onClose: () => options.onClose?.(),
  });

  function buildRows(): readonly OverlayMenuRow[] {
    const rows: OverlayMenuRow[] = [
      {
        id: "current",
        label: "Current policy",
        description: policyDescription(currentPolicy),
        icon: currentPolicy === "bypass" ? "shield-alert" : "shield-check",
        iconSizePx: 16,
        // A description row is never selectable.
        disabled: true,
      },
    ];
    if (supportsBypass) {
      rows.push({
        id: "bypass",
        label: "Bypass permissions",
        description:
          currentPolicy === "bypass"
            ? "On for this chat"
            : "Allow supported tools without asking in this chat",
        checked: currentPolicy === "bypass",
        // Already bypassing: the row is inert (never a silent second change).
        disabled: currentPolicy === "bypass",
      });
    }
    return rows;
  }

  function applyRows(): void {
    menu.setRows(buildRows());
  }

  applyRows();

  return {
    open(): void {
      applyRows();
      menu.open();
    },
    close: () => menu.close("api"),
    isOpen: () => menu.isOpen(),
    getRows: () => menu.getRows(),
    handleKey: (event) => menu.handleKey(event),
    setState(nextSupportsBypass: boolean, nextPolicy: PermissionPolicy): void {
      supportsBypass = nextSupportsBypass;
      currentPolicy = nextPolicy;
      applyRows();
    },
    destroy: () => menu.destroy(),
  };
}

// ---------------------------------------------------------------------------
// Bypass warning modal
// ---------------------------------------------------------------------------

export interface BypassWarningOptions {
  readonly mount: HTMLElement;
  /** The bypass row was confirmed — the caller posts the policy intent. The
   * visible policy changes only after the host acknowledges it. */
  readonly onEnable: () => void;
  readonly onCancel?: () => void;
}

export interface BypassWarning {
  open(): void;
  close(): void;
  isOpen(): boolean;
  focusedActionId(): string | null;
  destroy(): void;
}

/** The exact bypass warning: modal, amber, safe `Cancel` default. */
export function createBypassWarning(options: BypassWarningOptions): BypassWarning {
  const dialog = createModalWarning({
    mount: options.mount,
    title: BYPASS_WARNING_TITLE,
    body: BYPASS_WARNING_COPY,
    defaultActionId: "cancel",
    actions: [
      { id: "enable", label: BYPASS_ENABLE_LABEL, tone: "warning", onActivate: () => options.onEnable() },
      { id: "cancel", label: BYPASS_CANCEL_LABEL, tone: "neutral", onActivate: () => options.onCancel?.() },
    ],
    onDismiss: (reason) => {
      if (reason === "escape") options.onCancel?.();
    },
  });
  return {
    open: () => dialog.open(),
    close: () => dialog.close("api"),
    isOpen: () => dialog.isOpen(),
    focusedActionId: () => dialog.focusedActionId(),
    destroy: () => dialog.destroy(),
  };
}

// ---------------------------------------------------------------------------
// Permission request sheet
// ---------------------------------------------------------------------------

/**
 * The anchored permission request. It is MODAL for keyboard purposes (Tab is
 * trapped among its controls, focused element is restored on dispose) even
 * though it is anchored above the composer rather than centered.
 */
export function createPermissionRequestSheet(
  options: PermissionRequestSheetOptions,
): PermissionRequestSheet {
  const container = document.createElement("div");
  container.className = cls("permission-request");
  container.setAttribute(PERMISSION_REQUEST_MARKER, "1");
  container.setAttribute("role", "dialog");
  container.setAttribute("aria-modal", "true");
  container.style.setProperty("--UnicDB-request-min", `${PERMISSION_REQUEST_WIDTH_MIN}px`);
  container.style.setProperty("--UnicDB-request-max", `${PERMISSION_REQUEST_WIDTH_MAX}px`);
  container.hidden = true;

  const titleId = `${ROOT_CLASS}-permission-request-title`;
  container.setAttribute("aria-labelledby", titleId);
  const title = document.createElement("div");
  title.className = cls("permission-request-title");
  title.id = titleId;
  // textContent only — fixed copy, never host data.
  title.textContent = PERMISSION_REQUEST_TITLE;
  container.appendChild(title);

  const body = document.createElement("div");
  body.className = cls("permission-request-body");
  container.appendChild(body);

  const actions = document.createElement("div");
  actions.className = cls("permission-request-actions");
  container.appendChild(actions);

  options.anchor.appendChild(container);

  const trap = createFocusTrap(container);

  let current: PermissionRequestInput | null = null;
  let settled = true;
  let lastResponse: PermissionResponse | null = null;
  let denyConfirm: ReturnType<typeof createModalWarning> | null = null;

  function announce(text: string): void {
    const region = options.liveRegion;
    if (region === undefined) return;
    // ONE concise announcement per request — never every detail.
    region.textContent = text;
  }

  /** Disable every control so a late click can send nothing. */
  function lockControls(): void {
    for (const node of Array.from(container.querySelectorAll<HTMLElement>("button, select, input"))) {
      if (node instanceof HTMLButtonElement || node instanceof HTMLSelectElement || node instanceof HTMLInputElement) {
        node.disabled = true;
      }
    }
  }

  /**
   * Emit the single response for the OWNING request, then seal the sheet.
   * `ownerRequestId` is captured when a control is built, so a control left
   * over from a REPLACED request can never answer the current one.
   */
  function respond(ownerRequestId: string, optionId: string | undefined): void {
    if (current === null || settled || current.requestId !== ownerRequestId) return;
    settled = true;
    const response: PermissionResponse =
      optionId === undefined ? { requestId: ownerRequestId } : { requestId: ownerRequestId, optionId };
    lastResponse = response;
    // Seal BEFORE the callback: a re-entrant second click is inert.
    lockControls();
    options.onRespond(response);
  }

  function closeDenyConfirm(): void {
    denyConfirm?.destroy();
    denyConfirm = null;
  }

  /** Escape/high-impact path: ask again in the deny direction, never approve. */
  function openDenyConfirm(): void {
    if (current === null || settled || denyConfirm !== null) return;
    denyConfirm = createModalWarning({
      mount: container,
      title: PERMISSION_DENY_CONFIRM_TITLE,
      body: PERMISSION_DENY_CONFIRM_BODY,
      defaultActionId: PERMISSION_DENY_CONFIRM_SAFE_ACTION_ID,
      actions: [
        {
          id: "deny",
          label: PERMISSION_DENY_CONFIRM_DENY_LABEL,
          tone: "danger",
          onActivate: () => {
            const owner = current?.requestId;
            if (owner !== undefined) respond(owner, undefined);
          },
        },
        {
          id: PERMISSION_DENY_CONFIRM_SAFE_ACTION_ID,
          label: PERMISSION_DENY_CONFIRM_KEEP_LABEL,
          tone: "neutral",
          onActivate: () => {
            /* keeps waiting — the request stays open */
          },
        },
      ],
      onDismiss: () => closeDenyConfirm(),
    });
    denyConfirm.open();
  }

  function buildActions(): void {
    actions.replaceChildren();
    const request = current;
    if (request === null) return;
    const owner = request.requestId;
    const kinds = classifyPermissionOptions(request.options);

    // "Allow once" is offered whenever the host exposes the option.
    // "Always allow for this chat" ONLY when the host option exists.
    // "Deny" is always present and never carries an optionId.
    const allowOnce = document.createElement("button");
    allowOnce.type = "button";
    allowOnce.className = cls("permission-action");
    allowOnce.setAttribute("data-action", "allow-once");
    allowOnce.textContent = PERMISSION_ALLOW_ONCE_LABEL;
    allowOnce.addEventListener("click", () => {
      if (kinds.allowOnce === null) return;
      respond(owner, kinds.allowOnce.optionId);
    });
    actions.appendChild(allowOnce);
    if (kinds.allowOnce === null) allowOnce.disabled = true;

    if (kinds.allowSession !== null) {
      const always = document.createElement("button");
      always.type = "button";
      always.className = cls("permission-action");
      always.setAttribute("data-action", "allow-session");
      always.textContent = PERMISSION_ALWAYS_ALLOW_LABEL;
      always.addEventListener("click", () => respond(owner, kinds.allowSession!.optionId));
      actions.appendChild(always);
    }

    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = cls("permission-action");
    deny.setAttribute("data-action", "deny");
    deny.textContent = PERMISSION_DENY_LABEL;
    deny.addEventListener("click", () => respond(owner, undefined));
    actions.appendChild(deny);
  }

  function buildBody(request: PermissionRequestInput): void {
    body.replaceChildren();

    const name = document.createElement("div");
    name.className = cls("permission-tool-name");
    // textContent only — a hostile tool name can never become markup.
    name.textContent = request.tool.name;
    body.appendChild(name);

    const detailText = request.tool.detail;
    if (detailText.length > 0) {
      const detail = document.createElement("div");
      detail.className = cls("permission-tool-detail");
      detail.setAttribute("data-collapsed", String(shouldCollapseDetail(detailText)));
      const pre = document.createElement("div");
      pre.className = cls("permission-tool-detail-text");
      pre.textContent = detailText;
      detail.appendChild(pre);

      if (shouldCollapseDetail(detailText)) {
        pre.hidden = true;
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = cls("permission-details-toggle");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = PERMISSION_DETAILS_SHOW_LABEL;
        toggle.addEventListener("click", () => {
          const nextHidden = !pre.hidden;
          pre.hidden = nextHidden;
          toggle.setAttribute("aria-expanded", String(!nextHidden));
          toggle.textContent = nextHidden ? PERMISSION_DETAILS_SHOW_LABEL : PERMISSION_DETAILS_HIDE_LABEL;
        });
        detail.appendChild(toggle);
      }

      // Copy stays DISABLED unless the host explicitly marked the detail safe.
      if (request.tool.copyable === true && typeof options.onCopyDetail === "function") {
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = cls("permission-detail-copy");
        copy.setAttribute("data-action", "copy-detail");
        copy.textContent = "Copy details";
        copy.addEventListener("click", () => options.onCopyDetail?.(detailText));
        detail.appendChild(copy);
      }
      body.appendChild(detail);
    }

    const scope = request.scope;
    if (scope !== undefined && scope.options.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = cls("permission-scope");
      const select = document.createElement("select");
      select.className = cls("permission-scope-select");
      select.setAttribute("aria-label", "Scope");
      for (const entry of scope.options) {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = entry.label;
        if (entry.id === scope.selectedId) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener("change", () => options.onScopeChange?.(select.value));
      wrap.appendChild(select);
      body.appendChild(wrap);
    }
  }

  function handleSheetKey(event: KeyboardEvent): boolean {
    if (current === null) return false;
    if (event.key !== "Escape") return false;
    event.preventDefault();
    if (denyConfirm !== null && denyConfirm.isOpen()) return true;
    if (current.tool.destructive === true) {
      // High-impact: Escape asks for an explicit deny — never an approval.
      openDenyConfirm();
      return true;
    }
    // Ordinary request: Deny only when the host contract says so.
    if (current.escapeChoosesDeny === true) {
      respond(current.requestId, undefined);
      return true;
    }
    return true;
  }

  // The trap owns Tab; Escape is handled here. Listening on the container means
  // Escape works from any control inside the sheet.
  container.addEventListener("keydown", handleSheetKey);

  return {
    element: container,
    trap,
    show(request: PermissionRequestInput): void {
      // A new request fully REPLACES the previous one: the old controls are
      // rebuilt (and were already sealed by `respond`/`settle`).
      closeDenyConfirm();
      current = request;
      settled = false;
      lastResponse = null;
      buildBody(request);
      buildActions();
      container.hidden = false;
      // Focus the SAFE control (Deny), never an allow button: a stray Enter
      // on the default focus must never grant a tool action.
      const safe = actions.querySelector<HTMLElement>('[data-action="deny"]');
      // Trap FIRST so the pre-sheet focus (composer) is stored for restore.
      trap.activate(safe ?? actions.querySelector<HTMLElement>("button"));
      announce(`Permission needed: ${request.tool.name}`);
    },
    settle(): void {
      if (current === null && container.hidden) return;
      settled = true;
      current = null;
      closeDenyConfirm();
      lockControls();
      trap.deactivate();
      container.hidden = true;
      container.replaceChildren();
      // Restore the composer explicitly — the sheet's whole point is that the
      // keyboard returns to typing after the decision.
      try {
        options.composer.focus();
      } catch {
        /* jsdom/older engines may reject focus. */
      }
    },
    isOpen: () => !container.hidden && current !== null,
    requestId: () => current?.requestId ?? null,
    lastResponse: () => lastResponse,
    handleKey: handleSheetKey,
    destroy(): void {
      settled = true;
      current = null;
      closeDenyConfirm();
      container.removeEventListener("keydown", handleSheetKey);
      trap.destroy();
      container.remove();
    },
  };
}

/** The shield glyph size on the composer permission control (PLAN §5). */
export const PERMISSION_CHIP_ICON_PX = 16;
/** Minimum composer permission control height (PLAN §5: >=36px). */
export const PERMISSION_CHIP_MIN_HEIGHT_PX = 36;

/** Paint the composer permission chip for a policy + capability. Unsupported
 * engines hide the control entirely rather than render a dead button. */
export function renderPermissionChip(
  button: HTMLButtonElement,
  supported: boolean,
  policy: PermissionPolicy,
): void {
  button.hidden = !supported;
  if (!supported) return;
  const label = permissionChipLabel(policy);
  button.title = label;
  button.setAttribute("aria-label", label);
  const text = document.createElement("span");
  text.className = `${ROOT_CLASS}-label-optional`;
  text.textContent = label;
  button.replaceChildren(text, createChatIcon(policy === "bypass" ? "shield-alert" : "shield-check", PERMISSION_CHIP_ICON_PX));
}
