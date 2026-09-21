// webview/aiChat/shell.ts — TASK-CHATV2-005
//
// The semantic V2 skeleton: ONE vertical grid (header · banner · transcript ·
// context strip · composer) plus the two visually-hidden aria-live regions
// every later V2 component announces through. The keyboard hint lives inside
// the composer card as a `-footnote`; usage + engine lifecycle stats live in
// the header's right zone.
//
// CONTRACT
// - `mountChatShell(root)` is idempotent: repeated calls reuse the existing
//   tree (stable node identities, stable live-region ids) and never append a
//   second header, main, composer, live region or listener.
// - The shell only creates STRUCTURE + placeholder mount points. It never
//   wires production behavior, never duplicates a V1 control that carries a
//   legacy id, and never renders untrusted text (all copy is `textContent`).
// - Every element it creates is class-scoped with the `UnicDB-ai-chat-v2`
//   prefix so `webview/aiChat/styles.css` owns all styling.
//
// Pure DOM TypeScript: no `vscode`, no node builtins.

import { createChatIcon } from "./icons";

/** Root class the V2 shell (and the migration root) carries. */
export const CHAT_V2_ROOT_CLASS = "UnicDB-ai-chat-v2";

/** Stable, closed set of live-region ids. Never renamed — assistive tech and
 * later tasks address these by id. */
export const CHAT_V2_STATUS_LIVE_ID = "UnicDB-ai-chat-v2-status-live";
export const CHAT_V2_ALERT_LIVE_ID = "UnicDB-ai-chat-v2-alert-live";

/** Marker attribute proving the shell mounted exactly once on a root. */
export const CHAT_V2_SHELL_MARKER = "data-chat-v2-shell";
/** Listener-registration counter (idempotency proof). */
export const CHAT_V2_LISTENER_MARKER = "data-chat-v2-listeners";

/** Product display name shown in the header. Constant copy, never host data. */
const PRODUCT_TITLE = "UnicDB AI";

/** Keyboard hint copy (fixed, PLAN §4 precedence summary). */
const KEYBOARD_HINT = "Enter to send · Shift+Enter for a new line";

/** Canonical screenshot fixtures for manual visual verification (PLAN §8:
 * jsdom cannot prove layout, so the reviewer captures these). Widths are the
 * responsive boundaries (320/420/768) crossed with the theme matrix
 * (dark/light/high-contrast) — no visual claim is accepted from jsdom alone. */
export const CHAT_V2_SCREENSHOT_FIXTURES: readonly string[] = Object.freeze(
  [320, 420, 768].flatMap((w) =>
    ["dark", "light", "high-contrast"].map((theme) => `chat-v2-${w}-${theme}.png`),
  ),
);

/** Element handles the shell exposes to later V2 tasks. */
export interface ChatShellRefs {
  readonly root: HTMLElement;
  readonly header: HTMLElement;
  readonly banner: HTMLElement;
  readonly main: HTMLElement;
  readonly transcript: HTMLElement;
  readonly context: HTMLElement;
  readonly composer: HTMLElement;
  readonly composerTop: HTMLElement;
  readonly composerBottom: HTMLElement;
  readonly actions: HTMLElement;
  /** Keyboard-hint footnote inside the composer card (sibling AFTER
   *  composerBottom so renderComposerV2's bottom.replaceChildren() cannot
   *  remove it). */
  readonly footnote: HTMLElement;
  /** Header right-zone mount for the legacy `#usageChip` (hidden until the
   *  first `usage` frame). */
  readonly usage: HTMLElement;
  /** Header right-zone mount for the legacy `#engineLifecycle` chip (hidden
   *  until the first `engine_state` frame). */
  readonly engineState: HTMLElement;
  readonly statusLiveRegion: HTMLElement;
  readonly alertLiveRegion: HTMLElement;
}

/** Roots already carrying a mounted shell (idempotency guard). */
const mountedShells = new WeakMap<HTMLElement, ChatShellRefs>();

/** Per-root listener-registration counter (idempotency proof). */
const listenerCounts = new WeakMap<HTMLElement, number>();

/** Build a div with one or more V2-scoped classes. */
function div(...classes: string[]): HTMLDivElement {
  const el = document.createElement("div");
  el.className = classes.join(" ");
  return el;
}

