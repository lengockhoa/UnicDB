// webview/aiChat/mentions.ts — TASK-CHATV2-011
//
// The `@`-mention half of the shared autocomplete: WHERE a mention may open,
// HOW the search is debounced and correlated, and HOW an accepted row turns
// into a draft edit plus a structured chip.
//
// CONTRACT
// - `mentionEligibility(text, caret)` is the ONE rule for opening the popover.
//   A mention is eligible only when an unescaped `@` sits at a word boundary
//   (start of line, after whitespace, or after punctuation) and NOT inside
//   Markdown inline/fenced code. `user@example.com`, `\@literal` and `@`
//   inside a code span are all ineligible, so ordinary prose never hijacks the
//   composer. An EMPTY `@` is eligible — that is the grouped Files / Selection
//   / Database state.
// - Search is DEBOUNCED by 150ms; the spinner appears only after 200ms, so a
//   fast answer never flashes a loading state.
// - Every request carries `requestId` + `draftRevision` + the open generation.
//   A response is applied ONLY when all three still match the live open state;
//   `close()` bumps the generation, so Escape/removal makes every in-flight
//   answer inert — a late result can never reopen a closed popover.
// - Acceptance replaces ONLY the active token range (surrounding text and caret
//   are preserved verbatim by `replaceSelection`) and yields a structured
//   `ContextRef` for the chip strip. The visible token and the structured ref
//   are separate: the host receives ids/snapshots, the user sees text.
//
// Pure module: no DOM, no `vscode`, no transport, no clock read. Timers and ids
// are injected so debounce/spinner behavior is deterministic under test.

import type { ContextRef, ContextKindFilter } from "../../src/ui/aiChatContext";
import { replaceSelection, type TextRangeEdit } from "./keyboard";

/** Query debounce before a search intent is posted (PLAN §4). */
export const MENTION_DEBOUNCE_MS = 150;
/** Spinner delay: the loading state is only shown after this long (PLAN §4). */
export const MENTION_SPINNER_DELAY_MS = 200;
/** Empty-state copy — a non-selectable row. */
export const MENTION_EMPTY_MESSAGE = "No matching context";
/** Error-state copy — paired with a Retry row. */
export const MENTION_ERROR_MESSAGE = "Could not search context";
/** Retry affordance label. */
export const MENTION_RETRY_LABEL = "Retry";

/** Closed kind-group vocabulary for mention rows, in display order. */
export type MentionGroup = "files" | "selection" | "database";

/** Display order of the groups (spec: "groups Files/Selection/Database"). */
export const MENTION_GROUP_ORDER: readonly MentionGroup[] = Object.freeze([
  "files",
  "selection",
  "database",
]);

/** Group heading copy. */
export const MENTION_GROUP_LABELS: Readonly<Record<MentionGroup, string>> = Object.freeze({
  files: "Files",
  selection: "Selection",
  database: "Database",
});

/** The active `@` token under the caret. `start` points at the `@`. */
export interface MentionToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** Eligibility result for a caret position. */
export interface MentionEligibility {
  readonly eligible: boolean;
  readonly token: MentionToken | null;
}

const NOT_ELIGIBLE: MentionEligibility = Object.freeze({ eligible: false, token: null });

/** Characters that continue a mention query (path or `schema.name`). */
const TOKEN_CHAR = /[\w.\-/]/;

/** True when `line` has an odd number of backtick runs before the caret, i.e.
 * the caret sits inside an unterminated inline-code span. Mirrors `slash.ts`. */
function insideInlineCode(line: string, before: number): boolean {
  let runs = 0;
  let i = 0;
  while (i < before) {
    if (line[i] === "`") {
      while (i < before && line[i] === "`") i++;
      runs++;
      continue;
    }
    i++;
  }
  return runs % 2 === 1;
}

/** True when the caret's line sits inside an open ``` fence. */
function insideFence(text: string, lineIndex: number): boolean {
  const lines = text.split("\n");
  let open = false;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) open = !open;
  }
  return open;
}

/**
 * Decide whether a mention popover may open at `caret`.
 *
 * Excluded: an email-like `@` (a word character or another `@` directly
 * before), an escaped `\@`, and any `@` inside inline or fenced code.
 */
