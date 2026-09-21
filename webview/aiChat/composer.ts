// webview/aiChat/composer.ts — TASK-CHATV2-008
//
// The V2 composer: a two-row 16px-radius shell that renders the exact control
// inventory from PLAN §5. It is a PURE VIEW over `ChatViewState` plus a small
// set of semantic callbacks.
//
// OWNERSHIP BOUNDARY (the reason this module exists as its own task):
// - It emits SEMANTIC callbacks only. It never sends, never queues, never
//   acquires a host transport and never installs a submit keyboard handler.
//   Keyboard submit precedence and `postMessage` transport are owned
//   exclusively by TASK-CHATV2-009.
// - It may listen to `input`, `select`, `focus`, `blur` and `click` (pointer)
//   because those describe webview-owned draft/caret state. Nothing here
//   interprets a keystroke as a send.
// - It never calls the VS Code API and never branches on provider names.
//
// STATE AUTHORITY. `render(state)` reads `ChatViewState`; DOM geometry and
// classes are render output, never authority. Model/engine/schema chips render
// exactly what state holds — no optimistic label swap.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { createChatIcon } from "./icons";
import { PERMISSION_CHIP_ICON_PX, permissionChipLabel } from "./permissions";
import type { ChatViewState, TurnPhase } from "./store";

/** The V2 root class every scoped style selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

function cls(name: string): string {
  return `${ROOT_CLASS}-${name}`;
}

/** Busy phases keep the primary slot in stop mode and the draft editable. */
const BUSY_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  "validating",
  "connecting",
  "waiting_for_first_event",
  "streaming",
  "awaiting_permission",
  "stopping",
]);

/** Default composer placeholder while the textarea has real host focus. */
export const COMPOSER_PLACEHOLDER = "Ask about this workspace or database…";

/** Fixed hint copy while a turn is live and the user edits a next draft. */
export const COMPOSER_BUSY_HINT = "AI is responding. Your next draft is saved here.";

/** Primary-slot accessible name when a valid idle draft can be sent. */
export const COMPOSER_SEND_LABEL = "Send message (Enter)";

/** Primary-slot accessible name while a live turn can be stopped. */
export const COMPOSER_STOP_LABEL = "Stop generating";

/** Exact disabled reason for an empty draft. */
export const COMPOSER_REASON_EMPTY = "Enter a message to send";

/** Exact disabled reason when a context ref still needs resolution. */
export const COMPOSER_REASON_UNRESOLVED =
  "Resolve changed or missing context before sending";

/** Auto-grow clamp, in px, for the borderless textarea (SPEC §8.3: 36–88). */
export const COMPOSER_AUTO_GROW_MIN_PX = 36;
export const COMPOSER_AUTO_GROW_MAX_PX = 88;

/** Visual stop lock, in ms. Textarea/context stay editable throughout. */
export const COMPOSER_STOP_LOCK_MS = 250;

/** Exact ids required by the task contract. Never renamed. */
export const COMPOSER_IDS = Object.freeze({
  composer: "composerV2",
  prompt: "promptV2",
  attach: "attachContextBtn",
  slash: "slashCommandBtn",
  model: "modelChipBtnV2",
  contextList: "contextChipList",
  schema: "schemaChipBtnV2",
  permission: "permissionBtn",
  primary: "primaryTurnBtn",
  hint: "composerHint",
  // TASK-CHATV2-009 — the canonical transcript mount. The controller nests the
  // legacy `#thread` here so the single keyboard/transport owner can scroll and
  // observe it. Not a composer control.
  transcript: "thread",
} as const);

/** Archived composer ids. TASK-CHATV2-009 makes the V2 composer the ONLY live
 * composer: the V1 composer node is kept in the DOM out of the accessibility
 * tree (see `archiveV1Composer` in aiChatPanelMain.ts) so V1 flows that still
 * address `#prompt` (mention tokens, slash dropdown, `/clear`) keep working,
 * but it carries no independent send/keyboard path. Deleted in CHATV2-017. */
export const ARCHIVED_COMPOSER_IDS = Object.freeze({
  v1Composer: "composer",
  v1Prompt: "prompt",
  v1Send: "sendBtn",
  v1Stop: "stopBtn",
  v1Attach: "attachBtn",
} as const);

