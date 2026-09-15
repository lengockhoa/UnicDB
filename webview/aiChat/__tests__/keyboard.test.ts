// webview/aiChat/__tests__/keyboard.test.ts — TASK-CHATV2-009
//
// Covers the pure precedence ladder (KBD-01..KBD-04 + the full order) and the
// pure range-edit helper. No DOM, no timers, no transport — these are plain
// functions of their arguments.
import { describe, expect, it } from "vitest";

import {
  AUTOCOMPLETE_PAGE_DELTA,
  canSubmitDraft,
  decideComposerKey,
  isSubmittablePhase,
  replaceSelection,
  type ComposerKeyInput,
} from "../keyboard";
import type { TurnPhase } from "../store";

/** Build a key input with sane defaults so each test states only what matters. */
function key(overrides: Partial<ComposerKeyInput> = {}): ComposerKeyInput {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    composing: false,
    phase: "idle",
    draftText: "hello",
    hasUnresolvedContext: false,
    permissionFocused: false,
    autocompleteOpen: false,
    autocompleteItemCount: 0,
    ...overrides,
  };
}

describe("decideComposerKey — precedence (PLAN §4)", () => {
  // KBD-01: plain Enter in idle submits.
  it("plain Enter on a valid idle draft → submit", () => {
    expect(decideComposerKey(key())).toEqual({ kind: "submit" });
  });

  it("plain Enter on an empty/blank draft → native (never an empty send)", () => {
    expect(decideComposerKey(key({ draftText: "" }))).toEqual({ kind: "native" });
    expect(decideComposerKey(key({ draftText: "   \n  " }))).toEqual({ kind: "native" });
  });

  it("plain Enter with unresolved context → native", () => {
    expect(decideComposerKey(key({ hasUnresolvedContext: true }))).toEqual({ kind: "native" });
  });

  // KBD-06 regression: busy phases keep the draft editable but refuse submit.
  it("plain Enter in every busy phase → native (no submit/queue)", () => {
    const busy: TurnPhase[] = [
      "validating",
      "connecting",
      "waiting_for_first_event",
      "streaming",
      "awaiting_permission",
      "stopping",
    ];
    for (const phase of busy) {
      expect(decideComposerKey(key({ phase }))).toEqual({ kind: "native" });
      expect(canSubmitDraft({ phase, draftText: "hello", hasUnresolvedContext: false })).toBe(
        false,
      );
    }
  });

  it("plain Enter submits after completed/failed (a new turn is allowed)", () => {
    expect(decideComposerKey(key({ phase: "completed" }))).toEqual({ kind: "submit" });
    expect(decideComposerKey(key({ phase: "failed" }))).toEqual({ kind: "submit" });
  });

  // KBD-02: Shift+Enter inserts a newline in every phase, even with autocomplete.
  it("Shift+Enter → insert-newline in all phases", () => {
    const phases: TurnPhase[] = [
      "idle",
      "validating",
      "connecting",
      "waiting_for_first_event",
      "streaming",
      "awaiting_permission",
      "stopping",
      "completed",
      "failed",
    ];
    for (const phase of phases) {
      expect(decideComposerKey(key({ shiftKey: true, phase }))).toEqual({
        kind: "insert-newline",
      });
    }
  });

  it("Shift+Enter WINS over an open autocomplete popover", () => {
    expect(
      decideComposerKey(key({ shiftKey: true, autocompleteOpen: true, autocompleteItemCount: 3 })),
    ).toEqual({ kind: "insert-newline" });
  });

  // KBD-03: IME composition.
  it("isComposing / composing / keyCode 229 → ignore (no prevent/select/send)", () => {
    expect(decideComposerKey(key({ isComposing: true }))).toEqual({ kind: "ignore" });
    expect(decideComposerKey(key({ composing: true }))).toEqual({ kind: "ignore" });
    expect(decideComposerKey(key({ keyCode: 229 }))).toEqual({ kind: "ignore" });
    // Even Shift+Enter/Enter under composition must not be reinterpreted.
    expect(decideComposerKey(key({ shiftKey: true, isComposing: true }))).toEqual({
      kind: "ignore",
    });
    expect(
      decideComposerKey(key({ isComposing: true, autocompleteOpen: true, autocompleteItemCount: 3 })),
    ).toEqual({ kind: "ignore" });
  });

  // (3) focused permission sheet delegates.
  it("focused permission sheet → delegate-permission", () => {
    expect(decideComposerKey(key({ permissionFocused: true }))).toEqual({
      kind: "delegate-permission",
    });
    // Permission focus outranks an open autocomplete.
    expect(
      decideComposerKey(key({ permissionFocused: true, autocompleteOpen: true, autocompleteItemCount: 2 })),
    ).toEqual({ kind: "delegate-permission" });
  });

  // (4) open autocomplete navigation/selection.
  it("autocomplete owns Up/Down/PageUp/PageDown", () => {
    const open = { autocompleteOpen: true, autocompleteItemCount: 4 };
    expect(decideComposerKey(key({ ...open, key: "ArrowDown" }))).toEqual({
      kind: "autocomplete-move",
      delta: 1,
    });
    expect(decideComposerKey(key({ ...open, key: "ArrowUp" }))).toEqual({
      kind: "autocomplete-move",
      delta: -1,
    });
    expect(decideComposerKey(key({ ...open, key: "PageDown" }))).toEqual({
      kind: "autocomplete-move",
      delta: AUTOCOMPLETE_PAGE_DELTA,
    });
    expect(decideComposerKey(key({ ...open, key: "PageUp" }))).toEqual({
      kind: "autocomplete-move",
      delta: -AUTOCOMPLETE_PAGE_DELTA,
    });
  });

  it("autocomplete Enter/Tab accepts — never submits", () => {
    const open = { autocompleteOpen: true, autocompleteItemCount: 3 };
    expect(decideComposerKey(key({ ...open, key: "Enter" }))).toEqual({
      kind: "autocomplete-accept",
    });
    expect(decideComposerKey(key({ ...open, key: "Tab" }))).toEqual({
      kind: "autocomplete-accept",
    });
  });

  it("autocomplete Enter with zero items closes instead of submitting", () => {
    expect(
      decideComposerKey(key({ autocompleteOpen: true, autocompleteItemCount: 0, key: "Enter" })),
    ).toEqual({ kind: "autocomplete-close" });
  });

  it("Esc with autocomplete open closes exactly that surface", () => {
    expect(decideComposerKey(key({ key: "Escape", autocompleteOpen: true }))).toEqual({
      kind: "autocomplete-close",
    });
    // Esc with nothing open stays native (never clears text / stops a turn).
    expect(decideComposerKey(key({ key: "Escape" }))).toEqual({ kind: "native" });
  });

  // KBD-04: Ctrl/Cmd+Enter leaves text untouched.
  it("Ctrl/Cmd+Enter → consume-modifier-enter (no chat submit)", () => {
    expect(decideComposerKey(key({ ctrlKey: true }))).toEqual({ kind: "consume-modifier-enter" });
    expect(decideComposerKey(key({ metaKey: true }))).toEqual({ kind: "consume-modifier-enter" });
  });

  it("otherwise native for unrelated keys", () => {
    expect(decideComposerKey(key({ key: "a" }))).toEqual({ kind: "native" });
    expect(decideComposerKey(key({ key: "Backspace" }))).toEqual({ kind: "native" });
  });

  it("isSubmittablePhase is exactly idle/completed/failed", () => {
    expect(isSubmittablePhase("idle")).toBe(true);
    expect(isSubmittablePhase("completed")).toBe(true);
    expect(isSubmittablePhase("failed")).toBe(true);
    expect(isSubmittablePhase("streaming")).toBe(false);
    expect(isSubmittablePhase("stopping")).toBe(false);
  });
});

