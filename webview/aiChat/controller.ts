// webview/aiChat/controller.ts — TASK-CHATV2-009
//
// The SINGLE owner of composer keyboard precedence, submit/stop dedupe, focus
// and host transport for the V2 chat webview. Every competing V1 Enter/send
// path is removed in the same task (see aiChatPanelMain.ts /
// aiChatPanelComposer.ts).
//
// OWNERSHIP (why this module exists)
// - It acquires the VS Code API exactly once, owns the `window.message`
//   listener, drives the pure reducer, batches render and dispatches semantic
//   host intents. Component modules (shell/composer/keyboard) never acquire the
//   API and never post.
// - Exactly ONE capture-phase `keydown` on `promptV2` implements the immutable
//   precedence ladder from `keyboard.ts`; Shift+Enter is applied to the real
//   textarea here (the pure decision says WHAT, this file performs HOW).
// - Pointer send and keyboard send both route through ONE `requestSubmit()`
//   guarded by an in-memory pending `clientRequestId` lock, so a rapid
//   Enter+click can never emit two `submit_turn`s.
//
// IDs and time are injectable (`nextId`, `now`, `setTimer`, `clearTimer`,
// `schedule`) so behavior is deterministic under test. `dispose()` removes
// every listener and timer and is idempotent; repeated mount/dispose cannot
// duplicate a listener or a message effect.

import { AI_CHAT_PROTOCOL_VERSION_V2 } from "../../src/ui/aiChatPanelMessages";
import type {
  AiChatHostFrameV2,
  AiChatWebviewIntentV2,
} from "../../src/ui/aiChatPanelMessages";
import {
  COMPOSER_IDS,
  COMPOSER_STOP_LOCK_MS,
  renderComposerV2,
  type ComposerSelection,
  type ComposerView,
} from "./composer";
import {
  canSubmitDraft,
  decideComposerKey,
  replaceSelection,
  type ComposerKeyDecision,
} from "./keyboard";
import { mountChatShellIfNeeded, type ChatShellRefs } from "./shell";
import {
  createInitialChatState,
  reduceChatState,
  type ChatAction,
  type ChatViewState,
  type ComposerMode,
  type TurnPhase,
} from "./store";

/** The minimal VS Code API surface the controller needs. */
export interface VsCodeApiLike {
  postMessage(msg: unknown): void;
}

/** The `acquireVsCodeApi` global a real webview exposes. */
declare const acquireVsCodeApi: undefined | (() => VsCodeApiLike);

/** Handle returned by the injectable timer source. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Cooperative mount registry — one active controller per root. */
const activeMounts = new WeakMap<HTMLElement, ChatController>();

/** Live `window` message listeners across all controllers (test/observability). */
let liveMessageListeners = 0;

/** Number of `window` message listeners currently installed. */
export function activeMessageListenerCount(): number {
  return liveMessageListeners;
}

/** Default deterministic id source (per-controller counter, no clock/random). */
function createCounterIdSource(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `req-${n}`;
  };
}

/** Construction options. Signals are injected; nothing here reads a global. */
export interface ChatControllerOptions {
  /** Root the V2 shell + composer mount into. */
  readonly root: HTMLElement;
  /** VS Code API. Omit to acquire the webview global exactly once. */
  readonly vscode?: VsCodeApiLike | null;
  /** Injectable id source for clientRequestId/requestId (deterministic tests). */
  readonly nextId?: () => string;
  /** Injectable wall clock (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Injectable timer (defaults to `setTimeout`). */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable timer cancel (defaults to `clearTimeout`). */
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** Injectable render scheduler (defaults to `queueMicrotask`). */
  readonly schedule?: (fn: () => void) => void;
  /** True while a permission sheet holds focus (delegation gate). */
  readonly isPermissionFocused?: () => boolean;
  /** Optional extra renderer (e.g. the transcript) run in the batched pass. */
  readonly renderExtra?: (state: ChatViewState, refs: ChatShellRefs) => void;
  /** Optional state observer (render output, never authority). */
  readonly onState?: (state: ChatViewState) => void;
  /**
   * Forwarder for non-V2 frames. The controller is the ONLY `window.message`
   * listener; a legacy (V1) frame that carries no V2 envelope is handed here so
   * the temporary compatibility bridge can keep rendering it. Passing this
   * instead of adding a second listener is what keeps "one message effect" true.
   */
  readonly onLegacyMessage?: (data: unknown) => void;
}

