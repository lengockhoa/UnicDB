// webview/aiChat/__tests__/mentions.test.ts — TASK-CHATV2-011
//
// Covers the pure `@`-mention contract: eligibility boundaries (line start,
// prose, email, escaped, inline/fenced code), the 150ms debounce + 200ms
// spinner delay, request/revision/generation correlation (a late answer can
// never reopen a closed popover), grouped non-selectable rows, and acceptance
// that replaces only the token range.
//
// No DOM, no real timers: every timer is injected, so the debounce and spinner
// fires on command and the test is a plain function of its arguments.
import { describe, expect, it, vi } from "vitest";

import {
  acceptMention,
  buildMentionRows,
  buildMentionStatusRow,
  createMentionSearchScheduler,
  mentionAcceptEdit,
  mentionEligibility,
  mentionGroupForKind,
  MENTION_DEBOUNCE_MS,
  MENTION_EMPTY_MESSAGE,
  MENTION_ERROR_MESSAGE,
  MENTION_RETRY_LABEL,
  MENTION_SPINNER_DELAY_MS,
  type TimerHandle,
} from "../mentions";
import { buildContextRefs } from "../../../src/ui/aiChatContext";

function ref(
  overrides: Parameters<typeof buildContextRefs>[0][number],
): ReturnType<typeof buildContextRefs>[number] {
  return buildContextRefs([overrides])[0]!;
}

const FILE_REF = ref({
  kind: "file",
  label: "index.vue",
  detail: "a/index.vue",
  source: { type: "uri", uri: "file:///ws/a/index.vue" },
  revision: "rev-a",
});

// ---- #1 parser: eligible / excluded contexts -------------------------------

describe("mentionEligibility — boundaries (task case 1)", () => {
  it("is eligible at the start of a line and mid-prose after a space", () => {
    expect(mentionEligibility("@", 1).eligible).toBe(true);
    expect(mentionEligibility("@ind", 4)).toMatchObject({ eligible: true });
    expect(mentionEligibility("look at @index", 14).eligible).toBe(true);
  });

  it("carries the exact token range and query", () => {
    const text = "look at @src/ui";
    const result = mentionEligibility(text, text.length);
    expect(result.token).toEqual({ start: 8, end: 15, query: "src/ui" });
  });

  it("groups an empty @ (eligible, empty query)", () => {
    const result = mentionEligibility("hi @", 4);
    expect(result.eligible).toBe(true);
    expect(result.token).toEqual({ start: 3, end: 4, query: "" });
  });

  it("excludes an email-like word", () => {
    const text = "mail user@example.com";
    expect(mentionEligibility(text, text.length).eligible).toBe(false);
  });

  it("excludes an escaped \\@", () => {
    const text = "literal \\@notmention";
    expect(mentionEligibility(text, text.length).eligible).toBe(false);
  });

  it("excludes @@ doubled at-signs", () => {
    const text = "ping @@here";
    expect(mentionEligibility(text, text.length).eligible).toBe(false);
  });

  it("excludes inline code", () => {
    // Caret sits between the `@`-token and the closing backtick, so the token
    // IS found — only the inline-code rule can reject it.
    const text = "`@inde`";
    expect(mentionEligibility(text, 6).eligible).toBe(false);
    // The same token OUTSIDE code is eligible.
    expect(mentionEligibility("use @inde here", 9).eligible).toBe(true);
  });

  it("excludes an open fenced code block", () => {
    const text = "```\n@index";
    expect(mentionEligibility(text, text.length).eligible).toBe(false);
  });

  it("is eligible again once the fence closes", () => {
    const text = "```\ncode\n```\n@ind";
    expect(mentionEligibility(text, text.length).eligible).toBe(true);
  });

  it("rejects an out-of-range or empty caret", () => {
    expect(mentionEligibility("", 0).eligible).toBe(false);
    expect(mentionEligibility("@a", 0).eligible).toBe(false);
  });
});

// ---- grouped rows -----------------------------------------------------------

