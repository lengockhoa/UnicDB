// webview/aiChat/controller.ts — TASK-CHATV2-009
//
// The SINGLE owner of composer keyboard precedence, submit/stop dedupe, focus
// and host transport for the V2 chat webview. Every competing V1 Enter/send
// path was removed by TASK-CHATV2-017 (the legacy aiChatPanelMain.ts boot and
// the V1 composer/header modules are deleted).
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
  AiChatContextKindFilterV2,
  AiChatContextRefV2,
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
import {
  createBypassWarning,
  createPermissionRequestSheet,
  createPolicySheet,
  type BypassWarning,
  type PermissionRequestSheet,
  type PolicySheet,
} from "./permissions";
import { mountChatShellIfNeeded, type ChatShellRefs } from "./shell";
import {
  createInitialChatState,
  reduceChatState,
  type ChatAction,
  type ChatViewState,
  type ComposerMode,
  type TurnPhase,
} from "./store";
import { createTranscriptRenderer, type TranscriptRenderer } from "./transcript";
import { createOverlayMenu, type OverlayMenu } from "./overlays";
import { createScrollController, type ScrollController } from "./scroll";
import { createActivityTimeline, phaseCopyLabel, type ActivityTimeline } from "./activity";
import { createLiveAnnouncer, type LiveAnnouncer } from "./a11y";
import { renderChangePlanCard, type ChangePlanCard } from "./changePlan";
import { createErrorCard, type ErrorCardHandle } from "./errors";
import { createAttachMenu, type AttachMenu, type AttachMenuAction } from "./attachMenu";
import { createAttachmentController, type AttachmentController } from "./attachments";
import { createAutocompleteView, type AutocompleteView } from "./autocomplete";
import {
  createEngineSwitchView,
  createModelMenu,
  type EngineMenuEntry,
  type EngineSwitchView,
  type ModelMenuView,
} from "./engineModelMenus";
import { createChatHeader, type ChatHeaderView } from "./header";
import { engineDisplayName } from "../../src/ai/capabilities";
import { createSchemaControl, type SchemaControl } from "./schemaControl";
import { createContextChipStrip, type ContextChipStrip } from "./contextChips";
import { buildMentionRows, mentionAcceptEdit, mentionEligibility } from "./mentions";
import { filterSlashCommands, slashAcceptEdit, slashEligibility } from "./slash";
import { resolveChatCommands } from "../../src/ui/aiChatPanelCommands";
import type { ContextRef, ContextResolutionChoice } from "../../src/ui/aiChatContext";
import { createSessionsController, type SessionsController, type SessionsViewState } from "./sessions";

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

/** Distance reported to the reducer when the viewport is NOT near the bottom. */
const SCROLL_FAR_PX = 10_000;

/**
 * The user-visible projection of a transcript state (TASK-CHATFIX-002): ids of
 * `user`/`text`/`tool` rows in `order`, plus each `text` row's streamed
 * `raw.length`. `reasoning` rows are deliberately invisible here — they are
 * never a new response and never move the viewport.
 */
function userVisibleSignature(transcript: ChatViewState["transcript"]): {
  ids: string[];
  lengths: number[];
} {
  const ids: string[] = [];
  const lengths: number[] = [];
  for (const id of transcript.order) {
    const item = transcript.entities[id];
    if (item === undefined || item.kind === "reasoning") continue;
    ids.push(item.id);
    lengths.push(item.kind === "text" ? item.raw.length : 0);
  }
  return { ids, lengths };
}