/** Build a button with one or more V2-scoped classes. */
function button(...classes: string[]): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = classes.join(" ");
  return el;
}

function prefix(name: string): string {
  return `${CHAT_V2_ROOT_CLASS}-${name}`;
}

/**
 * Register exactly one listener per (root, target, type) and bump the
 * observable counter. The idempotency guard prevents a second call for a
 * mounted root, so the counter proves the shell never double-binds.
 */
function registerShellListener(
  root: HTMLElement,
  target: EventTarget,
  type: string,
  handler: EventListener,
): void {
  target.addEventListener(type, handler);
  const next = (listenerCounts.get(root) ?? 0) + 1;
  listenerCounts.set(root, next);
  root.setAttribute(CHAT_V2_LISTENER_MARKER, String(next));
}

/** Build the header block (mark · title · engine pill · overflow). */
function buildHeader(root: HTMLElement): HTMLElement {
  const header = div(prefix("header"));

  const mark = div(prefix("mark"));
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(createChatIcon("database", 16));
  header.appendChild(mark);

  const title = document.createElement("span");
  title.className = prefix("title");
  title.textContent = PRODUCT_TITLE;
  header.appendChild(title);

  const engine = button(prefix("engine"), prefix("engine-ready"));
  engine.id = prefix("engine");
  engine.setAttribute("aria-label", "Engine status");
  engine.title = "Engine status";
  const dot = document.createElement("span");
  dot.className = prefix("engine-dot");
  dot.setAttribute("aria-hidden", "true");
  engine.appendChild(dot);
  engine.appendChild(createChatIcon("plug", 16));
  const engineLabel = document.createElement("span");
  engineLabel.className = `${prefix("engine-label")} ${prefix("label-optional")}`;
  engineLabel.textContent = "Ready";
  engine.appendChild(engineLabel);
  header.appendChild(engine);

  // Header right zone (CHATUX2-001): the legacy usage + engine-lifecycle
  // chips mount into these spans — hidden until their first frame.
  const engineState = document.createElement("span");
  engineState.className = prefix("engine-state");
  engineState.id = prefix("engine-state");
  engineState.hidden = true;
  header.appendChild(engineState);

  const usage = document.createElement("span");
  usage.className = prefix("usage");
  usage.id = prefix("usage");
  usage.hidden = true;
  header.appendChild(usage);

  const overflow = button(prefix("control"), prefix("overflow"));
  overflow.id = prefix("overflow");
  overflow.setAttribute("aria-label", "More actions");
  overflow.title = "More actions";
  overflow.appendChild(createChatIcon("ellipsis", 16));
  header.appendChild(overflow);

  // One listener proves single-bind idempotency; behavior lands in a later
  // task. `keydown` on the header is inert and never mutates state.
  registerShellListener(root, header, "keydown", () => {
    /* placeholder — owned by CHATV2-006+ */
  });

  return header;
}

/** Build one visually-hidden aria-live region with a stable id. */
function buildLiveRegion(id: string, live: "polite" | "assertive"): HTMLElement {
  const region = div(prefix("visually-hidden"), prefix("live-region"));
  region.id = id;
  region.setAttribute("aria-live", live);
  region.setAttribute("aria-atomic", "true");
  region.setAttribute("role", live === "assertive" ? "alert" : "status");
  return region;
}

/**
 * Mount (or reuse) the V2 shell on `root`.
 *
 * @returns The stable {@link ChatShellRefs} for this root. Calling again with
 *   the same root returns the identical refs object.
 */