describe("buildMentionRows — grouped, disambiguated rows", () => {
  it("orders groups Files → Selection → Database with one heading each", () => {
    const refs = buildContextRefs([
      { kind: "table", label: "users", detail: "conn-1.public.users", source: { type: "object", connectionId: "conn-1", schema: "public", name: "users", objectKind: "table" }, revision: "s1" },
      { kind: "file", label: "index.vue", detail: "a/index.vue", source: { type: "uri", uri: "file:///ws/a/index.vue" }, revision: "r1" },
      { kind: "selection", label: "composer.ts", detail: "webview/aiChat/composer.ts", source: { type: "uri", uri: "file:///ws/webview/aiChat/composer.ts" }, revision: "r2", lineRange: { start: 1, end: 2 } },
    ]);
    const rows = buildMentionRows(refs);
    expect(rows.map((r) => r.group)).toEqual(["files", "selection", "database"]);
    expect(rows[0]!.groupLabel).toBe("Files");
    expect(rows[1]!.groupLabel).toBe("Selection");
    expect(rows[2]!.groupLabel).toBe("Database");
    expect(rows.every((r) => r.icon.length > 0)).toBe(true);
  });

  it("keeps duplicate labels apart via the full detail on the secondary line", () => {
    const refs = buildContextRefs([
      { kind: "file", label: "index.vue", detail: "a/index.vue", source: { type: "uri", uri: "file:///ws/a/index.vue" }, revision: "r1" },
      { kind: "file", label: "index.vue", detail: "b/index.vue", source: { type: "uri", uri: "file:///ws/b/index.vue" }, revision: "r2" },
    ]);
    const rows = buildMentionRows(refs);
    expect(rows[0]!.secondary).toBe("a/index.vue");
    expect(rows[1]!.secondary).toBe("b/index.vue");
    expect(rows[0]!.primary).toBe("@a/index.vue");
  });

  it("marks a non-ready ref unavailable", () => {
    const rows = buildMentionRows([ref({ kind: "file", label: "x.ts", detail: "x.ts", source: { type: "uri", uri: "file:///ws/x.ts" }, status: "missing" })]);
    expect(rows[0]!.unavailable).toBe(true);
    expect(rows[0]!.status).toBe("missing");
  });

  it("maps kinds to the right group", () => {
    expect(mentionGroupForKind("file")).toBe("files");
    expect(mentionGroupForKind("selection")).toBe("selection");
    expect(mentionGroupForKind("table")).toBe("database");
    expect(mentionGroupForKind("routine")).toBe("database");
    expect(mentionGroupForKind("schema")).toBe("database");
  });
});

// ---- #5 empty / error rows --------------------------------------------------

describe("buildMentionStatusRow — non-selectable states (task case 5)", () => {
  it("renders the exact empty copy, non-selectable", () => {
    const row = buildMentionStatusRow("empty")!;
    expect(row.primary).toBe(MENTION_EMPTY_MESSAGE);
    expect(row.primary).toBe("No matching context");
    expect(row.selectable).toBe(false);
  });

  it("renders the exact error copy plus Retry, non-selectable", () => {
    const row = buildMentionStatusRow("error")!;
    expect(row.primary).toBe(MENTION_ERROR_MESSAGE);
    expect(row.primary).toBe("Could not search context");
    expect(row.retryLabel).toBe(MENTION_RETRY_LABEL);
    expect(row.selectable).toBe(false);
  });

  it("has no status row while loading or ready (spinner/data own those)", () => {
    expect(buildMentionStatusRow("loading")).toBeNull();
    expect(buildMentionStatusRow("ready")).toBeNull();
  });
});

// ---- #2 race: debounce, spinner, generation --------------------------------

/** A deterministic manual timer source. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer(fn: () => void, ms: number): TimerHandle {
      const handle = next++;
      pending.set(handle, { fn, ms });
      return handle as unknown as TimerHandle;
    },
    clearTimer(handle: TimerHandle): void {
      pending.delete(handle as unknown as number);
    },
    /** Fire every timer armed with exactly `ms`. */
    fire(ms: number): void {
      for (const [handle, entry] of [...pending.entries()]) {
        if (entry.ms !== ms) continue;
        pending.delete(handle);
        entry.fn();
      }
    },
    count(): number {
      return pending.size;
    },
  };
}

function schedulerHarness() {
  const timers = manualTimers();
  let id = 0;
  const send = vi.fn();
  const loading = vi.fn();
  let revision = 3;
  const scheduler = createMentionSearchScheduler({
    send,
    draftRevision: () => revision,
    nextId: () => `req-${++id}`,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onLoadingChange: loading,
  });
  return {
    scheduler,
    timers,
    send,
    loading,
    setRevision: (n: number) => {
      revision = n;
    },
  };
}