describe("replaceSelection — pure range edit", () => {
  it("inserts over an empty caret (start === end)", () => {
    expect(replaceSelection("abc", 1, 1, "\n")).toEqual({
      text: "a\nbc",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("handles start/end 0 at both ends", () => {
    expect(replaceSelection("abc", 0, 0, "\n")).toEqual({
      text: "\nabc",
      selectionStart: 1,
      selectionEnd: 1,
    });
    expect(replaceSelection("abc", 3, 3, "\n")).toEqual({
      text: "abc\n",
      selectionStart: 4,
      selectionEnd: 4,
    });
  });

  it("replaces a real selection and collapses the caret after the insert", () => {
    expect(replaceSelection("hello world", 5, 11, "\n")).toEqual({
      text: "hello\n",
      selectionStart: 6,
      selectionEnd: 6,
    });
  });

  it("accepts reversed indexes (end before start)", () => {
    expect(replaceSelection("hello", 4, 1, "\n")).toEqual({
      text: "h\no",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("clamps out-of-range and non-finite indexes", () => {
    expect(replaceSelection("abc", -5, 99, "\n")).toEqual({
      text: "\n",
      selectionStart: 1,
      selectionEnd: 1,
    });
    expect(replaceSelection("abc", Number.NaN, Number.POSITIVE_INFINITY, "\n")).toEqual({
      text: "\nabc",
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("never normalizes untouched CRLF content", () => {
    const text = "a\r\nb";
    expect(replaceSelection(text, 1, 1, "\n")).toEqual({
      text: "a\n\r\nb",
      selectionStart: 2,
      selectionEnd: 2,
    });
    // A replacement in the middle preserves both CRLF bytes outside the range.
    expect(replaceSelection(text, 3, 3, "\n").text).toBe("a\r\n\nb");
  });

  it("treats emoji by JS string (UTF-16) offsets", () => {
    // "a😀b" — the emoji occupies offsets 1..3 (surrogate pair).
    const text = "a😀b";
    expect(text.length).toBe(4);
    // Inserting after the full pair must not split the surrogate.
    expect(replaceSelection(text, 3, 3, "\n")).toEqual({
      text: "a😀\nb",
      selectionStart: 4,
      selectionEnd: 4,
    });
    // Replacing the whole pair keeps the surrounding ASCII.
    expect(replaceSelection(text, 1, 3, "\n")).toEqual({
      text: "a\nb",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });
});
