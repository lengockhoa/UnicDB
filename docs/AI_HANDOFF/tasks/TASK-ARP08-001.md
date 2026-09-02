# TASK-ARP08-001 — Persisted draft model: snapshot codec + clearDrafts wire (pure)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §3, §4, §5, §7

## Goal

Add the pure, versioned, bounded draft codec to `src/ui/consolePanelMessages.ts`: `ConsoleDraftSnapshot` + `encodeConsoleDraftSnapshot` / `parseConsoleDraftSnapshot` (fail-closed), the four draft constants, and the new webview→host `clearDrafts` message + guard case. Everything downstream (host restore, webview flush, extension wiring) imports this codec and this message type.

## Target Files

- `src/ui/consolePanelMessages.ts` — add the `ConsoleDraftSnapshot` interface + `encodeConsoleDraftSnapshot` / `parseConsoleDraftSnapshot` functions + constants `CONSOLE_DRAFTS_KEY`, `CONSOLE_DRAFT_SNAPSHOT_VERSION`, `CONSOLE_DRAFTS_MAX_TABS`, `CONSOLE_DRAFTS_MAX_BUFFER_CHARS`; add `{ type: "clearDrafts" }` to the `ConsoleToHostMessage` union and a `case "clearDrafts": return true;` to `isConsoleToHostMessage`. Module stays pure (no vscode imports) so the webview bundle can share it.
- `src/ui/__tests__/consolePanelMessages.test.ts` (existing file) — add the draft-codec + `clearDrafts` describe blocks. No other file is modified.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 1 | happy | encode→parse round-trip of a valid 2-tab snapshot (`{version:1, tabs:[{id,name,buffer}×2], activeTabId}`) | `parse(encode(s))` deep-equals `s`; `version === 1`; `Object.keys(parsed)` sorted equals `["activeTabId","tabs","version"]` |
| 2 | edge (malformed) | `parse("not-json")`, `parse("42")`, `parse(undefined as unknown as string)`, `parse(null as unknown as string)` | `null` each (no throw) |
| 3 | edge (version) | `parse(JSON.stringify({version:2, tabs:[...], activeTabId}))` and a snapshot with no `version` | `null` each |
| 4 | edge (shape) | `tabs` not an array; a tab with non-string `id`/`name`/`buffer` (e.g. `buffer: 7`, `id: null`); `activeTabId` not a string | `null` each |
| 5 | edge (boundary over-cap) | 21 tabs (cap+1); one tab with a `64_001`-char buffer; one tab with exactly `64_000` chars | first two `null`; the exact-cap one parses; the exported constants are asserted `CONSOLE_DRAFTS_MAX_TABS === 20` and `CONSOLE_DRAFTS_MAX_BUFFER_CHARS === 64_000` |
| 6 | edge (active-tab integrity) | valid tabs but `activeTabId: "ghost"` matching no tab | `null` |
| 7 | edge (forward-compat) | valid snapshot with an extra unknown top-level field (`{...snapshot, extra: {x:1}}`) | parses to a clean object WITHOUT `extra`; `encode(parsed)` omits it (tolerated-and-stripped) |
| 8 | happy (wire) | `isConsoleToHostMessage({ type: "clearDrafts" })` | `true`, and TypeScript narrows it (assert `raw.type === "clearDrafts"`) |
| 9 | edge (wire) | `{ type: "clearDrafts", junk: 42 }`; `{ type: "clearDraft" }`; `{ type: "clearDrafts", tabId: "x" }` | `true` for the first (type-only message), `false` for the unknown type; the tabId-carrying variant still `true` (guard only checks the discriminant) |
| 10 | edge (regression) | every pre-existing message family still validates (e.g. `runConsole`, `updateBuffer`, `requestAutocomplete`) | `true` — the added `clearDrafts` case must not disturb existing guards |

## Test Files

- `src/ui/__tests__/consolePanelMessages.test.ts` — new describe blocks `parseConsoleDraftSnapshot` / `encodeConsoleDraftSnapshot` / `CONSOLE_DRAFTS_*` / `clearDrafts wire`, following the file's existing pure-unit style (no DOM, no vscode mock). Note the tests-map for `consolePanelMessages.ts` also lists `consolePanel.test.ts` — that file is owned by TASK-ARP08-002 and must NOT be touched here.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/consolePanelMessages.test.ts
npm run typecheck
```

(No `npm run compile` needed — this task adds no bundle-touching change; the bundle gate is TASK-ARP08-003's.)

## Acceptance Criteria

- [ ] `parseConsoleDraftSnapshot` is fail-closed: returns `null` (never throws) on malformed JSON, wrong/missing version, non-string id/name/buffer, non-array `tabs`, unknown `activeTabId`, over-cap tabs (>20), over-cap buffer (>64k).
- [ ] `encodeConsoleDraftSnapshot` / `parseConsoleDraftSnapshot` round-trip losslessly for valid snapshots; unknown extra fields are stripped (tolerated-and-stripped) and re-encoding omits them.
- [ ] `isConsoleToHostMessage` accepts `{ type: "clearDrafts" }` and still rejects unknown types; no existing guard case regressed.
- [ ] Constants exported and asserted in tests: `CONSOLE_DRAFTS_KEY = "vsdb.consoleDrafts"`, `CONSOLE_DRAFT_SNAPSHOT_VERSION = 1`, `CONSOLE_DRAFTS_MAX_TABS = 20`, `CONSOLE_DRAFTS_MAX_BUFFER_CHARS = 64_000`.
- [ ] Module remains pure (no vscode/DOM import) so the webview bundle can import the codec — verified by typecheck + the existing pure-module invariant.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — wave 1.

## Interfaces

- Consumes: (none).
- Produces (imported by TASK-ARP08-002/003/004):
  ```ts
  export interface ConsoleDraftSnapshot { version: 1; tabs: Array<{ id: string; name: string; buffer: string }>; activeTabId: string; }
  export function encodeConsoleDraftSnapshot(snapshot: ConsoleDraftSnapshot): string;
  export function parseConsoleDraftSnapshot(raw: string): ConsoleDraftSnapshot | null;
  export const CONSOLE_DRAFTS_KEY = "vsdb.consoleDrafts";
  export const CONSOLE_DRAFT_SNAPSHOT_VERSION = 1;
  export const CONSOLE_DRAFTS_MAX_TABS = 20;
  export const CONSOLE_DRAFTS_MAX_BUFFER_CHARS = 64_000;
  ```
  plus `{ type: "clearDrafts" }` as a new `ConsoleToHostMessage` member (guard `case "clearDrafts": return true;`).

---

## Discussion

- Snapshot-shape note for @executor: keep the codec pure and defensive. `parse` must rebuild a NEW object (never return the raw parsed value by reference) so the tolerated-and-stripped contract is literal — a later consumer mutating a tab must not mutate the memento payload, and unknown fields must never survive.
- Over-cap handling is deliberately two-sided and deterministic: `parse` REJECTS over-cap (corrupt → one empty tab at the host in 002), while the host `persistDrafts()` (002) CLAMPS to the caps before encoding so our own writer can never emit a snapshot its own parse rejects. Do NOT add clamp logic to `encode` — keep encode a pure verbatim JSON serialization; clamping is the host's job.
- `case "clearDrafts": return true;` is intentionally type-only (no field checks) — the host ignores any extra payload, mirroring how `historyList` is accepted with no fields.

---

## Executor Report

<!-- Phase 3 executor appends below. -->

---

## Reviewer Verdict

<!-- Phase 4 reviewer appends below the Executor Report. -->