describe("createMentionSearchScheduler — debounce + correlation (task case 2)", () => {
  it("does not send before the 150ms debounce, then sends once", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 3, end: 4, query: "" });
    expect(h.send).not.toHaveBeenCalled();
    expect(MENTION_DEBOUNCE_MS).toBe(150);
    h.timers.fire(MENTION_DEBOUNCE_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0]).toMatchObject({ query: "", kindFilter: "all", draftRevision: 3 });
  });

  it("re-scheduling restarts the debounce and supersedes the old request", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.scheduler.schedule({ start: 0, end: 3, query: "in" });
    h.timers.fire(MENTION_DEBOUNCE_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0]).toMatchObject({ query: "in" });
  });

  it("shows the spinner only after 200ms with no answer", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.timers.fire(MENTION_DEBOUNCE_MS);
    expect(h.scheduler.isLoading()).toBe(false);
    expect(MENTION_SPINNER_DELAY_MS).toBe(200);
    h.timers.fire(MENTION_SPINNER_DELAY_MS);
    expect(h.scheduler.isLoading()).toBe(true);
    expect(h.loading).toHaveBeenLastCalledWith(true);
  });

  it("a fast answer never flashes the spinner", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.timers.fire(MENTION_DEBOUNCE_MS);
    const open = h.scheduler.current()!;
    const items = h.scheduler.applyResult({
      requestId: open.requestId,
      draftRevision: open.draftRevision,
      generation: open.generation,
      items: [FILE_REF],
    });
    expect(items).toHaveLength(1);
    expect(h.scheduler.isLoading()).toBe(false);
    expect(h.loading).not.toHaveBeenCalledWith(true);
  });

  it("ignores a response whose requestId, revision or generation is stale", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.timers.fire(MENTION_DEBOUNCE_MS);
    const open = h.scheduler.current()!;
    expect(h.scheduler.applyResult({ ...open, requestId: "old", items: [FILE_REF] })).toBeNull();
    expect(h.scheduler.applyResult({ ...open, draftRevision: 1, items: [FILE_REF] })).toBeNull();
    expect(h.scheduler.applyResult({ ...open, generation: 0, items: [FILE_REF] })).toBeNull();
  });

  it("Escape/close bumps the generation so a late result cannot reopen", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.timers.fire(MENTION_DEBOUNCE_MS);
    const open = h.scheduler.current()!;
    h.scheduler.close();
    expect(h.scheduler.current()).toBeNull();
    expect(
      h.scheduler.applyResult({
        requestId: open.requestId,
        draftRevision: open.draftRevision,
        generation: open.generation,
        items: [FILE_REF],
      }),
    ).toBeNull();
  });

  it("cancels a pending debounce on close", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.scheduler.close();
    h.timers.fire(MENTION_DEBOUNCE_MS);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("Retry reuses the current query with a NEW requestId", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 3, query: "in" });
    h.timers.fire(MENTION_DEBOUNCE_MS);
    const first = h.scheduler.current()!.requestId;
    h.scheduler.retry();
    h.timers.fire(MENTION_DEBOUNCE_MS);
    expect(h.send).toHaveBeenCalledTimes(2);
    const second = h.send.mock.calls[1]![0];
    expect(second.query).toBe("in");
    expect(second.requestId).not.toBe(first);
  });

  it("sends the LIVE draft revision, not the revision at schedule time", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.setRevision(9);
    h.timers.fire(MENTION_DEBOUNCE_MS);
    expect(h.send.mock.calls[0]![0]).toMatchObject({ draftRevision: 9 });
  });

  it("dispose is idempotent and drops every timer", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 0, end: 1, query: "" });
    h.scheduler.dispose();
    h.scheduler.dispose();
    expect(h.timers.count()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("exposes the active token while open and null once closed", () => {
    const h = schedulerHarness();
    h.scheduler.schedule({ start: 1, end: 5, query: "indx" });
    expect(h.scheduler.activeToken()).toEqual({ start: 1, end: 5, query: "indx" });
    h.scheduler.close();
    expect(h.scheduler.activeToken()).toBeNull();
  });
});

// ---- #3 acceptance: only the token range changes ---------------------------

describe("mentionAcceptEdit — replaces only the token range (task case 3)", () => {
  it("preserves the surrounding text and caret", () => {
    const text = "before @ind after";
    const token = { start: 7, end: 11, query: "ind" };
    const edit = mentionAcceptEdit(text, token, FILE_REF)!;
    expect(edit.text).toBe("before @index.vue  after");
    expect(edit.selectionStart).toBe(7 + "@index.vue ".length);
    expect(edit.selectionEnd).toBe(edit.selectionStart);
  });

  it("accepts an empty @ token in the middle of a line", () => {
    const text = "a @ b";
    const edit = mentionAcceptEdit(text, { start: 2, end: 3, query: "" }, FILE_REF)!;
    expect(edit.text).toBe("a @index.vue  b");
  });

  it("returns null when the range does not start at @ (never an arbitrary edit)", () => {
    expect(mentionAcceptEdit("hello", { start: 1, end: 3, query: "" }, FILE_REF)).toBeNull();
    expect(mentionAcceptEdit("hello", { start: 2, end: 2, query: "" }, FILE_REF)).toBeNull();
  });

  it("returns null for a non-finite range", () => {
    expect(mentionAcceptEdit("@a", { start: Number.NaN, end: 2, query: "a" }, FILE_REF)).toBeNull();
  });

  it("pairs the edit with the structured ref", () => {
    const acceptance = acceptMention("x @in", { start: 2, end: 5, query: "in" }, FILE_REF)!;
    expect(acceptance.ref.id).toBe(FILE_REF.id);
    expect(acceptance.edit.text).toBe("x @index.vue ");
  });
});