export function mountChatShell(root: HTMLElement): ChatShellRefs {
  const existing = mountedShells.get(root);
  if (existing) return existing;

  root.classList.add(CHAT_V2_ROOT_CLASS);
  // Seed the listener counter BEFORE any registration so the first
  // registerShellListener() bump is the value observable at the end.
  root.setAttribute(CHAT_V2_LISTENER_MARKER, "0");
  root.setAttribute(CHAT_V2_SHELL_MARKER, "1");

  const header = buildHeader(root);

  const banner = div(prefix("banner"));
  banner.hidden = true;

  const main = document.createElement("main");
  main.className = prefix("main");

  const transcript = div(prefix("transcript"));
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", "Conversation");
  main.appendChild(transcript);

  const context = div(prefix("context"));
  context.hidden = true;
  context.setAttribute("aria-label", "Attached context");
  main.appendChild(context);

  const composer = div(prefix("composer"));
  const composerTop = div(prefix("composer-top"));
  const composerBottom = div(prefix("composer-bottom"));
  const actions = div(prefix("actions"));
  composerBottom.appendChild(actions);
  composer.appendChild(composerTop);
  composer.appendChild(composerBottom);
  // CHATUX2-001: the keyboard hint is a footnote INSIDE the composer card —
  // a sibling of composerBottom (never a child: renderComposerV2 calls
  // bottom.replaceChildren() and would delete it).
  const footnote = div(prefix("footnote"));
  footnote.textContent = KEYBOARD_HINT;
  composer.appendChild(footnote);

  const statusLiveRegion = buildLiveRegion(CHAT_V2_STATUS_LIVE_ID, "polite");
  const alertLiveRegion = buildLiveRegion(CHAT_V2_ALERT_LIVE_ID, "assertive");

  root.appendChild(header);
  root.appendChild(banner);
  root.appendChild(main);
  root.appendChild(composer);
  root.appendChild(statusLiveRegion);
  root.appendChild(alertLiveRegion);

  const refs: ChatShellRefs = {
    root,
    header,
    banner,
    main,
    transcript,
    context,
    composer,
    composerTop,
    composerBottom,
    actions,
    footnote,
    usage: header.querySelector<HTMLElement>(`.${prefix("usage")}`)!,
    engineState: header.querySelector<HTMLElement>(`.${prefix("engine-state")}`)!,
    statusLiveRegion,
    alertLiveRegion,
  };
  mountedShells.set(root, refs);
  return refs;
}

/**
 * Idempotent convenience wrapper: mount only if `root` has no shell yet.
 * Equivalent to {@link mountChatShell} but reads from the DOM rather than the
 * in-memory guard, so it also recovers across module reloads.
 */
export function mountChatShellIfNeeded(root: HTMLElement): ChatShellRefs {
  const existing = mountedShells.get(root);
  if (existing) return existing;
  if (root.getAttribute(CHAT_V2_SHELL_MARKER) !== "1") {
    return mountChatShell(root);
  }
  // Marker present but refs lost (module reload) — rebuild refs from the DOM
  // WITHOUT appending duplicate nodes.
  const header = root.querySelector<HTMLElement>(`.${prefix("header")}`);
  const banner = root.querySelector<HTMLElement>(`.${prefix("banner")}`);
  const main = root.querySelector<HTMLElement>(`.${prefix("main")}`);
  const transcript = root.querySelector<HTMLElement>(`.${prefix("transcript")}`);
  const context = root.querySelector<HTMLElement>(`.${prefix("context")}`);
  const composer = root.querySelector<HTMLElement>(`.${prefix("composer")}`);
  const composerTop = root.querySelector<HTMLElement>(`.${prefix("composer-top")}`);
  const composerBottom = root.querySelector<HTMLElement>(`.${prefix("composer-bottom")}`);
  const actions = root.querySelector<HTMLElement>(`.${prefix("actions")}`);
  const footnote = root.querySelector<HTMLElement>(`.${prefix("footnote")}`);
  const usage = root.querySelector<HTMLElement>(`.${prefix("usage")}`);
  const engineState = root.querySelector<HTMLElement>(`.${prefix("engine-state")}`);
  const statusLiveRegion = document.getElementById(CHAT_V2_STATUS_LIVE_ID);
  const alertLiveRegion = document.getElementById(CHAT_V2_ALERT_LIVE_ID);
  if (
    !header ||
    !banner ||
    !main ||
    !transcript ||
    !context ||
    !composer ||
    !composerTop ||
    !composerBottom ||
    !actions ||
    !footnote ||
    !usage ||
    !engineState ||
    !statusLiveRegion ||
    !alertLiveRegion
  ) {
    return mountChatShell(root);
  }
  const refs: ChatShellRefs = {
    root,
    header,
    banner,
    main,
    transcript,
    context,
    composer,
    composerTop,
    composerBottom,
    actions,
    footnote,
    usage,
    engineState,
    statusLiveRegion,
    alertLiveRegion,
  };
  mountedShells.set(root, refs);
  return refs;
}