export function mentionEligibility(text: string, caret: number): MentionEligibility {
  const len = text.length;
  if (len === 0) return NOT_ELIGIBLE;
  const pos = Number.isFinite(caret) ? Math.min(Math.max(Math.trunc(caret), 0), len) : 0;
  if (pos <= 0) return NOT_ELIGIBLE;

  // Walk back over token characters to the `@` that would open the popover.
  let tokenStart = pos;
  while (tokenStart > 0 && TOKEN_CHAR.test(text[tokenStart - 1]!)) tokenStart--;
  if (tokenStart === 0 || text[tokenStart - 1] !== "@") return NOT_ELIGIBLE;
  const at = tokenStart - 1;

  // Escaped `\@` never opens.
  if (at > 0 && text[at - 1] === "\\") return NOT_ELIGIBLE;
  // Email-like (`user@host`) and doubled `@@` never open.
  if (at > 0 && /[\w@]/.test(text[at - 1]!)) return NOT_ELIGIBLE;

  const before = text.slice(0, at);
  const lineIndex = before.split("\n").length - 1;
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart, at);
  if (insideInlineCode(line, line.length)) return NOT_ELIGIBLE;
  if (insideFence(text, lineIndex)) return NOT_ELIGIBLE;

  return Object.freeze({
    eligible: true,
    token: Object.freeze({ start: at, end: pos, query: text.slice(at + 1, pos) }),
  });
}

// ===========================================================================
// Rows
// ===========================================================================

/** The semantic icon per ref kind — always a member of the icon allowlist. */
export function mentionIconForKind(kind: ContextRef["kind"]): string {
  return kind;
}

/** Which group a ref belongs to. */
export function mentionGroupForKind(kind: ContextRef["kind"]): MentionGroup {
  if (kind === "file") return "files";
  if (kind === "selection") return "selection";
  return "database";
}

/** One renderable mention row (plain data — painted with `textContent`). */
export interface MentionRow {
  readonly id: string;
  readonly refId: string;
  readonly group: MentionGroup;
  /** Group heading, present on the FIRST row of each group. */
  readonly groupLabel?: string;
  /** 16px semantic icon name. */
  readonly icon: string;
  /** 13px primary line — the display token. */
  readonly primary: string;
  /** 11px single-line secondary — the full distinguishing detail. */
  readonly secondary: string;
  readonly status: ContextRef["status"];
  /** True when the ref cannot be accepted as-is (changed/missing/forbidden). */
  readonly unavailable: boolean;
}

/**
 * Build rows in group order, with a heading on each group's first row.
 *
 * Duplicate labels stay apart because `secondary` always carries the FULL
 * distinguishing identity (`a/index.vue` vs `b/index.vue`,
 * `conn-1.public.users` vs `conn-2.public.users`) — a user never has to guess
 * which row they are accepting.
 */
export function buildMentionRows(items: readonly ContextRef[]): readonly MentionRow[] {
  const sorted = [...items].sort((a, b) => {
    const ga = MENTION_GROUP_ORDER.indexOf(mentionGroupForKind(a.kind));
    const gb = MENTION_GROUP_ORDER.indexOf(mentionGroupForKind(b.kind));
    return ga - gb;
  });
  const seenGroups = new Set<MentionGroup>();
  const rows: MentionRow[] = [];
  for (const ref of sorted) {
    const group = mentionGroupForKind(ref.kind);
    const first = !seenGroups.has(group);
    seenGroups.add(group);
    rows.push(
      Object.freeze({
        id: ref.id,
        refId: ref.id,
        group,
        ...(first ? { groupLabel: MENTION_GROUP_LABELS[group] } : {}),
        icon: mentionIconForKind(ref.kind),
        primary: ref.displayToken,
        secondary: ref.detail,
        status: ref.status,
        unavailable: ref.status !== "ready",
      }),
    );
  }
  return Object.freeze(rows);
}

/** The status of the list itself. */
export type MentionListState = "loading" | "ready" | "empty" | "error";

/** A non-selectable status row (empty / error). */
export interface MentionStatusRow {
  readonly id: string;
  readonly kind: "empty" | "error";
  readonly primary: string;
  /** Present on the error row only. */
  readonly retryLabel?: string;
  /** Always false — status rows can never be accepted. */
  readonly selectable: false;
}

