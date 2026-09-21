# SPEC — CHATUX: Claude Code–first UX redesign of the AIChat V2 webview

<!--
Written by the planner at handoff-create (Step 2, before PLAN.md tasks).
Rule: executor implement không cần đoán — exact paths, signatures, frozen
strings, thresholds, test expectations. Open questions chốt trong §14.
Source: advisor spec (user-provided) mapped to verified code anchors.
-->

## 1. Problem and context

The user wants the UnicDB AI chat panel (V2 surface) redesigned to a Claude
Code–first UX. Advisor spec §19 defines five waves; this cycle implements
W1–W4 (P0 core) and queues W5. Verified current state (scout + planner):

- **Layout (W1):** root grid `styles.css:54` already uses
  `grid-template-rows: 40px auto minmax(0,1fr) auto auto 20px` and the
  transcript is the sole scroll region (`-main` 229-235 flex column
  `min-height:0`; `-transcript` 239-248 `overflow-y:auto`). Remaining gaps:
  message blocks carry fixed width (`-item-text` `width: 880px` at 579),
  tool rows use `position: relative` + absolute `::before` connector
  (650-672), and Markdown spacing is ad-hoc.
- **Scroll (W2):** `scroll.ts` `createScrollController` is wired correctly
  (controller.ts:295 `beginFrame`, 313-333 notify diff) but has three
  defects: (a) `isInputFocused()` early-return (180-184) suppresses ALL
  follow while the composer textarea holds focus — i.e. the entire streaming
  turn after Enter; (b) a single 48px threshold with no hysteresis — the
  follow state flaps at the boundary; (c) no rAF coalescing and no
  ResizeObserver — rapid deltas and panel resizes are handled per-paint.
- **Message visuals (W3):** user bubble is a wide 78% card (563-572);
  assistant text is unboxed already (575-582); tool rows exist with a
  collapse toggle (transcript.ts:337-363) but default expanded and taller
  than 32px; code blocks (`markdown.ts` `createCodeBlock` 155-169) emit a
  bare `<pre>` — no header, no language label, no copy button; action rows
  exist (transcript.ts:262-302) but CSS `opacity: 0` (styles.css:847) hides
  them until hover — the user reports "no copy button".
- **Composer (W4):** `COMPOSER_AUTO_GROW_MIN_PX=64`/`MAX_PX=160`
  (composer.ts:64-65); CSS top region `min-height:64px; max-height:160px;
  padding:14px 16px 10px` (298-304); input `max-height:147px` (310, 941-943);
  bottom lane `min-height:48px; padding:7px 10px` (329-337); send/primary
  `40x40` (347-364, 1118-1134). Keyboard contract already correct:
  `keyboard.ts` `decideComposerKey` — IME composition → `ignore` (89-91),
  Shift+Enter → `insert-newline` (119), plain Enter → `submit` (155). Draft
  lives in reducer state (`state.draft.text`, composer.ts:423) — survives
  re-renders; no cross-reload persistence (not required — §14 Q5).

## 2. Goals

- W1: stable shell grid, single transcript scroll owner, normal document
  flow for message blocks, normalized Markdown spacing.
- W2: explicit scroll state machine — `following-tail` vs `reading-history`
  — with 72/96px hysteresis, rAF-coalesced scroll writes, ResizeObserver
  re-pin, Jump-to-latest pill, preserved anchors on prepend/expand.
- W3: compact user prompt card, unboxed assistant body, collapsed
  tool/thinking disclosure rows (28–32px), code-block header with language +
  Copy, always-visible message action rows, quiet loading states.
- W4: composer collapsed ≤104px total, 1-line auto-grow textarea, compact
  footer controls, Enter send / Shift+Enter newline / IME-safe (already
  correct — locked by tests), in-session draft persistence (already correct).

## 3. Non-goals (advisor spec §20 anti-requirements)

- KHÔNG đụng engine/protocol/permission code (`store.ts` event kinds,
  `controller.ts` transport, permission sheet).
- KHÔNG blind rewrite — surgical edits to the existing V2 modules only.
- KHÔNG hard-coded colors — VS Code theme tokens / existing CSS vars only.
- KHÔNG unconditional auto-scroll — follow only in `following-tail` state.
- KHÔNG fixed heights on Markdown content blocks.
- KHÔNG fake buttons — no queue/continue/undo controls the backend lacks.
- KHÔNG đụng V1 appenders (`aiChatPanelMain.ts`, `markdownSafe.ts`,
  `webview/styles.css`); V2 is the live surface.
