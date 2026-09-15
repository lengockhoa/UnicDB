// webview/aiChat/keyboard.ts — TASK-CHATV2-009
//
// The PURE half of the single composer keyboard controller. Two pure
// functions live here so the whole precedence table is testable without a DOM,
// a timer or a transport:
//
//   - `decideComposerKey(input)` — the immutable precedence ladder from PLAN §4.
//     It returns a semantic decision; it NEVER touches an event, a timer or a
//     host transport. The controller turns the decision into
//     `preventDefault()` + a dispatch.
//   - `replaceSelection(text, start, end, insert)` — the exact text edit a
//     Shift+Enter (or a slash/mention token insert) performs, preserving the
//     untouched bytes on both sides.
//
// PURITY CONTRACT: no `vscode`, no DOM, no clock, no `Math.random`. Pure
// functions of their arguments.

import type { TurnPhase } from "./store";

/** Phases in which a plain Enter may submit. Everything else keeps the draft
 * editable but refuses an implicit send/queue (PLAN §4). */
const SUBMITTABLE_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  "idle",
  "completed",
  "failed",
]);

/** Rows a PageUp/PageDown moves the autocomplete active row by. */
export const AUTOCOMPLETE_PAGE_DELTA = 5;

/** True when a plain Enter may submit in this phase (idle/completed/failed). */
export function isSubmittablePhase(phase: TurnPhase): boolean {
  return SUBMITTABLE_PHASES.has(phase);
}

/**
 * The semantic outcome of one keydown. `prevent` is the controller's only
 * licence to call `preventDefault()`; `ignore`/`native` explicitly mean the
 * browser keeps native textarea behavior.
 */
export type ComposerKeyDecision =
  /** IME composition (or the 229 sentinel): never prevent, never select, never
   * send — the platform owns the keystroke. */
  | { readonly kind: "ignore" }
  /** Shift+Enter: insert exactly one `\n` over the selection. */
  | { readonly kind: "insert-newline" }
  /** A focused permission sheet owns the key; this controller steps aside. */
  | { readonly kind: "delegate-permission" }
  /** Move the autocomplete active row by `delta`. */
  | { readonly kind: "autocomplete-move"; readonly delta: number }
  /** Accept the active autocomplete row (Enter/Tab). Never submits. */
  | { readonly kind: "autocomplete-accept" }
  /** Esc with a popover open: close exactly that surface. */
  | { readonly kind: "autocomplete-close" }
  /** Ctrl/Cmd+Enter: prevent the chat submit and leave the text untouched. */
  | { readonly kind: "consume-modifier-enter" }
  /** Plain Enter on a valid draft in idle/completed/failed: submit once. */
  | { readonly kind: "submit" }
  /** Anything else: let the native textarea behavior run. */
  | { readonly kind: "native" };

/** Every fact `decideComposerKey` needs. Deliberately a plain object so tests
 * can construct a case without a real `KeyboardEvent`. */
export interface ComposerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  /** `KeyboardEvent.isComposing`. */
  readonly isComposing: boolean;
  /** Raw `KeyboardEvent.keyCode` (the 229 IME sentinel is not expressible via
   * the modern `key` string, so it must be read directly). */
  readonly keyCode: number;
  /** compositionstart..compositionend tracked state owned by the controller. */
  readonly composing: boolean;
  readonly phase: TurnPhase;
  /** Current draft text (submit requires a non-blank draft). */
  readonly draftText: string;
  /** True when a context ref is changed/missing and must be resolved first. */
  readonly hasUnresolvedContext: boolean;
  /** A permission sheet currently holds focus. */
  readonly permissionFocused: boolean;
  readonly autocompleteOpen: boolean;
  /** Number of rows currently in the autocomplete list. */
  readonly autocompleteItemCount: number;
}

function isComposition(input: ComposerKeyInput): boolean {
  return input.isComposing || input.composing || input.keyCode === 229;
}