/** The live controller handle. */
export interface ChatController {
  readonly shell: ChatShellRefs;
  readonly composer: ComposerView;
  readonly prompt: HTMLTextAreaElement;
  getState(): ChatViewState;
  /** Force the coalesced render to run now (tests/observability). */
  flushRender(): void;
  /** Post `ready_v2` to the host. */
  announceReady(): void;
  /** Open the anchored slash/mention popover and request host results. */
  requestAutocomplete(mode: ComposerMode, query: string): void;
  /** The single primary action: send while idle-valid, stop while busy. */
  requestSubmit(): void;
  /** Tear down every listener/timer. Idempotent. */
  dispose(): void;
}

function busyPhase(phase: TurnPhase): boolean {
  return (
    phase === "validating" ||
    phase === "connecting" ||
    phase === "waiting_for_first_event" ||
    phase === "streaming" ||
    phase === "awaiting_permission" ||
    phase === "stopping"
  );
}

function hasUnresolvedContext(state: ChatViewState): boolean {
  return state.draft.context.some((r) => r.changed === true || r.missing === true);
}

/** Prefer an injected api; otherwise acquire the webview global once. */
function resolveApi(injected: VsCodeApiLike | null | undefined): VsCodeApiLike | null {
  if (injected !== undefined) return injected;
  return typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
}

/**
 * Mount the V2 chat controller on `root`. Idempotent per root: a second call
 * while a controller is live returns that same controller without adding a
 * listener.
 */
export function createChatController(options: ChatControllerOptions): ChatController {
  const existing = activeMounts.get(options.root);
  if (existing) return existing;
  return mountController(options);
}