/** Build the empty/error row for a list state. `null` for loading/ready, since
 * the spinner and data rows are handled by their own views. */
export function buildMentionStatusRow(state: MentionListState): MentionStatusRow | null {
  if (state === "empty") {
    return Object.freeze({
      id: "mention-empty",
      kind: "empty",
      primary: MENTION_EMPTY_MESSAGE,
      selectable: false,
    });
  }
  if (state === "error") {
    return Object.freeze({
      id: "mention-error",
      kind: "error",
      primary: MENTION_ERROR_MESSAGE,
      retryLabel: MENTION_RETRY_LABEL,
      selectable: false,
    });
  }
  return null;
}

// ===========================================================================
// Search scheduling (debounce + spinner delay + correlation)
// ===========================================================================

/** A search intent, ready for the transport to post as `search_context`. */
export interface MentionSearchIntent {
  readonly requestId: string;
  readonly draftRevision: number;
  readonly query: string;
  readonly kindFilter: ContextKindFilter;
}

/** Live open state the scheduler correlates against. `generation` is bumped on
 * every open and every close. */
export interface MentionOpen {
  readonly requestId: string;
  readonly draftRevision: number;
  readonly query: string;
  readonly kindFilter: ContextKindFilter;
  readonly token: MentionToken;
  readonly generation: number;
}

/** What `applyResult` needs from a host response. */
export interface MentionSearchResponse {
  readonly requestId: string;
  readonly draftRevision: number;
  readonly generation: number;
  readonly items: readonly ContextRef[];
}

export interface MentionSearchSchedulerOptions {
  /** Posts one intent (called only after the debounce elapses). */
  readonly send: (intent: MentionSearchIntent) => void;
  /** Returns the CURRENT draft revision at send time. */
  readonly draftRevision: () => number;
  /** Injectable id source (deterministic tests). */
  readonly nextId: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** Spinner visibility changes (true only after the spinner delay). */
  readonly onLoadingChange?: (loading: boolean) => void;
  readonly debounceMs?: number;
  readonly spinnerDelayMs?: number;
}

/** Handle returned by the injectable timer source. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** The scheduler handle the controller drives. */
export interface MentionSearchScheduler {
  /** Plan an open on `token`: debounce, then send. Re-planning resets timers. */
  schedule(token: MentionToken, kindFilter?: ContextKindFilter): void;
  /** Re-issue the CURRENT query with a NEW requestId (error-row Retry). */
  retry(): void;
  /** Close: bump the generation so every in-flight answer is inert. */
  close(): void;
  /** The live open state, or null when closed/never opened. */
  current(): MentionOpen | null;
  /** True while the debounce timer is pending. */
  isPending(): boolean;
  /** True while the spinner delay has elapsed and no answer arrived. */
  isLoading(): boolean;
  /** Apply a host response. Returns the items, or null when stale. */
  applyResult(response: MentionSearchResponse): readonly ContextRef[] | null;
  /** The active token, or null when closed. */
  activeToken(): MentionToken | null;
  /** Drop every timer/listener. Idempotent. */
  dispose(): void;
}

/**
 * Create the mention search scheduler.
 *
 * State machine: `schedule` opens a NEW generation and arms the debounce;
 * when the debounce fires the intent is posted and the spinner timer starts;
 * `applyResult` clears both and is accepted only on the exact triple;
 * `close` bumps the generation (inert in-flight answers) and clears timers.
 */
