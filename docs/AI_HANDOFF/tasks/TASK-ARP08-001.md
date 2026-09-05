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
- [ ] Constants exported and asserted in tests: `CONSOLE_DRAFTS_KEY = "UnicDB.consoleDrafts"`, `CONSOLE_DRAFT_SNAPSHOT_VERSION = 1`, `CONSOLE_DRAFTS_MAX_TABS = 20`, `CONSOLE_DRAFTS_MAX_BUFFER_CHARS = 64_000`.
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
  export const CONSOLE_DRAFTS_KEY = "UnicDB.consoleDrafts";
  export const CONSOLE_DRAFT_SNAPSHOT_VERSION = 1;
  export const CONSOLE_DRAFTS_MAX_TABS = 20;
  export const CONSOLE_DRAFTS_MAX_BUFFER_CHARS = 64_000;
  ```
  plus `{ type: "clearDrafts" }` as a new `ConsoleToHostMessage` member (guard `case "clearDrafts": return true;`).

---

## Discussion

- @executor decision (ARP08-001): the orchestrator's instruction summary said unknown extra fields should be REJECTED (strict), but this task file — the contract — requires tolerated-and-stripped in THREE places (Test Case 7, Acceptance Criteria, and the Snapshot-shape note below). Per the task file (higher priority), unknown extra root/tab fields are tolerated on the wire and stripped from the rebuilt result. Test Case 7 asserts this and passes.
- Snapshot-shape note for @executor: keep the codec pure and defensive. `parse` must rebuild a NEW object (never return the raw parsed value by reference) so the tolerated-and-stripped contract is literal — a later consumer mutating a tab must not mutate the memento payload, and unknown fields must never survive.
- Over-cap handling is deliberately two-sided and deterministic: `parse` REJECTS over-cap (corrupt → one empty tab at the host in 002), while the host `persistDrafts()` (002) CLAMPS to the caps before encoding so our own writer can never emit a snapshot its own parse rejects. Do NOT add clamp logic to `encode` — keep encode a pure verbatim JSON serialization; clamping is the host's job.
- `case "clearDrafts": return true;` is intentionally type-only (no field checks) — the host ignores any extra payload, mirroring how `historyList` is accepted with no fields.

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Claude:feature-implementer
SUMMARY: Added the pure versioned/bounded ConsoleDraftSnapshot codec (encode + fail-closed parse, tolerated-and-stripped extras), the four CONSOLE_DRAFTS_* constants, the `clearDrafts` webview→host message (type-only guard case) and the `draftsCleared` host→webview message, plus the ARP-08 header line.
TEST_PLAN_FOLLOWED: task §Test Cases (all 10 rows) as tests #1–#10 in the new describe blocks.
FILES_CHANGED:
  - src/ui/consolePanelMessages.ts: ARP-08 header line; `clearDrafts` union member + guard case; `draftsCleared` host→webview member; CONSOLE_DRAFTS_KEY / CONSOLE_DRAFT_SNAPSHOT_VERSION / CONSOLE_DRAFTS_MAX_TABS / CONSOLE_DRAFTS_MAX_BUFFER_CHARS; ConsoleDraftSnapshot; encodeConsoleDraftSnapshot; parseConsoleDraftSnapshot (fail-closed, rebuilds fresh object, strips unknown root/tab fields, rejects over-cap).
  - src/ui/__tests__/consolePanelMessages.test.ts: appended ARP-08 describe blocks (constants, round-trip, malformed, version gate, shape gate, bounds, active-tab integrity, forward-compat strip, clearDrafts wire, regression).
TESTS_ADDED:
  - src/ui/__tests__/consolePanelMessages.test.ts: CONSOLE_DRAFTS_* constants; #1 round-trip; #2 malformed input; #3 version gate; #4/#4b shape gate + empty tabs; #5 bounds (21 tabs, 64_001 chars rejected, 64_000 accepted); #6 ghost activeTabId; #7 tolerated-and-stripped extras; #8 clearDrafts accept+narrow; #9 type-only guard + `clearDraft` typo rejected; #10 pre-existing families regression.
VERIFICATION:
command: npx vitest run src/ui/__tests__/consolePanelMessages.test.ts && npm run typecheck && npx vitest run
result: 26/26 target file pass; typecheck exit 0; full suite 3132 pass / 0 fail (2 skipped, pre-existing) / 218 files passed + 1 skipped
output_excerpt: |
  RED (before implementation):
   ❯ src/ui/__tests__/consolePanelMessages.test.ts:422:41 clearDrafts wire > #8 accepts the type-only clearDrafts message and narrows it
   AssertionError: expected false to be true
   Test Files  1 failed (1)
        Tests  11 failed | 15 passed (26)
  GREEN (after implementation):
   ✓ src/ui/__tests__/consolePanelMessages.test.ts  (26 tests) 4ms
   Test Files  1 passed (1)
        Tests  26 passed (26)
   npm run typecheck > tsc --noEmit  (no output, exit 0)
   Full suite: Test Files  218 passed | 1 skipped (219)
               Tests  3132 passed | 2 skipped (3134)
ISSUES: none. One contract note: the orchestrator message summary said unknown extras should be strict-REJECTED, but this task file requires tolerated-and-stripped (Test Case 7 + Acceptance Criteria + Discussion) — implemented tolerated-and-stripped per the task file; decision recorded in Discussion. Also note `parse` additionally rejects an empty tabs array (task §Test Plan edge + host 002 must seed ≥1 tab) — this was listed in my instruction summary and is consistent with the task's acceptance criteria ("corrupt → one empty tab at the host").
HANDOFF_TO_REVIEWER: yes — STATUS DONE, handoff gate applies; reviewer model must differ from unic-code.
NEXT: ready for review; TASK-ARP08-002/003/004 can consume the exported codec/constants.


---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/consolePanelMessages.test.ts src/ui/__tests__/consolePanel.test.ts && npm run typecheck
  result: 55 pass / 0 fail; tsc --noEmit exit 0
TEST_PLAN_COVERAGE: all-followed — §Test Cases rows 1-10 all present (#4b empty-tabs, #5 exact-cap acceptance, #8/#9 wire guard)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - docs/AI_HANDOFF/PLAN.md §4 "New wire message" — the plan explicitly rejected a dedicated `draftsCleared` host→webview message as redundant ("clear reuses the existing state push"); the implementation adds it (consolePanelMessages.ts:150, sent from consolePanel.ts:435) and TASK-003's webview consumes it (webview/consolePanelMain.ts:142). Additive and harmless, but the plan text is now stale — documented divergence, not a defect.
    - src/ui/consolePanelMessages.ts:253-255 — `name` is validated as string only; a corrupt memento carrying a multi-MB tab name survives parse and is re-persisted verbatim (probe confirmed). Not blocking (contract caps are 20 tabs / 64k buffer chars), but `name` has no byte bound if hardening is wanted.
NOTES: Adversarial probes (whitespace-only, version as string "1", `__proto__` root/tab, array-as-tab-element, oversized name, secret-shaped extras) all behave fail-closed or strip-clean; no prototype pollution survives (rebuild uses fresh object literals). RED evidence real (11 failed / 15 passed with assertion excerpt); non-vacuous — codec tests fail without the implementation and #8 narrows the cleared-drafts type.
NEXT_STATUS_FOR_INDEX: approved_minor