- KHÔNG thêm dependency, KHÔNG bump version / publish.
- W5 (a11y/perf audit: focus rings, aria, reduced-motion, ≤30fps stream
  batching, memoized completed blocks) — queued to a follow-up cycle.

## 4. User journeys

- **Streaming follow:** user sends → textarea keeps focus → deltas stream →
  transcript follows continuously (the isInputFocused suppression is gone);
  pill never appears while pinned.
- **Reading history:** user scrolls up >96px → state `reading-history` →
  position preserved, pill counts new responses; scroll back within 72px →
  `following-tail` resumes follow.
- **Panel resize:** webview resized while pinned → ResizeObserver re-pins to
  bottom; while reading → anchor preserved.
- **Code block:** ```sql fence → header "sql" + Copy → click → clipboard
  gets raw code, label flips to `Copied` 1500ms.
- **Copy answer:** action row visible at rest under every message → Copy →
  clipboard + `Copied` toast (existing announce).
- **Composer:** resting footprint ≤104px; Enter sends, Shift+Enter newlines,
  IME composition never sends; draft survives re-renders.

## 5. Functional requirements

- **FR-001 (W1 layout):** `styles.css` — keep the root grid rows
  (`40px auto minmax(0,1fr) auto auto 20px`); confirm `-main` is the only
  `minmax(0,1fr)` track and `-transcript` the only `overflow-y:auto` region
  (CSS-scan test). Remove the fixed `width: 880px` on `-item-text`/
  `-item-reasoning` (keep `max-width: 92%`); tool row keeps
  `position: relative` only for the connector — no other absolute/fixed
  positioning on message blocks; normalize Markdown spacing:
  `-md-paragraph` `margin: 0 0 8px` (keep), `-md-heading` `margin: 12px 0
  6px` (keep), code block margin handled by FR-005 wrapper.
- **FR-002 (W2 state machine):** `scroll.ts` — replace the boolean
  `lastNear`/`preFrameDistance` model with an explicit state:
  `type ScrollFollowState = "following-tail" | "reading-history"`.
  Frozen thresholds: `SCROLL_FOLLOW_ENTER_PX = 72` (re-enter follow),
  `SCROLL_FOLLOW_EXIT_PX = 96` (leave follow). Hysteresis: distance ≤72 →
  following; ≥96 → reading; between → keep current state.
  `SCROLL_BOTTOM_THRESHOLD_PX = 48` is REMOVED (superseded — update all
  importers/tests).
- **FR-003 (W2 coalescing + observers):** scroll writes go through a
  `requestAnimationFrame` coalescer (jsdom fallback: `setTimeout(0)` when
  `requestAnimationFrame` is undefined); a `ResizeObserver` on the viewport
  re-pins when `following-tail` (guard `typeof ResizeObserver !==
  "undefined"` — jsdom lacks it). `notifyNewResponse` drops the
  `isInputFocused` check entirely (delete the helper — dead code).
- **FR-004 (W2 pill):** pill label becomes `unreadPillLabel(count)` →
  `count === 1 ? "↓ Jump to latest — 1 new" : "↓ Jump to latest — N new"`;
  click → `scrollToBottom()` + state `following-tail` + unread reset.
  `notifyPrependedHistory` anchor-preservation logic unchanged.
- **FR-005 (W3 code block):** `markdown.ts` `createCodeBlock` emits:

  ```
  <div class="UnicDB-ai-chat-v2-codeblock" data-lang="<lang|absent>">
    <div class="UnicDB-ai-chat-v2-codeblock-header">
      <span class="UnicDB-ai-chat-v2-codeblock-lang"><lang|"text"></span>
      <button type="button" class="UnicDB-ai-chat-v2-codeblock-copy"
              aria-label="Copy code">Copy</button>
    </div>
    <pre class="UnicDB-ai-chat-v2-code"><code class="…-<lang|plain>">…</code></pre>
  </div>
  ```

  Copy: `navigator.clipboard.writeText(block.code)` → label `Copied` for
  1500ms → restore `Copy`; on reject/missing API → `Failed` for 1500ms.
  Frozen labels: `Copy`/`Copied`/`Failed`. createElement/textContent only.
  CSS: `-codeblock` (margin `8px 0`, border + `radius-sm`, background
  `-input`, `overflow:hidden`); `-header` (flex, space-between, `padding:
  4px 8px 4px 12px`, `border-bottom: 1px solid -border`, `font-size: 11px`,
  muted); `-copy` (`font-size: 11px`, `padding: 2px 8px`, hover `-surface`);
  inner `-code` override `margin:0; border:0; border-radius:0; padding:
  10px 12px; line-height:1.5` (keep overflow-x/white-space/font).
- **FR-006 (W3 message system):** `styles.css` — user card compact:
  `-item-user` `max-width: 78%` → `max-width: 70%`, `padding: 6px 10px`;
  assistant stays unboxed; `-item-tool` collapsed by default
  (`data-collapsed="1"` set at creation in transcript.ts:355-358 — invert
  initial `aria-expanded` to `"false"`), row min-height 28–32px
  (`-tool-head` `min-height: 28px`); reasoning items render as a collapsed
  disclosure row: wrap `-reasoning-body` in a `<details>`-style toggle —
  reuse the tool-toggle pattern: button `-reasoning-toggle` +
  `data-collapsed` on the item root, default collapsed.
  `-action` loses `opacity: 0` + the hover/focus reveal rule (851-855) —
  always visible, muted at rest. Loading states stay quiet (existing
  `-loading` 11px muted — no change needed beyond keeping it).
- **FR-007 (W4 composer):** `composer.ts` —
  `COMPOSER_AUTO_GROW_MIN_PX = 36`, `COMPOSER_AUTO_GROW_MAX_PX = 88`
  (comment at :63 updated). `styles.css` — `-composer-top`
  `min-height:36px; max-height:88px; padding:6px 10px 4px`; `-input` +
  `-input-v2` `max-height:76px`; `-composer-bottom` `min-height:36px;
  padding:4px 8px`; `-send` + `-primary` `32x32` (width/height/min-*).
  Total collapsed ≈ 36+36+hint ≈ ≤104px. Keyboard contract unchanged —
  `decideComposerKey` already returns `ignore` for IME/`keyCode 229`,
  `insert-newline` for Shift+Enter, `submit` for plain Enter; add a
  regression test pinning the IME row. Draft persistence: reducer-owned
  (`state.draft.text`) — pin with a test that re-render keeps the draft.

## 6. Fullstack scope

### Backend
N/A — webview-only; no extension-host code.

### Database / schema / migrations
N/A.

### API contract
Module-level — §8. No message-protocol changes.

### Frontend UI and state
V2 surface only: `webview/aiChat/{shell,controller,scroll,transcript,
markdown,composer,keyboard}.ts` + `styles.css`; mounted by
`webview/aiChatPanelMain.ts` (root `#UnicDB-root.UnicDB-chat
.UnicDB-ai-chat-v2`; bundle `dist/aiChatPanel.js` + `dist/aiChatPanel.css`
via `src/ui/aiChatPanel.ts` `buildHtml` ~6331-6366).

### Integration
`renderState()` (controller.ts:291+) stays the single coalesced paint pass
and the only scroll-driver site (autoScroll.test.ts #5 invariant).

### Security and permissions
Clipboard writes are click-gesture only; no innerHTML; no new message types.

### Performance
rAF coalescing caps scroll writes at one/frame; ResizeObserver replaces
per-paint resize drift. No new timers except the 1500ms copy-label restore.

### Observability / logging
Existing toast/live-region announce paths unchanged.

### Deployment and rollback
Pure webview bundle change; rollback = revert commit.

## 7. Scroll state machine (frozen)

```
states: following-tail | reading-history