/** Caret/selection snapshot emitted alongside a draft edit. */
export interface ComposerSelection {
  readonly start: number;
  readonly end: number;
}

/** Semantic, transport-free callback surface. The controller (009+) owns
 * what each one does; this component only reports intent. */
export interface ComposerCallbacks {
  /** A draft edit. `selection` is the post-edit caret/range. */
  onInput(value: string, selection: ComposerSelection): void;
  /** Caret/range moved without a text edit. */
  onSelectionChange(selection: ComposerSelection): void;
  /** Attach-context control pressed. */
  onAttachOpen(): void;
  /** Slash-command control pressed. */
  onSlashOpen(): void;
  /** Model chip pressed. */
  onModelOpen(): void;
  /**
   * A context chip body was activated (preview). TASK-CHATV2-011: the chip DOM
   * now belongs to `createContextChipStrip`, which the controller mounts into
   * `contextList` — so this reports the activation the hosted strip could not
   * observe itself. It is NOT a second preview path: the composer renders no
   * chip.
   */
  onContextActivate(refId: string): void;
  /** Schema chip pressed. */
  onSchemaOpen(): void;
  /** Permission control pressed. */
  onPermissionOpen(): void;
  /**
   * The single right-hand 40×40 slot was activated. Its MEANING is derived from
   * state by the controller: send while idle-valid, stop while a turn is live.
   * There is deliberately no separate `onSend`/`onStop` here, so no caller can
   * install an implicit queue path.
   */
  onPrimaryActivate(): void;
}

/** Optional construction-time configuration. */
export interface ComposerOptions {
  /**
   * A REAL host keyboard shortcut (e.g. a keybinding string) that focuses the
   * composer. Only when one is genuinely provided do we render an inactive
   * focus hint; otherwise the default placeholder stands and no fake shortcut
   * is invented.
   */
  readonly hostFocusShortcut?: string;
}