export function createMentionSearchScheduler(
  options: MentionSearchSchedulerOptions,
): MentionSearchScheduler {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const debounceMs = options.debounceMs ?? MENTION_DEBOUNCE_MS;
  const spinnerDelayMs = options.spinnerDelayMs ?? MENTION_SPINNER_DELAY_MS;

  let generation = 0;
  let open: MentionOpen | null = null;
  let debounceHandle: TimerHandle | null = null;
  let spinnerHandle: TimerHandle | null = null;
  let loading = false;
  let disposed = false;

  function clearTimers(): void {
    if (debounceHandle !== null) {
      clearTimer(debounceHandle);
      debounceHandle = null;
    }
    if (spinnerHandle !== null) {
      clearTimer(spinnerHandle);
      spinnerHandle = null;
    }
  }

  function setLoading(next: boolean): void {
    if (loading === next) return;
    loading = next;
    options.onLoadingChange?.(next);
  }

  /** Arm the debounce for the CURRENT `open` state. */
  function arm(token: MentionToken, kindFilter: ContextKindFilter): void {
    clearTimers();
    setLoading(false);
    const requestId = options.nextId();
    generation += 1;
    open = Object.freeze({
      requestId,
      draftRevision: open?.draftRevision ?? options.draftRevision(),
      query: token.query,
      kindFilter,
      token,
      generation,
    });
    const planned = open;
    debounceHandle = setTimer(() => {
      debounceHandle = null;
      if (disposed || open === null || open.generation !== planned.generation) return;
      // Revision is read at SEND time: the popover may have opened on an older
      // revision while the user kept typing.
      const live: MentionOpen = Object.freeze({
        ...planned,
        draftRevision: options.draftRevision(),
      });
      open = live;
      options.send(
        Object.freeze({
          requestId: live.requestId,
          draftRevision: live.draftRevision,
          query: live.query,
          kindFilter: live.kindFilter,
        }),
      );
      spinnerHandle = setTimer(() => {
        spinnerHandle = null;
        if (disposed || open === null || open.generation !== live.generation) return;
        setLoading(true);
      }, spinnerDelayMs);
    }, debounceMs);
  }

  return {
    schedule(token: MentionToken, kindFilter: ContextKindFilter = "all"): void {
      if (disposed) return;
      arm(token, kindFilter);
    },
    retry(): void {
      if (disposed) return;
      const live = open;
      if (live === null) return;
      // Retry reuses the CURRENT query with a NEW requestId.
      arm(live.token, live.kindFilter);
    },
    close(): void {
      clearTimers();
      setLoading(false);
      open = null;
      // A close is a new generation: a late response can never reopen it.
      generation += 1;
    },
    current(): MentionOpen | null {
      return open;
    },
    isPending(): boolean {
      return debounceHandle !== null;
    },
    isLoading(): boolean {
      return loading;
    },
    applyResult(response: MentionSearchResponse): readonly ContextRef[] | null {
      if (disposed) return null;
      const live = open;
      if (live === null) return null;
      if (
        live.requestId !== response.requestId ||
        live.draftRevision !== response.draftRevision ||
        live.generation !== response.generation
      ) {
        return null;
      }
      clearTimers();
      setLoading(false);
      return response.items;
    },
    activeToken(): MentionToken | null {
      return open?.token ?? null;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      setLoading(false);
      open = null;
    },
  };
}

// ===========================================================================
// Acceptance
// ===========================================================================

/**
 * The draft edit accepting `ref` performs: replace ONLY the active token range
 * with the ref's display token plus a trailing space. Text before and after the
 * token is preserved byte-for-byte and the caret lands after the insert
 * (`replaceSelection` owns both guarantees).
 *
 * Returns null when the token is malformed, so acceptance can never edit an
 * arbitrary range the popover would not have opened on.
 */
export function mentionAcceptEdit(
  text: string,
  token: MentionToken,
  ref: ContextRef,
): TextRangeEdit | null {
  if (!Number.isFinite(token.start) || !Number.isFinite(token.end)) return null;
  const from = Math.max(Math.trunc(token.start), 0);
  const to = Math.max(Math.trunc(token.end), from);
  if (from >= to || from >= text.length) return null;
  if (text[from] !== "@") return null;
  return replaceSelection(text, from, to, `${ref.displayToken} `);
}

/**
 * The ref accepted from a row, carrying its chip identity. The visible token
 * and the structured ref are deliberately separate values: the host gets the
 * id + snapshot, the composer gets the display token.
 */
export interface MentionAcceptance {
  readonly ref: ContextRef;
  readonly edit: TextRangeEdit;
}

/** Convenience wrapper returning both halves of an acceptance. */
export function acceptMention(
  text: string,
  token: MentionToken,
  ref: ContextRef,
): MentionAcceptance | null {
  const edit = mentionAcceptEdit(text, token, ref);
  if (edit === null) return null;
  return Object.freeze({ ref, edit });
}