distance() ≤ 72  → following-tail   (enter)
distance() ≥ 96  → reading-history  (exit)
72 < d < 96      → keep current state (hysteresis band)

notifyNewResponse():
  following-tail  → scrollToBottom() (rAF-coalesced) — NO focus check
  reading-history → unread++, pill visible

ResizeObserver(viewport): following-tail → re-pin; reading → no-op
notifyPrependedHistory(cb): measure → prepend → re-offset scrollTop (unchanged)
pill click → scrollToBottom() + following-tail + unread=0
```

## 8. API contract (module-level, frozen)

### 8.1 `webview/aiChat/scroll.ts`

```ts
export type ScrollFollowState = "following-tail" | "reading-history";
export const SCROLL_FOLLOW_ENTER_PX = 72;
export const SCROLL_FOLLOW_EXIT_PX = 96;
// REMOVED: SCROLL_BOTTOM_THRESHOLD_PX, isInputFocused
export function unreadPillLabel(count: number): string;
//   1 → "↓ Jump to latest — 1 new" ; n → "↓ Jump to latest — n new"
export interface ScrollController {
  distance(): number;
  followState(): ScrollFollowState;          // replaces nearBottom()
  unreadCount(): number;
  beginFrame(): number;
  notifyNewResponse(): void;
  notifyReasoningActivity(): void;
  notifyPrependedHistory(prepend: () => void): void;
  scrollToBottom(): void;
  sync(): void;
  destroy(): void;                            // also disconnects ResizeObserver
}
```

`controller.ts` changes: `scroll.nearBottom()` → `scroll.followState()` if
referenced; `SCROLL_BOTTOM_THRESHOLD_PX` import → new constants in the
pinned-growth branch (329: `preDistance <= SCROLL_FOLLOW_EXIT_PX` — the
pre-frame "was pinned" check uses the EXIT edge so a pinned reader inside
the band still follows).

Export fates: `bottomDistance`, `scrollBehavior`, `prefersReducedMotion`,
`mountScrollPill`, `SCROLL_PILL_MIN_PX`, `SCROLL_PILL_MARKER`,
`ScrollMetrics`, `ScrollControllerOptions` — unchanged; the
`onProximityChange` option stays, now fired on `followState()` transitions
(`near` = `following-tail`). `isNearBottom` is REMOVED (superseded by
`followState()` — migrate its test in errorsScrollA11y.test.ts:372-375).

### 8.2 `webview/aiChat/markdown.ts`

```ts
export function createCodeBlock(block: { readonly lang: string; readonly code: string }): HTMLElement;
// Returns the -codeblock wrapper div (was: the pre). Classes per FR-005.
```

### 8.3 `webview/aiChat/composer.ts`

```ts
export const COMPOSER_AUTO_GROW_MIN_PX = 36;   // was 64
export const COMPOSER_AUTO_GROW_MAX_PX = 88;   // was 160
```

### 8.4 `webview/aiChat/transcript.ts`

- Tool items: `data-collapsed="1"` + `aria-expanded="false"` at creation
  (default collapsed).
- Reasoning items: new `-reasoning-toggle` button + `data-collapsed`
  default `"1"`; body hidden while collapsed.
- No signature changes — `createTranscriptRenderer(refs, callbacks)` same.

### 8.5 CSS selectors (all under `.UnicDB-ai-chat-v2`)

New: `-codeblock`, `-codeblock-header`, `-codeblock-lang`, `-codeblock-copy`,
`-reasoning-toggle`. Modified: `-code` (nested override), `-action` (no
opacity gate), `-item-user`, `-item-text`/`-item-reasoning` (drop 880px),
`-tool-head` (min-height 28px), `-composer-top`, `-input`, `-input-v2`,
`-composer-bottom`, `-send`, `-primary`.

## 9. UI behavior

- Transcript follows streaming only in `following-tail`; hysteresis kills
  boundary flapping; pill reads "↓ Jump to latest — N new".
- Code blocks: header strip (lang left, Copy right), roomier padding,
  horizontal scroll for long lines.
- Action icons visible at rest (muted), darken on hover.
- Tool/thinking rows collapsed to a 28–32px disclosure row by default.
- Composer rests ≤104px total; textarea grows 36→88px then scrolls.

## 10. Edge cases

- Distance in the 72–96px band → state unchanged (no flap).
- `reading-history` + focused textarea + delta → no scroll, pill counts.
- jsdom without `requestAnimationFrame`/`ResizeObserver` → setTimeout(0)
  fallback / observer skipped — tests must not crash.
- Fence without language → header "text", code class `-plain`.
- Clipboard missing/denied on code copy → `Failed` label, no throw.
- Rapid copy clicks → label timer resets.
- Empty draft → textarea 36px; >88px content → `input-scroll` overflow.
- `<320px` narrow → two-row composer grid intact.
- IME composition Enter → `ignore` decision, never submits.

## 11. Test matrix

| Area | Cases | Test file |
|------|-------|-----------|
| Scroll machine | focused+pinned delta → follows (regression for today's bug); band 72–96 keeps state; scrolled-up+focused → pill counts; ResizeObserver re-pin (mocked); pill label new copy | `webview/aiChat/__tests__/autoScroll.test.ts` (modify) |
| Layout | CSS scan: single `minmax(0,1fr)` track; transcript sole `overflow-y:auto`; `-item-text`/`-item-reasoning` rule has no `width:`/`max-inline-size` (`-error-card`/`-change-plan` 880px caps stay); no `position:fixed` in file | `webview/aiChat/__tests__/shellGrid.test.ts` (extend) |
| Code block | wrapper+header+lang+Copy DOM; empty lang → "text"; copy → writeText(raw)+"Copied"; reject → "Failed"; no innerHTML source scan | `webview/aiChat/__tests__/codeBlock.test.ts` (NEW) |
| Message visuals | tool row starts `data-collapsed="1"`/`aria-expanded="false"`; reasoning disclosure collapsed; `-action` has no `opacity:0` (CSS scan); copy click → writeText | `webview/aiChat/__tests__/messageActions.test.ts` + `transcript.test.ts` (extend) |
| Composer | clamp 36/88; CSS scan pins 36/88/76/36/32 metrics; IME Enter → no submit; draft survives re-render | `webview/aiChat/__tests__/composer.test.ts` (extend) |

## 12. Acceptance criteria

- [ ] `npx vitest run webview/aiChat/__tests__/autoScroll.test.ts` — PASS.
- [ ] `npx vitest run webview/aiChat/__tests__/codeBlock.test.ts` — PASS (new).
- [ ] `npx vitest run webview/aiChat/__tests__/shellGrid.test.ts
      webview/aiChat/__tests__/messageActions.test.ts
      webview/aiChat/__tests__/transcript.test.ts
      webview/aiChat/__tests__/composer.test.ts` — PASS.
- [ ] `npm run typecheck` — 0 errors; `npm run compile` — bundle OK.
- [ ] `npm test` — full suite PASS at each wave boundary.
- [ ] No `isInputFocused`/`SCROLL_BOTTOM_THRESHOLD_PX` left in scroll.ts.
- [ ] No `opacity: 0` on `-action`; no `width:`/`max-inline-size` in the
      `-item-text`/`-item-reasoning` rule (`-error-card`/`-change-plan` keep
      their 880px caps); no hard-coded colors
      (only `var(--vscode-*)` / existing `--UnicDB-ai-chat-v2-*` tokens).

## 13. Migration / upgrade steps

N/A — no persisted state. Intentional behavior changes: follow is
position-state-driven (focus no longer suppresses), tool/reasoning rows
default collapsed, action rows always visible, composer smaller.

## 14. Open questions and chosen defaults

| Question | Chosen default | Rationale |
|----------|----------------|-----------|
| Q1: Focus suppression for follow? | Removed entirely. | It suppresses follow for the whole streaming turn (textarea keeps focus after Enter) — the reported bug. Viewport scroll never moves the caret. |
| Q2: Hysteresis edges? | Enter ≤72px, exit ≥96px (spec range 72–96). | Band kills flapping; exit edge doubles as the pre-frame "was pinned" check. |
| Q3: Code-block copy feedback? | Button label `Copied`/`Failed` 1500ms. | Matches V1 quiet-button pattern; avoids toast spam. |
| Q4: Composer target? | 36–88px clamp, 32px send, 36px bottom lane → ≤104px collapsed. | Advisor spec's ≤104px cap; standard chat proportions. |
| Q5: Draft persistence scope? | In-session reducer state only (already implemented) — pin with a test. | Spec asks "draft persistence"; cross-reload persistence would need host state plumbing — out of scope, recorded here. |
| Q6: W5 in this cycle? | Queued (INDEX `queued` row). | W1–W4 already span 4 tasks/3 waves on shared styles.css; W5 is audit-class work better reviewed alone. |
| Q7: Task split given styles.css shared? | T1∥T2 (disjoint files) → T3 → T4. | Same-file rule; merging unrelated fixes blurs review. |

## 15. Review checklist

- [x] Every FR testable (§11 maps each FR to file + concrete expectations).
- [x] All layers covered or N/A'd (no backend/DB/protocol work).
- [x] Thresholds frozen: 72/96 hysteresis, 36/88 clamp, 76px input cap,
      32px send, 28–32px disclosure rows, 1500ms label restore, ≤104px
      composer, frozen labels Copy/Copied/Failed + pill copy.
- [x] Dependencies: T1 ∥ T2 disjoint; T3 after T1; T4 after T3 —
      styles.css serialized.
- [x] Phase 0 sweep: INDEX empty (SQLHANG archived); 18 stale AIX task
      files (12 pending + 6 ready) recorded as queued leftovers, not
      folded; `git status` shows only RUN.md modified (runner-owned).
- [x] Anti-requirements §20 honored: no protocol/engine changes, no
      hard-coded colors, no unconditional scroll, no fixed Markdown
      heights, no fake buttons.