/** Element handles + lifecycle for one mounted composer. */
export interface ComposerView {
  /** The `composerV2` shell element (mount point). */
  readonly root: HTMLElement;
  readonly top: HTMLElement;
  readonly bottom: HTMLElement;
  readonly prompt: HTMLTextAreaElement;
  readonly attachButton: HTMLButtonElement;
  readonly slashButton: HTMLButtonElement;
  readonly modelButton: HTMLButtonElement;
  readonly contextList: HTMLElement;
  /** The pre-`render` schema slot. After `setSchemaControl` it detached. */
  readonly schemaButton: HTMLButtonElement;
  /**
   * TASK-CHATV2-013: hand the ACTIVE-SCHEMA chip to the composer's center lane,
   * replacing the placeholder in place. The caller owns the control's lifecycle
   * (`createSchemaControl`); the composer only positions it.
   */
  readonly setSchemaControl: (control: HTMLElement) => void;
  readonly permissionButton: HTMLButtonElement;
  readonly primaryButton: HTMLButtonElement;
  readonly hint: HTMLElement;
  /** True while a stopping turn holds the 250ms visual primary lock. */
  readonly isPrimaryLocked: () => boolean;
  /** Apply the current state. Pure render; never dispatches. */
  readonly render: (state: ChatViewState) => void;
  /** Detach listeners, cancel the lock timer and remove the shell. */
  readonly destroy: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(className: string): HTMLButtonElement {
  const node = el("button", className);
  node.type = "button";
  return node;
}

/** An icon-only button always carries IDENTICAL `title` and `aria-label`. */
function labelIconOnly(node: HTMLElement, text: string): void {
  node.title = text;
  node.setAttribute("aria-label", text);
}

function isBusyPhase(phase: TurnPhase): boolean {
  return BUSY_PHASES.has(phase);
}

/** A context ref that the host marked changed/missing blocks send until it is
 * resolved (PLAN §5: amber states require resolution before send). */
function hasUnresolvedContext(state: ChatViewState): boolean {
  return state.draft.context.some((ref) => ref.changed === true || ref.missing === true);
}

function caretOf(prompt: HTMLTextAreaElement): ComposerSelection {
  return {
    start: prompt.selectionStart ?? 0,
    end: prompt.selectionEnd ?? 0,
  };
}

/** Reason a send is refused in an idle/completed/failed phase, or null when the
 * draft is valid. Exported indirectly through the primary title/aria. */
function idleReason(state: ChatViewState): string | null {
  if (state.draft.text.trim().length === 0) return COMPOSER_REASON_EMPTY;
  if (hasUnresolvedContext(state)) return COMPOSER_REASON_UNRESOLVED;
  return null;
}

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

function replaceSingleIcon(host: HTMLElement, name: string, size: number): void {
  const next = createChatIcon(name, size);
  host.replaceChildren(next);
}

/**
 * Mount the V2 composer inside `root` (the shell's composer mount point) and
 * return its view. Idempotent per root: calling again replaces the previous
 * composer there rather than stacking a second one.
 */
export function renderComposerV2(
  root: HTMLElement,
  callbacks: ComposerCallbacks,
  options: ComposerOptions = {},
): ComposerView {
  const previous = root.querySelector<HTMLElement>(`#${COMPOSER_IDS.composer}`);
  if (previous && previous !== root) previous.remove();

  root.classList.add(cls("composer"));
  root.classList.add(cls("composer-v2"));
  root.id = COMPOSER_IDS.composer;

  // ---- Top region: borderless auto-growing textarea ----------------------
  const top = root.querySelector<HTMLElement>(`.${cls("composer-top")}`) ?? el("div", cls("composer-top"));
  top.classList.add(cls("composer-top-v2"));
  top.replaceChildren();

  const prompt = el("textarea", joinClasses(cls("input"), cls("input-v2")));
  prompt.id = COMPOSER_IDS.prompt;
  prompt.rows = 1;
  prompt.spellcheck = false;
  prompt.setAttribute("aria-label", "Message");
  prompt.setAttribute("autocomplete", "off");
  prompt.placeholder = COMPOSER_PLACEHOLDER;
  top.appendChild(prompt);

  // ---- Bottom region: three lanes (left controls · scroll center · right) --
  const bottom = root.querySelector<HTMLElement>(`.${cls("composer-bottom")}`) ?? el("div", cls("composer-bottom"));
  bottom.classList.add(cls("composer-bottom-v2"));
  bottom.replaceChildren();

  const leftLane = el("div", joinClasses(cls("composer-lane"), cls("composer-lane-left")));

  const attachButton = button(joinClasses(cls("control"), cls("attach")));
  attachButton.id = COMPOSER_IDS.attach;
  labelIconOnly(attachButton, "Attach context");
  attachButton.appendChild(createChatIcon("plus", 20));
  leftLane.appendChild(attachButton);

  const slashButton = button(joinClasses(cls("control"), cls("slash")));
  slashButton.id = COMPOSER_IDS.slash;
  labelIconOnly(slashButton, "Slash commands");
  slashButton.appendChild(createChatIcon("slash", 16));
  leftLane.appendChild(slashButton);

  const centerLane = el("div", joinClasses(cls("composer-lane"), cls("composer-lane-center")));

  const modelButton = button(joinClasses(cls("chip"), cls("model-chip")));
  modelButton.id = COMPOSER_IDS.model;
  const modelLabel = el("span", cls("label-optional"));
  modelButton.appendChild(modelLabel);

  const contextList = el("div", joinClasses(cls("context-chip-list")));
  contextList.id = COMPOSER_IDS.contextList;
  contextList.setAttribute("aria-label", "Draft context");

  // TASK-013: the ACTIVE-SCHEMA chip is ordered LAST in the center lane. Its
  // DOM (and its host picker intent) belongs to `createSchemaControl`, which
  // the controller mounts into the lane right here — so the placeholder stays
  // in position and no second schema surface ever exists.
  const schemaPlaceholder = el("span", cls("schema-slot"));
  const schemaButton = button(joinClasses(cls("chip"), cls("schema-chip")));
  schemaButton.id = COMPOSER_IDS.schema;
  const schemaLabel = el("span", cls("label-optional"));
  schemaButton.appendChild(schemaLabel);

  centerLane.append(modelButton, contextList, schemaPlaceholder, schemaButton);

  const rightLane = el("div", joinClasses(cls("composer-lane"), cls("composer-lane-right")));

  const permissionButton = button(joinClasses(cls("chip"), cls("permission")));
  permissionButton.id = COMPOSER_IDS.permission;
  const permissionLabel = el("span", cls("label-optional"));
  permissionButton.appendChild(permissionLabel);

  const primaryButton = button(joinClasses(cls("primary"), cls("primary-send")));
  primaryButton.id = COMPOSER_IDS.primary;
  // Every icon-only control carries identical title + aria-label from birth, so
  // the invariant holds before the first `render(state)` call too.
  labelIconOnly(primaryButton, COMPOSER_REASON_EMPTY);
  primaryButton.appendChild(createChatIcon("arrow-up", 18));
  rightLane.append(permissionButton, primaryButton);

  bottom.append(leftLane, centerLane, rightLane);

  // TASK-013: `schemaChipBtnV2` is the ACTIVE-SCHEMA chip. Its DOM (and its
  // host picker intent) belongs to `createSchemaControl`, which the controller
  // mounts into the center lane — so the legacy composer chip node is removed
  // and the id is re-homed onto the V2 control. No second schema surface.
  schemaButton.remove();

  const hint = el("div", joinClasses(cls("composer-hint")));
  hint.id = COMPOSER_IDS.hint;
  hint.setAttribute("aria-live", "polite");
  hint.hidden = true;

  // The shell (005) may already have placed top/bottom; only append the ones we
  // created ourselves so we never duplicate a mount node.
  if (top.parentElement !== root) root.appendChild(top);
  if (bottom.parentElement !== root) root.appendChild(bottom);
  if (hint.parentElement !== root) root.appendChild(hint);

  // ---- Wire render -------------------------------------------------------
  let lockTimer: ReturnType<typeof setTimeout> | null = null;
  let primaryLocked = false;
  let stoppedState: ChatViewState | null = null;

  function clearLock(): void {
    if (lockTimer !== null) {
      clearTimeout(lockTimer);
      lockTimer = null;
    }
  }

  /** Re-apply only the primary slot after the visual lock expires. */
  function releaseLock(): void {
    primaryLocked = false;
    lockTimer = null;
    if (stoppedState && stoppedState.phase === "stopping") {
      primaryButton.disabled = false;
      primaryButton.setAttribute("aria-disabled", "false");
      primaryButton.classList.remove(cls("primary-locked"));
    }
  }

  function applyAutoGrow(): void {
    const measured = prompt.scrollHeight;
    const next = Math.min(
      COMPOSER_AUTO_GROW_MAX_PX,
      Math.max(COMPOSER_AUTO_GROW_MIN_PX, measured),
    );
    prompt.style.height = `${next}px`;
    prompt.classList.toggle(cls("input-scroll"), measured > COMPOSER_AUTO_GROW_MAX_PX);
  }

  function renderPrimary(state: ChatViewState): void {
    const busy = isBusyPhase(state.phase);
    const stopping = state.phase === "stopping";

    clearLock();
    primaryLocked = false;
    primaryButton.classList.remove(cls("primary-locked"));

    if (busy) {
      primaryButton.classList.add(cls("primary-busy"));
      primaryButton.classList.remove(cls("primary-send"));
      replaceSingleIcon(primaryButton, "stop-square", 16);
      labelIconOnly(primaryButton, COMPOSER_STOP_LABEL);
      primaryButton.disabled = false;
      primaryButton.setAttribute("aria-disabled", "false");
      if (stopping) {
        // Visual lock only: the slot cannot be activated for 250ms, but the
        // draft textarea and context chips stay fully editable. A failed cancel
        // re-enables the slot and the turn remains stoppable.
        primaryLocked = true;
        primaryButton.disabled = true;
        primaryButton.setAttribute("aria-disabled", "true");
        primaryButton.classList.add(cls("primary-locked"));
        stoppedState = state;
        lockTimer = setTimeout(releaseLock, COMPOSER_STOP_LOCK_MS);
      }
      return;
    }

    primaryButton.classList.remove(cls("primary-busy"));
    primaryButton.classList.add(cls("primary-send"));
    replaceSingleIcon(primaryButton, "arrow-up", 18);
    const reason = idleReason(state);
    if (reason === null) {
      labelIconOnly(primaryButton, COMPOSER_SEND_LABEL);
      primaryButton.disabled = false;
      primaryButton.setAttribute("aria-disabled", "false");
    } else {
      labelIconOnly(primaryButton, reason);
      primaryButton.disabled = true;
      primaryButton.setAttribute("aria-disabled", "true");
    }
  }

  function render(state: ChatViewState): void {
    // The textarea is NEVER disabled — a busy turn keeps an editable next draft.
    if (prompt.value !== state.draft.text) prompt.value = state.draft.text;

    const models = state.models;
    modelLabel.textContent = models === null ? "No model" : models.active;
    modelButton.title = `Model: ${modelLabel.textContent}`;
    modelButton.setAttribute("aria-label", `Model: ${modelLabel.textContent}`);
    // Rebuild (never append) so repeated renders cannot stack duplicate glyphs.
    modelButton.replaceChildren(modelLabel, createChatIcon("chevron-down", 16));

    // TASK-CHATV2-014: the chip renders the HOST's live policy (never a local
    // guess) and is HIDDEN entirely on an engine that does not support
    // permissions — an unsupported engine must not show a dead control.
    const canPermission = state.capabilities?.supports.permissions === true;
    permissionButton.hidden = !canPermission;
    if (canPermission) {
      const bypass = state.permissionPolicy === "bypass";
      const text = permissionChipLabel(bypass ? "bypass" : "default");
      permissionLabel.textContent = text;
      labelIconOnly(permissionButton, text);
      permissionButton.classList.toggle(cls("permission-bypass"), bypass);
      permissionButton.replaceChildren(
        permissionLabel,
        createChatIcon(bypass ? "shield-alert" : "shield-check", PERMISSION_CHIP_ICON_PX),
      );
    }

    // The context lane is only a HOST: the chip DOM belongs to
    // `createContextChipStrip` (mounted by the controller). The composer owns
    // the lane's visibility so an empty draft never leaves a stray gap.
    contextList.hidden = state.draft.context.length === 0;
    renderPrimary(state);

    const busy = isBusyPhase(state.phase);
    hint.hidden = !busy;
    hint.textContent = busy ? COMPOSER_BUSY_HINT : "";

    applyAutoGrow();
  }

  // ---- Listeners (draft/caret only; no submit interpretation) -------------
  const onInput = (): void => {
    callbacks.onInput(prompt.value, caretOf(prompt));
    applyAutoGrow();
  };
  const onSelect = (): void => callbacks.onSelectionChange(caretOf(prompt));
  const onFocus = (): void => {
    prompt.placeholder = COMPOSER_PLACEHOLDER;
  };
  const onBlur = (): void => {
    prompt.placeholder =
      options.hostFocusShortcut !== undefined
        ? `Press ${options.hostFocusShortcut} to focus the composer`
        : COMPOSER_PLACEHOLDER;
  };

  attachButton.addEventListener("click", () => callbacks.onAttachOpen());
  slashButton.addEventListener("click", () => callbacks.onSlashOpen());
  modelButton.addEventListener("click", () => callbacks.onModelOpen());
  permissionButton.addEventListener("click", () => callbacks.onPermissionOpen());
  primaryButton.addEventListener("click", () => {
    if (primaryButton.disabled || primaryLocked) return;
    callbacks.onPrimaryActivate();
  });
  prompt.addEventListener("input", onInput);
  prompt.addEventListener("select", onSelect);
  prompt.addEventListener("focus", onFocus);
  prompt.addEventListener("blur", onBlur);

  applyAutoGrow();

  return {
    root,
    top,
    bottom,
    prompt,
    attachButton,
    slashButton,
    modelButton,
    contextList,
    schemaButton,
    setSchemaControl: (control: HTMLElement): void => {
      // Idempotent: a remount of the controller replaces the chip in position
      // rather than stacking a second one. The placeholder is removed on the
      // first handoff; the legacy chip node is detached from birth.
      if (control.parentElement !== centerLane) {
        schemaPlaceholder.replaceWith(control);
      }
    },
    permissionButton,
    primaryButton,
    hint,
    isPrimaryLocked: () => primaryLocked,
    render,
    destroy: () => {
      clearLock();
      prompt.removeEventListener("input", onInput);
      prompt.removeEventListener("select", onSelect);
      prompt.removeEventListener("focus", onFocus);
      prompt.removeEventListener("blur", onBlur);
      root.classList.remove(cls("composer-v2"));
      if (root.parentElement) root.remove();
    },
  };
}

/** Re-exported for callers that only need the phase predicate shape. */
export type { ChatViewState };