function mountController(options: ChatControllerOptions): ChatController {
  const root = options.root;
  const api = resolveApi(options.vscode);
  const nextId = options.nextId ?? createCounterIdSource();
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  const schedule = options.schedule ?? ((fn) => queueMicrotask(fn));

  const shell = mountChatShellIfNeeded(root);

  let state = createInitialChatState();
  let disposed = false;
  let lastInteractionAt = now();

  // ---- Dedupe locks ------------------------------------------------------
  /** Pending submit clientRequestId; non-null means a submit is in flight. */
  let submitLock: string | null = null;
  /** Pending stop clientRequestId; non-null holds the 250ms primary lock. */
  let stopLock: string | null = null;
  let stopTimer: TimerHandle | null = null;

  // ---- IME composition state --------------------------------------------
  let composing = false;

  // ---- Render batching ---------------------------------------------------
  let renderScheduled = false;

  function renderState(): void {
    composer.render(state);
    options.renderExtra?.(state, shell);
    options.onState?.(state);
  }

  function scheduleRender(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    schedule(() => {
      renderScheduled = false;
      if (disposed) return;
      renderState();
    });
  }

  function dispatch(action: ChatAction): void {
    if (disposed) return;
    state = reduceChatState(state, action);
    scheduleRender();
  }

  function postIntent(intent: AiChatWebviewIntentV2): void {
    api?.postMessage(intent);
  }

  // ---- Composer ----------------------------------------------------------
  const composer = renderComposerV2(
    shell.composer,
    {
      onInput(value: string, selection: ComposerSelection): void {
        lastInteractionAt = now();
        dispatch({
          type: "DRAFT_CHANGED",
          text: value,
          selectionStart: selection.start,
          selectionEnd: selection.end,
        });
      },
      onSelectionChange(selection: ComposerSelection): void {
        dispatch({
          type: "SELECTION_CHANGED",
          selectionStart: selection.start,
          selectionEnd: selection.end,
        });
      },
      onAttachOpen(): void {
        /* Attach picker is wired by a later wave (CHATV2-013). */
      },
      onSlashOpen(): void {
        /* Slash popover is wired by CHATV2-010. */
      },
      onModelOpen(): void {
        /* Model menu is wired by CHATV2-012. */
      },
      onContextPreview(): void {
        /* Context preview is wired by CHATV2-011. */
      },
      onContextRemove(refId: string): void {
        dispatch({ type: "CONTEXT_REMOVED", refId });
        postIntent({
          kind: "remove_context",
          protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
          clientRequestId: nextId(),
          refId,
        });
      },
      onSchemaOpen(): void {
        postIntent({ kind: "pick_active_schema", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
      },
      onPermissionOpen(): void {
        /* Permission sheet is wired by CHATV2-014. */
      },
      onPrimaryActivate(): void {
        requestSubmit();
      },
    },
  );

  const prompt = composer.prompt;

  // ---- Submit / stop (ONE path each) ------------------------------------

  /** The single primary action. Busy → stop; idle-valid → send. */
  function requestSubmit(): void {
    if (disposed) return;
    lastInteractionAt = now();
    // In-memory lock FIRST: a rapid Enter+click while our own submit is still
    // unacknowledged is a no-op — it must NOT be reinterpreted as a stop.
    if (submitLock !== null) return;
    if (busyPhase(state.phase)) {
      requestStop();
      return;
    }
    if (!canSubmitDraft({ phase: state.phase, draftText: state.draft.text, hasUnresolvedContext: hasUnresolvedContext(state) })) {
      return;
    }

    const clientRequestId = nextId();
    submitLock = clientRequestId;
    dispatch({ type: "SUBMIT_REQUESTED", clientRequestId });

    const pending = state.pendingSubmit;
    if (pending === null || pending.clientRequestId !== clientRequestId) return;
    postIntent({
      kind: "submit_turn",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId,
      draft: {
        text: pending.draft.text,
        revision: pending.draft.revision,
        context: pending.draft.context,
        attachments: pending.draft.attachments,
      },
    });
    dispatch({ type: "SUBMIT_CONSUMED", clientRequestId });
  }

  /** The single stop action: one `stop_turn` per active turn, 250ms lock. */
  function requestStop(): void {
    if (disposed) return;
    if (!busyPhase(state.phase) || state.phase === "stopping") return;
    if (stopLock !== null || state.pendingStop !== null) return;

    const clientRequestId = nextId();
    dispatch({ type: "STOP_REQUESTED", clientRequestId });
    if (state.pendingStop === null || state.pendingStop.clientRequestId !== clientRequestId) return;

    postIntent({ kind: "stop_turn", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId });
    dispatch({ type: "STOP_DISPATCHED", clientRequestId });

    stopLock = clientRequestId;
    if (stopTimer !== null) clearTimer(stopTimer);
    stopTimer = setTimer(() => {
      stopTimer = null;
      stopLock = null;
    }, COMPOSER_STOP_LOCK_MS);
  }

  function releaseStopLock(): void {
    if (stopTimer !== null) {
      clearTimer(stopTimer);
      stopTimer = null;
    }
    stopLock = null;
  }

  // ---- Autocomplete ------------------------------------------------------

  function requestAutocomplete(mode: ComposerMode, query: string): void {
    if (disposed) return;
    const requestId = nextId();
    const draftRevision = state.draft.revision;
    dispatch({ type: "AUTOCOMPLETE_OPENED", mode, requestId, draftRevision, query });
    postIntent({
      kind: "search_context",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: nextId(),
      requestId,
      draftRevision,
      query,
    });
  }

  /** Accept the active autocomplete row: insert its token over the selection. */
  function acceptAutocomplete(): void {
    const ac = state.autocomplete;
    const item = ac.items[ac.activeIndex];
    const token = item?.token ?? "";
    const text = state.draft.text;
    const start = state.draft.selectionStart;
    const end = state.draft.selectionEnd;
    if (token.length > 0) {
      const edit = replaceSelection(text, start, end, `${token} `);
      applyDraftEdit(edit.text, edit.selectionStart, edit.selectionEnd);
    }
    dispatch({ type: "AUTOCOMPLETE_CLOSED", reason: "commit" });
  }

  /** Apply a controller-computed text edit to state + the live textarea. */
  function applyDraftEdit(text: string, selectionStart: number, selectionEnd: number): void {
    dispatch({ type: "DRAFT_CHANGED", text, selectionStart, selectionEnd });
    if (prompt.value !== text) prompt.value = text;
    try {
      prompt.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      /* jsdom/older engines may reject selection on a detached textarea. */
    }
  }

  // ---- Keyboard (exactly ONE capture-phase keydown) ----------------------

  function onKeydown(event: KeyboardEvent): void {
    const decision = decideComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.isComposing === true,
      keyCode: event.keyCode,
      composing,
      phase: state.phase,
      draftText: state.draft.text,
      hasUnresolvedContext: hasUnresolvedContext(state),
      permissionFocused: options.isPermissionFocused?.() === true,
      autocompleteOpen: state.autocomplete.open,
      autocompleteItemCount: state.autocomplete.items.length,
    });
    handleDecision(decision, event);
  }

  function handleDecision(decision: ComposerKeyDecision, event: KeyboardEvent): void {
    switch (decision.kind) {
      case "ignore":
      case "native":
      case "delegate-permission":
        return;
      case "insert-newline": {
        event.preventDefault();
        const edit = replaceSelection(
          prompt.value,
          prompt.selectionStart ?? prompt.value.length,
          prompt.selectionEnd ?? prompt.selectionStart ?? prompt.value.length,
          "\n",
        );
        applyDraftEdit(edit.text, edit.selectionStart, edit.selectionEnd);
        // Shift+Enter closes slash/mention even when the popover is open.
        if (state.autocomplete.open) {
          dispatch({ type: "AUTOCOMPLETE_CLOSED", reason: "commit" });
        }
        return;
      }
      case "autocomplete-move": {
        event.preventDefault();
        dispatch({ type: "AUTOCOMPLETE_ACTIVE_MOVED", delta: decision.delta });
        return;
      }
      case "autocomplete-accept": {
        event.preventDefault();
        acceptAutocomplete();
        return;
      }
      case "autocomplete-close": {
        event.preventDefault();
        dispatch({ type: "AUTOCOMPLETE_CLOSED", reason: "escape" });
        return;
      }
      case "consume-modifier-enter": {
        // Prevent the chat submit, leave the text untouched.
        event.preventDefault();
        return;
      }
      case "submit": {
        event.preventDefault();
        requestSubmit();
        return;
      }
    }
  }

  function onCompositionStart(): void {
    composing = true;
  }
  function onCompositionEnd(): void {
    composing = false;
  }

  // ---- Host frames -------------------------------------------------------

  function onMessage(event: MessageEvent): void {
    if (disposed) return;
    const data = event.data as unknown;
    if (data === null || typeof data !== "object") return;
    const frame = data as { protocolVersion?: unknown; kind?: unknown };
    if (frame.protocolVersion !== AI_CHAT_PROTOCOL_VERSION_V2 || typeof frame.kind !== "string") {
      // Not a V2 frame — the temporary V1 bridge owns it. Forwarded through the
      // ONE listener rather than a second `window.message` subscription.
      options.onLegacyMessage?.(data);
      return;
    }
    applyHostFrame(data as AiChatHostFrameV2);
  }

  function applyHostFrame(frame: AiChatHostFrameV2): void {
    dispatch({ type: "HOST_FRAME", frame });

    // Ack/rejection bookkeeping runs against the post-dispatch state.
    if (frame.kind === "turn_started") {
      const f = frame as { clientRequestId: string };
      if (submitLock !== null && f.clientRequestId === submitLock) submitLock = null;
      releaseStopLock();
      return;
    }
    if (frame.kind === "turn_finished") {
      releaseStopLock();
      return;
    }
    if (frame.kind === "error") {
      // Rejection before the turn opened: release the submit lock so a retry
      // is possible. The reducer preserves the draft on every non-matching ack.
      if (submitLock !== null && state.turn === null) submitLock = null;
      releaseStopLock();
      return;
    }
  }

  // ---- Mount listeners ---------------------------------------------------

  prompt.addEventListener("keydown", onKeydown, true);
  prompt.addEventListener("compositionstart", onCompositionStart);
  prompt.addEventListener("compositionend", onCompositionEnd);
  window.addEventListener("message", onMessage);
  liveMessageListeners += 1;
  prompt.setAttribute("data-chat-keydown-owner", "1");

  renderState();

  const controller: ChatController = {
    shell,
    composer,
    prompt,
    getState: () => state,
    flushRender: () => {
      if (disposed) return;
      renderScheduled = false;
      renderState();
    },
    announceReady: () => {
      postIntent({ kind: "ready_v2", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
    },
    requestAutocomplete,
    requestSubmit,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      prompt.removeEventListener("keydown", onKeydown, true);
      prompt.removeEventListener("compositionstart", onCompositionStart);
      prompt.removeEventListener("compositionend", onCompositionEnd);
      window.removeEventListener("message", onMessage);
      liveMessageListeners = Math.max(0, liveMessageListeners - 1);
      releaseStopLock();
      prompt.removeAttribute("data-chat-keydown-owner");
      activeMounts.delete(root);
      composer.destroy();
    },
  };

  activeMounts.set(root, controller);
  return controller;
}

/** The exact composer prompt id this controller binds — re-exported for tests. */
export const CONTROLLER_PROMPT_ID = COMPOSER_IDS.prompt;