/** Terminal-phase announcement copy (never streamed prose). */
const FAILED_ANNOUNCEMENT = "Response failed";

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
  /**
   * TASK-CHATV2-017: optional host-provided engine catalog for the header's
   * engine menu. DATA — never derived by engine name. When omitted, the menu
   * carries exactly one truthful entry: the ACTIVE engine from the current
   * `capabilities` snapshot.
   */
  readonly engineEntries?: readonly EngineMenuEntry[];
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
  /**
   * REVIEW-CHATV2-R1 P1-1/P1-3: synchronous turn-ownership gate. Fires the
   * moment the controller applies a V2 `turn_started` (live=true) or
   * `turn_finished` (live=false) — BEFORE any batched render — so the legacy
   * bridge can suppress the streaming families the V2 seam now owns while a
   * V2 turn is live. One logical event, one renderer, even when the host's
   * legacy twin and its V2 frame arrive back to back.
   */
  readonly onV2TurnGate?: (live: boolean) => void;
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
  /** Open the saved-transcript resume picker. */
  openResumePicker(): void;
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

  // TASK-CHATFIX-002: the user-visible signature the LAST paint left on
  // screen. The single coalesced pass diffs it to decide whether the change
  // was a new response (follow it) or reasoning/stream growth (never scroll).
  let lastVisibleIds: readonly string[] = [];
  let lastVisibleLengths: readonly number[] = [];

  /** Schema control + context strip: one paint pass from reducer state only. */
  function renderSchemaAndContext(): void {
    const schema = state.schema;
    schemaControl.setState({
      schema: schema?.schema ?? null,
      connectionId: schema?.connectionId ?? null,
    });
    shell.context.hidden = state.draft.context.length === 0;
    contextStrip.render(state.draft.context.map(asContextRef));
  }

  function renderState(): void {
    // TASK-CHATFIX-002: capture the pre-paint bottom distance BEFORE anything
    // paints, so "was the reader pinned?" is judged against the geometry the
    // user was actually looking at, not the post-insert one.
    scroll.beginFrame();
    const beforeIds = lastVisibleIds;
    const beforeLengths = lastVisibleLengths;
    composer.render(state);
    renderAttachments();
    renderAutocomplete();
    renderSchemaAndContext();
    // TASK-CHATV2-017: the keyed transcript + activity timeline paint from the
    // SAME reducer state the composer does — one state, one paint pass.
    transcript.render(state);
    activity.render(state);
    // TASK-CHATFIX-002: ONE driver, this coalesced pass — no scattered notify
    // calls inside frame handlers. A user-visible id the previous paint did
    // not have is a new response; reasoning rows and raw-length growth inside
    // an existing row are mere activity and never scroll.
    const painted = userVisibleSignature(state.transcript);
    lastVisibleIds = painted.ids;
    lastVisibleLengths = painted.lengths;
    const tail = painted.ids.length > 0 ? painted.ids[painted.ids.length - 1]! : null;
    if (tail !== null && !beforeIds.includes(tail)) {
      scroll.notifyNewResponse();
    } else if (
      beforeIds.length !== painted.ids.length ||
      beforeIds.some((id, index) => id !== painted.ids[index]) ||
      beforeLengths.length !== painted.lengths.length ||
      beforeLengths.some((length, index) => length !== painted.lengths[index])
    ) {
      scroll.notifyReasoningActivity();
    }
    announcePhase(state.phase);
    // TASK-CHATV2-014: the policy sheet reflects the HOST's policy + capability.
    permission.setState(
      state.capabilities?.supports.bypassPermissions === true,
      state.permissionPolicy,
    );
    renderPermissionRequest();
    renderChangePlan();
    renderErrorCard();
    renderSessions();
    // TASK-CHATV2-017 group D: the engine pill + model chip paint from the SAME
    // reducer state in this coalesced pass (one writer per control).
    header.setEngineEntries(engineEntriesFor(state));
    header.render(state);
    modelMenu.setModels(state.models);
    modelMenu.renderChip(state);
    shell.banner.hidden = state.changePlan === null && state.error === null;
    options.renderExtra?.(state, shell);
    options.onState?.(state);
    // Recompute viewport proximity off the freshly painted DOM.
    scroll.sync();
  }

  /** One reviewed plan card; host state remains authoritative until it changes. */
  let changePlanCard: ChangePlanCard | null = null;
  let renderedChangePlan: ChatViewState["changePlan"] = null;
  function renderChangePlan(): void {
    const plan = state.changePlan;
    if (plan === renderedChangePlan) return;
    changePlanCard?.destroy();
    changePlanCard = null;
    renderedChangePlan = plan;
    shell.banner.hidden = plan === null;
    if (plan === null) return;
    changePlanCard = renderChangePlanCard({
      mount: shell.banner,
      plan: plan.plan,
      tool: plan.tool,
      onApprove: () => {
        postIntent({
          kind: "plan_approve",
          protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
          clientRequestId: nextId(),
        });
      },
      onReject: () => {
        postIntent({
          kind: "plan_reject",
          protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
          clientRequestId: nextId(),
        });
      },
    });
    shell.banner.hidden = false;
  }

  /** One safe error card per reducer error state; retry never reads the DOM draft. */
  let errorCard: ErrorCardHandle | null = null;
  let renderedError: ChatViewState["error"] = null;
  function renderErrorCard(): void {
    const error = state.error;
    if (error === renderedError) return;
    errorCard?.destroy();
    errorCard = null;
    renderedError = error;
    if (error === null) return;
    errorCard = createErrorCard({
      frame: error.frame,
      ...(error.request === null ? {} : { request: error.request }),
      callbacks: {
        onRetry: (request) => requestRetry(request),
        onChangeEngine: () => {
          const engine = shell.header.querySelector<HTMLElement>("#UnicDB-ai-chat-v2-engine");
          try {
            engine?.focus();
          } catch {
            /* older webviews may reject focus on a detached node */
          }
        },
      },
    });
    shell.banner.appendChild(errorCard.root);
    shell.banner.hidden = false;
  }

  /** Sessions/resume is created once; its dialogs and document listener are owned here. */
  const sessions: SessionsController = createSessionsController(
    {
      root: shell.root,
      header: shell.header,
      statusLiveRegion: shell.statusLiveRegion,
      alertLiveRegion: shell.alertLiveRegion,
    },
    {
      onNewSession: (clientRequestId) =>
        postIntent({ kind: "create_session", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId }),
      onRenameSession: (clientRequestId, _sessionId, title) =>
        postIntent({ kind: "rename_session", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId, title }),
      onClearSession: (clientRequestId) =>
        postIntent({ kind: "clear_session", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId }),
      onExportSession: (clientRequestId, _sessionId, format) =>
        postIntent({ kind: "export_session", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId, format }),
      onResumeSession: (clientRequestId, sessionId) =>
        postIntent({ kind: "resume_saved_session", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId, sessionId }),
      onListSessions: () => postIntent({ kind: "list_sessions", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 }),
      onOpenSettings: () => postIntent({ kind: "open_settings", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 }),
      onCopyDiagnostics: writeClipboard,
    },
  );

  function renderSessions(): void {
    const sessionState: SessionsViewState = {
      sessionId: state.sessionId,
      title: state.sessionTitle,
      hasHistory: state.hydration.hasHistory || state.transcript.order.length > 0,
      hasDraft: state.draft.text.trim().length > 0,
      busy: busyPhase(state.phase),
      sessions: state.sessions,
      diagnosticIds: state.error === null ? [] : [state.error.frame.diagnosticId],
      engine: state.capabilities?.displayName ?? "",
      model: state.models?.active ?? "",
    };
    sessions.render(sessionState);
  }

  /** Keep the anchored request sheet in sync with the single pending request. */
  function renderPermissionRequest(): void {
    const pending = state.pendingHostRequests[0];
    if (pending === undefined) {
      if (permissionRequest.isOpen()) permissionRequest.settle();
      return;
    }
    if (permissionRequest.isOpen() && permissionRequest.requestId() === pending.requestId) return;
    permissionRequest.show({
      requestId: pending.requestId,
      tool: {
        id: pending.tool.id,
        name: pending.tool.name,
        detail: pending.tool.detail,
      },
      options: pending.options,
    });
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
        syncAutocompleteFromDraft();
      },
      onSelectionChange(selection: ComposerSelection): void {
        dispatch({
          type: "SELECTION_CHANGED",
          selectionStart: selection.start,
          selectionEnd: selection.end,
        });
        syncAutocompleteFromDraft();
      },
      onAttachOpen(): void {
        attachMenu.setAvailability(attachAvailability());
        attachMenu.open();
      },
      onSlashOpen(): void {
        openSlashAutocomplete();
      },
      onModelOpen(): void {
        modelMenu.open();
      },
      onContextActivate(refId: string): void {
        // The strip owns the chip DOM, so it cannot observe its own hosted
        // clicks; the controller — which owns the refs — routes the activation
        // back through the ONE preview path.
        const target = state.draft.context.find((ref) => ref.id === refId);
        if (target !== undefined) previewContext(asContextRef(target));
      },
      onSchemaOpen(): void {
        postIntent({ kind: "pick_active_schema", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
      },
      onPermissionOpen(): void {
        permission.open();
      },
      onPrimaryActivate(): void {
        requestSubmit();
      },
    },
  );

  const prompt = composer.prompt;

  // ---- Attach menu + ephemeral image draft ---------------------------------
  // The capability snapshot is the sole proof that an image input may exist.
  // Workspace/database mention support is the only availability information on
  // the V2 wire; selection remains unavailable until the host can prove one.
  let attachmentController: AttachmentController | null = null;
  let attachmentImageInput: boolean | null = null;

  function attachAvailability(): {
    readonly hasWorkspaceFolder: boolean;
    readonly hasSelection: boolean;
    readonly hasDatabaseConnection: boolean;
    readonly imageInput: boolean;
  } {
    const supports = state.capabilities?.supports;
    return {
      hasWorkspaceFolder: supports?.workspaceMentions === true,
      hasSelection: false,
      hasDatabaseConnection: supports?.dbMentions === true,
      imageInput: supports?.imageInput === true,
    };
  }

  function renderAttachments(): void {
    const imageInput = attachAvailability().imageInput;
    if (attachmentController === null || attachmentImageInput !== imageInput) {
      attachmentController?.destroy();
      attachmentController = createAttachmentController({
        container: shell.composer,
        imageInput,
        callbacks: {
          onAdd: (attachment) => dispatch({ type: "ATTACHMENT_ADDED", attachment }),
          onRemove: (id) => dispatch({ type: "ATTACHMENT_REMOVED", id }),
        },
      });
      attachmentImageInput = imageInput;
    }
    attachmentController.setAttachments(state.draft.attachments);
  }

  function openAttachContext(action: AttachMenuAction): void {
    attachMenu.close("activate");
    if (action === "image") {
      attachmentController?.openFileInput();
      return;
    }
    const kindFilter = action === "database" ? "database" : action === "selection" ? "selection" : "file";
    requestAutocomplete("mention", "", kindFilter);
  }

  const attachMenu: AttachMenu = createAttachMenu({
    anchor: shell.composer,
    trigger: composer.attachButton,
    onAction: openAttachContext,
  });

  // ---- Active schema chip + context strip (TASK-CHATV2-013 / 011) ----------
  //
  // Both are PURE VIEWS of reducer state: the schema chip follows the host
  // `schema` frame, the strip renders `draft.context`. Neither scrapes the DOM,
  // and the controller remains the only transport for their intents.
  const schemaControl: SchemaControl = createSchemaControl({
    container: shell.context,
    id: COMPOSER_IDS.schema,
    onPickSchema: () => {
      postIntent({ kind: "pick_active_schema", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
    },
  });
  // The composer's center lane positions the chip (the schema slot) and keeps
  // the composer's footer lane at <=3 buttons.
  composer.setSchemaControl(schemaControl.element);

  const contextStrip: ContextChipStrip = createContextChipStrip({
    container: composer.contextList,
    previewAnchor: shell.composer,
    callbacks: {
      onPreview: (toRef) => previewContext(toRef),
      onRemove: (refId) => removeContextById(refId),
      onResolve: (toRef, choice) => resolveContext(toRef, choice),
    },
  });

  /** The exact wire ref behind a rendered chip (unrenderable refs fall back). */
  function wireRefFor(toRef: ContextRef): AiChatContextRefV2 {
    const source = toRef.source;
    return {
      id: toRef.id,
      kind: toRef.kind,
      label: toRef.label,
      detail: toRef.detail,
      displayToken: toRef.displayToken,
      source: source.type === "uri" ? source.uri : `${source.connectionId}.${source.schema}.${source.name}`,
      status: toRef.status,
      revision: toRef.snapshot.revision,
    };
  }

  /** Show the model-free metadata preview the strip builds locally. */
  function previewContext(toRef: ContextRef): void {
    contextStrip.showPreview(toRef);
    postIntent({
      kind: "preview_context",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: nextId(),
      ref: wireRefFor(toRef),
    });
  }

  /** Remove exactly ONE ref id — a duplicate label never removes a sibling. */
  function removeContextById(refId: string): void {
    dispatch({ type: "CONTEXT_REMOVED", refId });
    postIntent({
      kind: "remove_context",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: nextId(),
      refId,
    });
  }

  /** Ask the host to re-validate ONE ref; the host answer is authoritative. */
  function resolveContext(toRef: ContextRef, choice: ContextResolutionChoice): void {
    if (choice === "remove" || choice === "send_without") {
      removeContextById(toRef.id);
      return;
    }
    postIntent({
      kind: "resolve_context",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: nextId(),
      ref: wireRefFor(toRef),
    });
  }

  /** A ref the host resolved cleanly no longer blocks the next send. */
  function applyContextResolution(frame: AiChatHostFrameV2): void {
    if (frame.kind !== "context_resolved") return;
    const f = frame as { ref: AiChatContextRefV2; status: AiChatContextRefV2["status"] };
    dispatch({
      type: "CONTEXT_REF_RESOLVED",
      refId: f.ref.id,
      status: f.status ?? "ready",
    });
  }

  // ---- Shared slash / mention autocomplete ---------------------------------
  const autocomplete: AutocompleteView = createAutocompleteView({
    anchor: shell.composer,
    prompt,
    slashButton: composer.slashButton,
    emptyMessage: "No matching context",
    ariaLabel: "Chat suggestions",
  });

  function asContextRef(ref: AiChatContextRefV2): ContextRef {
    const isObject = ref.kind === "table" || ref.kind === "view" || ref.kind === "routine" || ref.kind === "schema";
    const source = ref.source ?? ref.detail ?? ref.id;
    const sourceParts = source.split(".");
    return {
      id: ref.id,
      kind: ref.kind,
      label: ref.label,
      detail: ref.detail ?? ref.label,
      displayToken: ref.displayToken ?? `@${ref.label}`,
      source: isObject
        ? {
            type: "object",
            connectionId: sourceParts[0] ?? "default",
            schema: sourceParts[1] ?? "",
            name: sourceParts.slice(2).join(".") || ref.label,
            objectKind: ref.kind,
          }
        : { type: "uri", uri: source },
      snapshot: { revision: ref.revision ?? "", capturedAt: null },
      status: ref.status ?? (ref.missing === true ? "missing" : ref.changed === true ? "changed" : "ready"),
      preview: { supported: true, reason: null },
    };
  }

  function openSlashAutocomplete(): void {
    const text = state.draft.text;
    const caret = state.draft.selectionEnd;
    let eligibility = slashEligibility(text, caret);
    if (!eligibility.eligible || eligibility.token === null) {
      const nextText = `${text.slice(0, caret)}/${text.slice(caret)}`;
      applyDraftEdit(nextText, caret + 1, caret + 1);
      eligibility = slashEligibility(nextText, caret + 1);
    }
    if (!eligibility.eligible || eligibility.token === null) return;
    dispatch({
      type: "AUTOCOMPLETE_OPENED",
      mode: "slash",
      requestId: nextId(),
      draftRevision: state.draft.revision,
      query: eligibility.token.query,
    });
  }

  function renderAutocomplete(): void {
    const ac = state.autocomplete;
    if (!ac.open) {
      autocomplete.close();
      return;
    }
    autocomplete.setOnInvoke((index) => acceptAutocomplete(index));
    autocomplete.setOnRetry(() => requestAutocomplete("mention", ac.query, undefined, true));
    if (ac.mode === "slash") {
      const commands = filterSlashCommands(
        resolveChatCommands({
          capabilities: state.capabilities,
          availableEngines: state.capabilities === null ? [] : [state.capabilities.engine],
          modelRoles: state.capabilities?.modelRoles.map((role) => role.role) ?? [],
        }),
        ac.query,
      );
      autocomplete.setRows(
        commands.map((command) => ({
          id: command.id,
          primary: `/${command.name}`,
          secondary: command.reason ?? command.description,
          syntax: command.syntax,
          unavailable: command.reason !== undefined,
          ...(command.providerLabel === undefined ? {} : { badge: command.providerLabel }),
        })),
        ac.activeIndex,
      );
      return;
    }
    if (ac.loading) {
      autocomplete.setLoading("Searching context…");
      return;
    }
    const structured = ac.items.filter((item): item is typeof item & { readonly ref: AiChatContextRefV2 } => item.ref !== undefined);
    if (structured.length === 0) {
      autocomplete.setStatus({ id: "mention-empty", text: "No matching context" });
      return;
    }
    autocomplete.setRows(
      buildMentionRows(structured.map((item) => asContextRef(item.ref))).map((row) => ({
        id: row.id,
        primary: row.primary,
        secondary: row.secondary,
        unavailable: row.unavailable,
        icon: row.icon,
        ...(row.groupLabel === undefined ? {} : { groupLabel: row.groupLabel }),
      })),
      ac.activeIndex,
    );
  }

  // ---- V2 surfaces (transcript · activity · scroll · announcer) -----------
  //
  // TASK-CHATV2-017: the V2 components that were built in earlier waves are now
  // mounted into the shell by their SINGLE owner (this controller) so production
  // boot is V2-only. Each is created once, rendered from reducer state in the
  // coalesced pass, and torn down by `dispose()`.
  const transcript: TranscriptRenderer = createTranscriptRenderer(
    {
      transcript: shell.transcript,
      statusLiveRegion: shell.statusLiveRegion,
      alertLiveRegion: shell.alertLiveRegion,
    },
    {
      onCopyAssistant(_messageId, raw) {
        writeClipboard(raw);
      },
      onCopyUser(_messageId, text) {
        writeClipboard(text);
      },
      // TASK-CHATFIX-004: put the message text back into the composer draft.
      // The coalesced composer.render paints the reducer's draft; the caret
      // lands at the end so Continue-typing just works.
      onEditUser(_messageId, text) {
        applyDraftEdit(text, text.length, text.length);
        try {
          prompt.focus();
        } catch {
          /* jsdom/older engines may reject focus. */
        }
      },
      // TASK-CHATFIX-004: re-issue the message through the ONE retry path.
      // `requestRetry` no-ops while a turn is busy; blank text never posts.
      onRetryUser(_messageId, text) {
        if (text.trim().length === 0) return;
        requestRetry({
          draft: {
            text,
            revision: state.draft.revision,
            context: [],
            attachments: [],
          },
        });
      },
      onMoreAssistant(_messageId, raw, trigger) {
        openMessageActions(raw, trigger);
      },
      onRegenerateAssistant() {
        requestRegenerate();
      },
      onLoadEarlier() {
        postIntent({ kind: "list_sessions", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
      },
    },
  );

  const activity: ActivityTimeline = createActivityTimeline({
    activities: shell.transcript,
    statusLiveRegion: shell.statusLiveRegion,
    alertLiveRegion: shell.alertLiveRegion,
    // TASK-CHATV2-017 group D: the header is the SINGLE pill writer — the
    // timeline no longer writes the engine button/label.
  });

  const scroll: ScrollController = createScrollController({
    viewport: shell.transcript,
    pillHost: shell.main,
    onProximityChange: (near) => {
      dispatch({ type: "SCROLL_PROXIMITY_CHANGED", distancePx: near ? 0 : SCROLL_FAR_PX });
    },
  });
  // TASK-CHATFIX-002: one explicit sync at mount so the pill/proximity state
  // reflects the live viewport even before the first coalesced pass runs.
  scroll.sync();

  const announcer: LiveAnnouncer = createLiveAnnouncer({
    polite: shell.statusLiveRegion,
    assertive: shell.alertLiveRegion,
  });

  // ---- V2 group D: header + engine/model menus (single ownership) ---------
  //
  // TASK-CHATV2-017: the 40px header is mounted ONCE by this controller. It
  // owns NEITHER the overflow menu NOR the session title — the sessions
  // surface already owns both from the same reducer state — so it mounts with
  // `ownOverflow: false` / `ownTitle: false` and contributes the engine pill,
  // its listbox and the ack-correlated switch flow.
  function engineEntriesFor(s: ChatViewState): readonly EngineMenuEntry[] {
    if (options.engineEntries !== undefined) return options.engineEntries;
    const caps = s.capabilities;
    if (caps === null) return [];
    // `fallback` IS the active engine working: the pill words it "Ready" and
    // the fallback reason rides the banner — the entry stays selectable.
    const status: EngineMenuEntry["status"] = caps.status === "fallback" ? "ready" : caps.status;
    return [{
      engine: caps.engine,
      displayName: caps.displayName,
      status,
      resolution: caps.reasonUnavailable ?? "",
      ...(status === "unavailable" ? { setupAvailable: true } : {}),
    }];
  }

  const engineSwitch: EngineSwitchView = createEngineSwitchView({
    mount: shell.root,
    getRequestId: nextId,
    postSetEngine: (clientRequestId, engine) =>
      postIntent({ kind: "set_engine", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId, engine }),
    postSetModel: (clientRequestId, role) =>
      postIntent({ kind: "set_model", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, clientRequestId, role }),
    // The ONE stop path (locks + STOP_REQUESTED dispatch). The view's own id is
    // not reused: the host correlates the turn, not this stop request.
    postStop: () => requestStop(),
    onToast: (message, level) => announcer.announceNow(message, level !== "info"),
    displayNameFor: (engine) =>
      state.capabilities !== null && state.capabilities.engine === engine
        ? state.capabilities.displayName
        : engineDisplayName(engine),
    // The pill/chip move via header.render / modelMenu.renderChip from the ACK
    // frames the reducer already applied — never optimistically.
    onEngineCommitted: () => {},
    onModelCommitted: () => {},
  });

  const header: ChatHeaderView = createChatHeader({
    header: shell.header,
    ownTitle: false,
    ownOverflow: false,
    engineEntries: engineEntriesFor(state),
    onEngineOpen: () => header.setEngineEntries(engineEntriesFor(state)),
    callbacks: {
      // Owned by the sessions surface; unreachable while ownTitle/ownOverflow
      // are false — the seams exist so a future caller can flip them safely.
      onRenameSubmit: () => {},
      onOverflowAction: () => {},
      onSelectEngine: (engine) => {
        header.engineMenu.close();
        if (busyPhase(state.phase)) engineSwitch.requestBusy(engine);
        else engineSwitch.requestIdle(engine);
      },
      onEngineSetup: () => {
        header.engineMenu.close();
        postIntent({ kind: "open_settings", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
      },
    },
  });

  const modelMenu: ModelMenuView = createModelMenu({
    anchor: shell.composer,
    trigger: composer.modelButton,
    onSelectModel: (role) => {
      modelMenu.close();
      engineSwitch.requestModel(role);
    },
    onOpenSettings: () => postIntent({ kind: "open_settings", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 }),
  });

  /** Best-effort clipboard write for transcript Copy actions (never throws,
   * never leaves a rejected promise unhandled — the transcript's own toast
   * reports the failure). */
  function writeClipboard(text: string): void {
    try {
      const nav = (globalThis as {
        navigator?: { clipboard?: { writeText(t: string): Promise<void> } };
      }).navigator;
      nav?.clipboard?.writeText(text)?.catch(() => {
        /* clipboard rejection is advisory — the renderer already announced it */
      });
    } catch {
      /* clipboard is unavailable in some hosts — the action is advisory */
    }
  }

  // ---- Message actions (TASK-CHATFIX-004) --------------------------------
  //
  // The assistant 3-dot overflow opens ONE non-modal `createOverlayMenu` per
  // clicked trigger, anchored to the shell root, carrying exactly the two
  // actions the host already supports: Copy + Regenerate.

  /** The single regenerate intent (shared by the row button and the menu). */
  function requestRegenerate(): void {
    postIntent({
      kind: "regenerate",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: nextId(),
    });
  }

  /** Live 3-dot menu + the trigger it is wired to (one menu at a time). */
  let messageMenu: OverlayMenu | null = null;
  let messageMenuTrigger: HTMLElement | null = null;

  /** Open the assistant message's overflow menu from its clicked trigger. */
  function openMessageActions(raw: string, trigger?: HTMLElement): void {
    if (disposed || trigger === undefined) return;
    if (messageMenu !== null && messageMenuTrigger !== trigger) {
      // A different message's button: tear the old menu down before re-anchoring.
      messageMenu.destroy();
      messageMenu = null;
    }
    if (messageMenu === null) {
      const menu = createOverlayMenu({
        anchor: shell.root,
        trigger,
        ariaLabel: "Message actions",
        onActivate: (row) => {
          menu.close("select");
          if (row.id === "copy") writeClipboard(raw);
          else if (row.id === "regenerate") requestRegenerate();
        },
      });
      // The trigger keeps focus while the menu is open (non-modal contract),
      // so its keydown owns listbox routing (same pattern as the header menus).
      trigger.addEventListener("keydown", (event) => {
        menu.handleKey(event);
      });
      messageMenu = menu;
      messageMenuTrigger = trigger;
    }
    messageMenu.setRows([
      { id: "copy", label: "Copy message", icon: "copy" },
      { id: "regenerate", label: "Regenerate response", icon: "retry" },
    ]);
    messageMenu.open();
  }

  /** Announce the current phase without letting a stream chunk reach a region. */
  let lastPhase: TurnPhase | null = null;
  function announcePhase(phase: TurnPhase): void {
    if (phase === lastPhase) return;
    lastPhase = phase;
    if (phase === "idle") return;
    if (phase === "failed") {
      announcer.announceNow(FAILED_ANNOUNCEMENT, true);
      return;
    }
    announcer.announcePhase(phaseCopyLabel(phase), phase === "awaiting_permission");
  }

  // ---- Permission policy + request sheet (TASK-CHATV2-014) ----------------
  //
  // The composer chip opens a NON-MODAL policy sheet. Bypass is offered only
  // when the host capability says so, and enabling it always goes through the
  // MODAL warning first; the intent is posted but state only follows the host
  // ack. The request sheet owns the single response for one pending request.
  const permission = createPolicySheet({
    anchor: shell.composer,
    trigger: composer.permissionButton,
    supportsBypass: state.capabilities?.supports.bypassPermissions === true,
    currentPolicy: state.permissionPolicy,
    onRequestBypass: () => bypassWarning.open(),
    onClose: () => {
      // Closing the policy sheet returns the keyboard to the composer.
      try {
        prompt.focus();
      } catch {
        /* jsdom/older engines may reject focus. */
      }
    },
  });

  const bypassWarning: BypassWarning = createBypassWarning({
    mount: shell.composer,
    onEnable: () => {
      postIntent({
        kind: "set_permission_policy",
        protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
        clientRequestId: nextId(),
        policy: "bypass",
      });
      // No optimistic flip: the chip changes only when the host acks.
      try {
        prompt.focus();
      } catch {
        /* jsdom/older engines may reject focus. */
      }
    },
  });

  const permissionRequest: PermissionRequestSheet = createPermissionRequestSheet({
    anchor: shell.composer,
    composer: prompt,
    liveRegion: shell.alertLiveRegion,
    onRespond: (response) => {
      postIntent({
        kind: "permission_response",
        protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
        clientRequestId: nextId(),
        requestId: response.requestId,
        ...(response.optionId !== undefined ? { optionId: response.optionId } : {}),
      });
      dispatch({ type: "PERMISSION_RESPONDED", requestId: response.requestId });
    },
  });

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
    attachmentController?.markSubmitted(
      clientRequestId,
      pending.draft.attachments.map((attachment) => attachment.id),
    );
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

  /** Re-issue a card-captured structured request with a fresh opaque id. */
  function requestRetry(request: { readonly draft: ChatViewState["draft"] }): void {
    if (disposed || busyPhase(state.phase)) return;
    const clientRequestId = nextId();
    submitLock = clientRequestId;
    dispatch({ type: "SUBMIT_REQUESTED", clientRequestId, draft: request.draft });
    const pending = state.pendingSubmit;
    if (pending === null || pending.clientRequestId !== clientRequestId) return;
    attachmentController?.markSubmitted(
      clientRequestId,
      pending.draft.attachments.map((attachment) => attachment.id),
    );
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

  function requestAutocomplete(
    mode: ComposerMode,
    query: string,
    kindFilter?: AiChatContextKindFilterV2,
    force = false,
  ): void {
    if (disposed) return;
    const current = state.autocomplete;
    if (
      !force &&
      current.open &&
      current.mode === mode &&
      current.query === query &&
      current.draftRevision === state.draft.revision
    ) {
      return;
    }
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
      ...(kindFilter === undefined ? {} : { kindFilter }),
    });
  }

  function syncAutocompleteFromDraft(): void {
    if (disposed) return;
    const { text, selectionEnd, revision } = state.draft;
    const slash = slashEligibility(text, selectionEnd);
    if (slash.eligible && slash.token !== null) {
      if (
        !state.autocomplete.open ||
        state.autocomplete.mode !== "slash" ||
        state.autocomplete.query !== slash.token.query ||
        state.autocomplete.draftRevision !== revision
      ) {
        dispatch({
          type: "AUTOCOMPLETE_OPENED",
          mode: "slash",
          requestId: nextId(),
          draftRevision: revision,
          query: slash.token.query,
        });
      }
      return;
    }
    const mention = mentionEligibility(text, selectionEnd);
    if (!mention.eligible || mention.token === null) {
      if (state.autocomplete.open) dispatch({ type: "AUTOCOMPLETE_CLOSED", reason: "selection" });
      return;
    }
    if (
      state.autocomplete.open &&
      state.autocomplete.mode === "mention" &&
      state.autocomplete.query === mention.token.query &&
      state.autocomplete.draftRevision === revision
    ) {
      return;
    }
    requestAutocomplete("mention", mention.token.query);
  }

  /** Accept a visible autocomplete row through its typed slash/mention semantic. */
  function acceptAutocomplete(index = state.autocomplete.activeIndex): void {
    const ac = state.autocomplete;
    const item = ac.items[index];
    const text = state.draft.text;
    if (ac.mode === "slash") {
      const commands = filterSlashCommands(
        resolveChatCommands({
          capabilities: state.capabilities,
          availableEngines: state.capabilities === null ? [] : [state.capabilities.engine],
          modelRoles: state.capabilities?.modelRoles.map((role) => role.role) ?? [],
        }),
        ac.query,
      );
      const command = commands[index];
      const edit = command === undefined ? null : slashAcceptEdit(text, state.draft.selectionEnd, command);
      if (edit !== null) applyDraftEdit(edit.text, edit.selectionStart, edit.selectionEnd);
    } else if (item !== undefined) {
      const eligibility = mentionEligibility(text, state.draft.selectionEnd);
      if (item.ref === undefined) {
        const token = item.token;
        if (eligibility.token !== null && token.length > 0) {
          const edit = replaceSelection(
            text,
            eligibility.token.start,
            eligibility.token.end,
            `@${token.replace(/^@/, "")} `,
          );
          applyDraftEdit(edit.text, edit.selectionStart, edit.selectionEnd);
        }
      } else {
        const edit = eligibility.token === null ? null : mentionAcceptEdit(text, eligibility.token, asContextRef(item.ref));
        if (edit !== null) {
          applyDraftEdit(edit.text, edit.selectionStart, edit.selectionEnd);
          dispatch({ type: "CONTEXT_ADDED", ref: item.ref });
        }
      }
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
      // TASK-CHATV2-014: while the request sheet is open it owns the keyboard
      // (the composer must not submit a draft behind it). An injected gate
      // still wins so tests/hosts can force the behavior.
      permissionFocused:
        (options.isPermissionFocused?.() === true || permissionRequest.isOpen()),
      autocompleteOpen: state.autocomplete.open,
      autocompleteItemCount:
        state.autocomplete.mode === "slash"
          ? filterSlashCommands(
              resolveChatCommands({
                capabilities: state.capabilities,
                availableEngines: state.capabilities === null ? [] : [state.capabilities.engine],
                modelRoles: state.capabilities?.modelRoles.map((role) => role.role) ?? [],
              }),
              state.autocomplete.query,
            ).length
          : state.autocomplete.items.length,
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
    // The host's re-validated ref status is authoritative and settles exactly
    // the one ref it names (CHATV2-011).
    applyContextResolution(frame);
    sessions.applyHostFrame(frame);
    // TASK-CHATV2-017 group D: the switch flow correlates ack-bearing
    // capabilities/models frames + turn end; runs before the kind-specific
    // early returns so it sees every frame.
    engineSwitch.handleHostFrame(frame);

    // Ack/rejection bookkeeping runs against the post-dispatch state.
    if (frame.kind === "turn_started") {
      const f = frame as { clientRequestId: string };
      // Gate FIRST, synchronously: a legacy twin frame in the NEXT message
      // must already see the V2 seam as the turn's only renderer.
      options.onV2TurnGate?.(true);
      attachmentController?.acknowledgeSubmit(f.clientRequestId);
      if (submitLock !== null && f.clientRequestId === submitLock) submitLock = null;
      releaseStopLock();
      return;
    }
    if (frame.kind === "turn_finished") {
      options.onV2TurnGate?.(false);
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
    openResumePicker: () => sessions.openResumePicker(),
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
      // TASK-CHATV2-014: tear down the permission surfaces. The request sheet
      // settles first (it restores focus), then the policy sheet + warning.
      permissionRequest.destroy();
      bypassWarning.destroy();
      permission.destroy();
      changePlanCard?.destroy();
      changePlanCard = null;
      errorCard?.destroy();
      errorCard = null;
      sessions.dispose();
      // TASK-CHATV2-017 group D: the header + its menus go with it so a remount
      // leaves no node or listener behind.
      engineSwitch.destroy();
      modelMenu.destroy();
      header.destroy();
      contextStrip.destroy();
      schemaControl.destroy();
      autocomplete.destroy();
      attachMenu.destroy();
      attachmentController?.destroy();
      attachmentController = null;
      shell.banner.hidden = true;
      // TASK-CHATV2-017: tear down the V2 surfaces so a remount leaves no node,
      // timer or listener behind.
      messageMenu?.destroy();
      messageMenu = null;
      messageMenuTrigger = null;
      announcer.destroy();
      activity.dispose();
      transcript.dispose();
      scroll.destroy();
      activeMounts.delete(root);
      composer.destroy();
    },
  };

  activeMounts.set(root, controller);
  return controller;
}

/** The exact composer prompt id this controller binds — re-exported for tests. */
export const CONTROLLER_PROMPT_ID = COMPOSER_IDS.prompt;