function modifiersClean(input: ComposerKeyInput): boolean {
  return !input.ctrlKey && !input.metaKey && !input.altKey;
}

/** True when a draft may be submitted: non-blank and no unresolved context. */
export function canSubmitDraft(input: {
  readonly phase: TurnPhase;
  readonly draftText: string;
  readonly hasUnresolvedContext: boolean;
}): boolean {
  if (!isSubmittablePhase(input.phase)) return false;
  if (input.draftText.trim().length === 0) return false;
  if (input.hasUnresolvedContext) return false;
  return true;
}

/**
 * The immutable precedence ladder (PLAN §4). Order is load-bearing:
 * composition → Shift+Enter → permission sheet → autocomplete →
 * Ctrl/Cmd+Enter → plain Enter → native.
 */
export function decideComposerKey(input: ComposerKeyInput): ComposerKeyDecision {
  // (1) IME composition wins over everything: no prevent, no select, no send.
  if (isComposition(input)) return { kind: "ignore" };

  // (2) Shift+Enter always inserts one newline — even with autocomplete open.
  if (input.key === "Enter" && input.shiftKey) return { kind: "insert-newline" };

  // (3) A focused permission sheet delegates.
  if (input.permissionFocused) return { kind: "delegate-permission" };

  // (4) An open autocomplete popover owns navigation/selection/dismiss keys.
  if (input.autocompleteOpen) {
    switch (input.key) {
      case "ArrowDown":
        return { kind: "autocomplete-move", delta: 1 };
      case "ArrowUp":
        return { kind: "autocomplete-move", delta: -1 };
      case "PageDown":
        return { kind: "autocomplete-move", delta: AUTOCOMPLETE_PAGE_DELTA };
      case "PageUp":
        return { kind: "autocomplete-move", delta: -AUTOCOMPLETE_PAGE_DELTA };
      case "Enter":
      case "Tab":
        // Accepting a row inserts/accepts; it NEVER submits.
        return input.autocompleteItemCount > 0
          ? { kind: "autocomplete-accept" }
          : { kind: "autocomplete-close" };
      case "Escape":
        // Esc closes ONE transient surface and never clears text.
        return { kind: "autocomplete-close" };
      default:
        break;
    }
  }

  // (5) Ctrl/Cmd+Enter prevents the chat submit and leaves the text intact.
  if (input.key === "Enter" && (input.ctrlKey || input.metaKey)) {
    return { kind: "consume-modifier-enter" };
  }

  // (6) Plain Enter submits only a valid draft in a submittable phase.
  if (input.key === "Enter" && modifiersClean(input)) {
    return canSubmitDraft(input) ? { kind: "submit" } : { kind: "native" };
  }

  // (7) Everything else is native textarea behavior.
  return { kind: "native" };
}

/** The result of a range replacement: the new text plus the caret to apply. */
export interface TextRangeEdit {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * Replace `[start, end)` in `text` with `insert`, returning the new text and a
 * collapsed caret after the inserted run.
 *
 * Byte/offset discipline: the untouched prefix and suffix are returned
 * verbatim — no CRLF→LF normalization, no trimming. Offsets are JS string
 * (UTF-16) offsets, exactly what `HTMLTextAreaElement.selectionStart` yields,
 * so a surrogate pair is selected/inserted as one unit only when the platform
 * reports it that way. Reversed or out-of-range indexes are clamped, never
 * thrown on.
 */
export function replaceSelection(
  text: string,
  start: number,
  end: number,
  insert: string,
): TextRangeEdit {
  const len = text.length;
  const a = clampIndex(start, len);
  const b = clampIndex(end, len);
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const next = text.slice(0, from) + insert + text.slice(to);
  const caret = from + insert.length;
  return { text: next, selectionStart: caret, selectionEnd: caret };
}

/** Clamp a (possibly NaN / -0 / out-of-range) selection index into [0, len]. */
function clampIndex(value: number, len: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), len);
}
