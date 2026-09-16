# REVIEW-CHATV2-R1 — Independent reviewer report, cycle CHATV2 (0a3d3b7..b95c0cb)

VERDICT: CRITICAL

REVIEWER_MODEL: bao-opus (config handoff.reviewer.model=unic-smart)
EXECUTOR_MODEL: bao-sonnet (self-reported in TASK-CHATV2-017 Executor Report) — differs, isolation OK.

VERIFICATION_RERUN (fresh, this review):
- `npm run typecheck` → exit 0
- `npm run compile` → exit 0
- forbidden-token gate (localStorage/sessionStorage/"Voice input (coming soon)"/paper-plane) → PASS
- file-absence gate (V1Adapter/Composer/Header/Thread) → PASS
- `npm test` → 308 files passed | 2 skipped; 4624 tests passed | 5 skipped | 0 failed; exit 0

Executor evidence was honest (including the mid-task FAIL report). The suite is green —
but green tests do not cover the defect below, because every E2E case drives ONLY the V2
wire (`src/ui/__tests__/aiChatPanelV2E2e.test.ts` dispatches `text_delta`/`permission_requested`
exclusively, never the legacy twins the real host emits alongside them).

## Root cause of all P1 findings

The cutover stopped half-way: the host still emits the legacy frame family on the same
events that the V2 seam now covers (the code even documents this: "post ONE attachment
rejection on BOTH wires" — `src/ui/aiChatPanel.ts:6056-6070`), and the webview keeps BOTH
renderers live (`handleLegacyHostMessage` + the V2 controller/transcript). One logical
event therefore has two live render paths. The retained V1 bridge itself is a documented,
accepted limitation — the concrete duplicate-render/dead-surface consequences below are not.

## P1 findings (must fix before done)

### P1-1 — CRITICAL: every assistant message renders TWICE in production
- Host dual emission per streamed chunk: `src/ui/aiChatPanel.ts:2990-2991` (builtin onText),
  `3235-3236` (claude-code funnel), `3450-3451` (omp onDelta), `4233-4234` (raw ACP) — each
  posts legacy `{type:"delta"}` AND V2 `text_delta` (via `sessionNoteAssistant`, 4862-4874).
  Final text dual-posted too: legacy `assistant` at `3924` vs V2 `turn_finished` seal at 4922-4929.
- Webview renders both into the SAME visible container: legacy `appendDelta`/`appendAssistant`
  write into `#thread` (`webview/aiChatPanelMain.ts:518-566, 469-494`), which is appended to
  `shell.transcript` (`aiChatPanelMain.ts:213-227`); the V2 keyed transcript paints into the
  same `shell.transcript` and is ADDITIVE — it never removes `#thread`
  (`webview/aiChat/transcript.ts:499-542` only reconciles its own keyed nodes; `store.ts:568`
  materializes text_delta items).
- EMPIRICAL PROOF (jsdom, production `dist/aiChatPanel.js`, frames exactly as the host emits
  them): after `{type:"delta",text:MARKER}` + `{kind:"text_delta",text:MARKER}`, the marker
  appears **2 times** in `#UnicDB-root` textContent. Repro script kept at /tmp/r1-duperepro.mjs.
- Same dual family: thoughts render as legacy `step` lines AND V2 `reasoning_delta`
  (`3243-3244`, `3457-3458`); tool results as legacy card AND V2 timeline items;
  `attach_error` explicitly dual-posted (`6068-6069`).
- Fix (root cause, per PLAN §9 intent): one logical event must have ONE renderer. Either
  (a) stop posting the legacy streaming family (`delta`/`assistant`/`tool_result`/`attach_error`)
  at the named host sites now that V2 is authoritative, or (b) delete the corresponding cases
  from `handleLegacyHostMessage` in `aiChatPanelMain.ts` so the bridge only renders frames
  with no V2 counterpart. Add a bundle-level test that posts BOTH wires for one chunk and
  asserts the text appears exactly once.

### P1-2 — Model chip is dead at boot: host never sends the V2 `models` frame on ready
- Reducer: `webview/aiChat/store.ts:389` (`models: null`) — only the V2 `kind:"models"` frame
  populates it (`store.ts:698-701`). The host emits that frame ONLY as a `set_model` ack
  (`src/ui/aiChatPanel.ts:2578-2584`). On ready it posts only the LEGACY `models` frame
  (`2370`), which the webview no longer consumes (the V1 models handler was deleted in 017).
- Consequence: fresh session ⇒ blank model chip; opening the menu sees zero roles ⇒ degrades
  to `open_settings` (controller.ts:277-278, `engineModelMenus`; pinned as "empty ⇒ settings"
  in controllerSurfaces #12). PLAN §5 model-chip contract ("shows host display role/model;
  opens listbox") is unmet in production.
- Fix: in `handleReady` mirror the frame on the V2 seam next to 2370
  (`this.postV2({kind:"models", active: frame.active, roles: frame.roles})`), plus a host test
  asserting the ready fan-out includes it.

### P1-3 — One permission request renders TWO interactive surfaces; answering one wedges the other
- Host dual posts: `requestHostPermission` → legacy card `3655` + V2 `permission_requested`
  `3658`; raw ACP → `4371` + `4377`. Webview renders both: legacy card
  (`webview/aiChatPanelMain.ts:890-950`) AND the V2 anchored sheet
  (`webview/aiChat/controller.ts:389-405`, `permissions.ts:362+`). Empirically confirmed in
  the production bundle: both DOM surfaces appear for one requestId.
- Consequences:
  a) Answering via the LEGACY card leaves the V2 sheet open (nothing dispatches
     PERMISSION_RESPONDED), and an open sheet keeps `permissionRequest.isOpen()` true, which
     forces the keyboard ladder to delegate (`controller.ts:1175-1176`) — composer Enter/submit
     is blocked behind a phantom sheet until `turn_finished` clears it (`store.ts:674`).
  b) Answering via the V2 sheet leaves the legacy card clickable; a second click posts a legacy
     `permission_response`. Host-side is settle-once (`4389-4402`) so no double-apply, but this
     violates the webview's own contract comment (`aiChatPanelMain.ts:19`: "AT MOST ONE response
     per visible request").
  c) Raw-ACP optionIds pass through un-normalized (`4323-4330`) while the sheet only enables
     Allow for the literals "allow-once"/"allow-session" (`permissions.ts:98-99, 190-202, 489`).
     For ACP servers not using those literals the V2 sheet's "Allow once" renders DISABLED and
     the legacy card is the only allow surface. (omp HostMcp uses the hyphen literals —
     `src/ai/omp/hostMcp.ts:127-131` — so that flow works.)
- Fix: single permission surface. Suppress the legacy `permission_request` card in the bridge
  (V2 sheet is live), and normalize ACP option ids host-side in `postV2PermissionRequested`
  (reuse `isAllowKindOptionId`) so the sheet can always grant. Test: dual-wire request ⇒ one
  visible surface, exactly one response, composer keyboard not blocked after answering.

## Security gates (hard requirements) — PASS
- CSP unchanged and strict: `default-src 'none'`, `script-src ${cspSource}` (no remote, no
  unsafe-eval), `style-src ${cspSource} 'unsafe-inline'`, `img-src 'self' data:` (pre-existing
  attachment thumbnails) — `src/ui/aiChatPanel.ts:6218-6226`. No remote refs in
  `webview/aiChat/styles.css` (grep clean). localStorage/sessionStorage/IndexedDB: gate PASS
  (re-run) + V2E2e #9. Untrusted wire text: textContent everywhere; innerHTML only via the
  escape-first `renderMarkdown` pipeline (`aiChatPanelMain.ts:480,560`; `markdown.ts` DOM-only).
  Permission default-deny holds (timeout ⇒ deny, `4365-4367`; bypass is intent + host ack).
  No base64/raw binary in persistence/trace/export/DOM attributes (V1 base64 attach path
  deleted; transcript holds raw source in JS records, `transcript.ts:99-100`). Envelope
  hygiene solid: wrong sessionId/stale sequence rejected (`store.ts:469-471`), turn-scoped
  frames gated (`478-487`); dispose removes every listener/timer (`controller.ts:1324-1364`),
  remount pinned by V2E2e #10.

## Deleted-suite mapping audit (Bundle + CloneWebview)
Covered by remaining suites:
- Boot signal `ready_v2` exactly once, V1 ids absent, bundle tokens absent → V2E2e #1/#9.
- send/no-send/stop/keyboard → V2E2e #2-#4 + keyboard/controller suites.
- apiKey/base64 wire hygiene → V2E2e #8.
- XSS hostile tool name/detail (legacy card) → aiChatPanelWebview #3a/#3b; single-response
  invariant → #2a-#4c; de-stream regressions → #7/#7b.
- Markdown fence copy, clipboard rejection, message copy, scroll/jump → aiChatPanelWebviewTask002.
- history thought-drop, Esc resume, attach_error bubble, usage chip, mention_miss →
  Task002/Task005/aiChatPanelSessionStateWebview.
- Bypass toggle semantics → V2 permissions suites; engine fallback wording → V2 header/
  engineModelMenus suites; slash availability → slash/commands suites; resume flows → V2
  sessions suites.
ORPHANED (no live successor):
1. AG-001 bundle-level icon a11y sweep ("exactly one <svg> + hover tooltip + accessible name
   per icon-only button", pointer-events CSS guard) — deleted with aiChatPanelBundle.test.ts.
   V2 aria is pinned per-module only (e.g. `transcript.ts:119-132`). Worse,
   `src/ui/__tests__/aiChatPanelWebview.test.ts:637-673` keeps an EMPTY AG-001 describe husk
   with bare `;` statements and `COMPOSER_BUTTON_IDS` referencing deleted V1 ids
   (resumeBtn/clearBtn/regenerateBtn/stopBtn/attachBtn/sendBtn). Delete the husk or re-pin the
   sweep on V2 buttons.
2. Legacy `resume_list`/`resume_pick`/`resume_sessions`/`history` host paths
   (`src/ui/aiChatPanel.ts:5267, 5335`) are now unreachable (webview posts only V2 intents) —
   dead host code, harmless, but untracked in CODE_MAP.
3. DOM `innerText` export — no V2 mapping, documented and accepted in the TASK-017 report
   (transcript selectable/copyable; host `export_session` owns export). Accepted, note only.

## P2 (advisory)
1. Protocol-defined V2 frames with NO host emitter: `change_plan` (aiChatPanelMessages.ts:839),
   `error` (678), `usage` (860), `engine_state` (874), `grounding_state` (883), `mention_miss`
   (895). Consequently the V2 change-plan card (`controller.ts:289-317`) and V2 error card
   (`controller.ts:322-346`) are production-dead — those flows render via the legacy bridge
   (`appendChangePlan:404`, `appendError:496`, `applyUsage:755`, `applyEngineState:797`,
   `renderGroundingChips:1223`, `renderMentionMiss:1197`). Latent double-render trap the day
   someone adds the V2 emitters without removing the legacy posts; document ownership in
   CODE_MAP or add emitters + bridge suppression together.
2. Empty AG-001 describe husk — see Orphaned #1.
3. `webview/aiChatPanelMain.ts:1237-1239` — grounding strip uses `vscodeApi.postMessage(...)`
   directly instead of the null-safe `post()` helper used everywhere else.
4. `webview/aiChatPanelMain.ts:555-557` — accumulated stream stored in
   `bubble.dataset.UnicDBRawStream`, contradicting transcript.ts's "never into a DOM dataset"
   contract (text-only, not a security hole; retire with the bridge).
5. `applyEngineState` (`aiChatPanelMain.ts:800-806`) appends the lifecycle chip to
   `#UnicDB-root` now that `#engineBanner` is deleted — unstyled placement oddity.

## Visual/soak gate note
Per the caller's scope this ran as module/bundle-level evidence only (no real-webview
screenshots) and is an accepted limitation; not re-flagged. Note only that any future real
screenshot session will immediately surface P1-1 (duplicated messages).

## Bottom line for the orchestrator
Executor evidence and gates are honest and green; the defect class is exactly what a green
suite cannot see — the E2E drives only the V2 wire while production speaks both. Fix the three
P1s by finishing the single-renderer cutover seam, then re-run: full suite + a NEW bundle-level
dual-wire test (both frames for one chunk ⇒ text once; dual permission ⇒ one surface, one
response, composer not blocked; ready ⇒ V2 models frame ⇒ chip populated).

## Fix Round 1

EXECUTOR_MODEL: bao-sonnet. All three P1s + P2 items fixed in the main tree. RED was
demonstrated for every fix before it went GREEN (see per-item evidence below).

### P1-1 — duplicate rendering — FIXED (webview-side ownership gate, review option (b))
- `webview/aiChat/controller.ts`: new optional `onV2TurnGate` on `ChatControllerOptions`,
  fired SYNCHRONOUSLY inside `applyHostFrame` on `turn_started` (live=true) and
  `turn_finished` (live=false) — before any batched render.
- `webview/aiChatPanelMain.ts`: module latch `v2TurnOwnsStreaming`, set through the gate.
  While a V2 turn is live the legacy bridge now suppresses the `delta`, `assistant`, `step`,
  `thought`, `tool_result` and `permission_request` cases — the families the V2 seam owns.
  Families with NO live V2 counterpart (init, change_plan, error, done, engine_state, usage,
  grounding_state, mention_miss, resume_sessions, history, attach_error) keep rendering via
  the bridge, so legacy-only suites and out-of-turn host notices are unaffected.
- `src/ui/aiChatPanel.ts` (claude-code funnel onThought): added the missing
  `sessionNoteReasoning` mirror (omp + raw-ACP funnels already had it) so claude-code
  thoughts survive the gate in the V2 reasoning block.
- Verification of "no other family double-rendered the same way": attach_error is dual-posted
  by the host BUT its V2 store state (`attachNotices`) has NO live V2 renderer
  (store.ts:739 records; nothing in webview/aiChat consumes it) — so the legacy amber bubble
  stays mounted as its ONE visible surface (not suppressed). Tool labels paint twice inside V2
  (keyed transcript row + activity timeline row) by existing V2 design with ONE store entity —
  left as designed, pinned as the baseline in the dual-wire test.
- RED: new bundle test `#R1 dual-wire text` failed pre-fix (marker rendered 2x against
  production dist); GREEN post-fix (legacy twin adds 0). Same pattern for tools/permission.

### P1-2 — dead model chip at boot — FIXED (host emits V2 models on ready)
- `src/ui/aiChatPanel.ts` `handleReady`: the legacy `buildModelsFrame` post is now mirrored on
  the V2 seam (`{kind:"models", active, roles}`, no clientRequestId) before `init`/
  `capabilities`/`session_hydrated`. set_model ack unchanged.
- Host pin: NEW `src/ui/__tests__/aiChatPanelReadyV2Models.test.ts` — ready fan-out contains a
  V2 models frame with the same active/roles as the legacy frame, ack-free, before hydration.
- RED: with only `src/ui/aiChatPanel.ts` reverted (git stash), the pin FAILed; GREEN with fix.
- Commits: 18efae2 (P1-1), 4eb97de (P1-2), 57223e5 (P1-3).

### P1-3 — double permission surface / wedge / ACP Allow disabled — FIXED (single surface)
- Single surface: the P1-1 gate suppresses the legacy `permission_request` card while a V2
  turn is live — in production every permission arrives mid-turn, so the V2 anchored sheet is
  the ONE surface; the "answer one, wedge the other" wedge cannot occur (the legacy card never
  mounts; answering the sheet closes it and `turn_finished` seals the turn; composer Enter
  verified unblocked after settle in the bundle test).
- Raw-ACP optionIds: `normalizeV2PermissionOptionId` (host) maps ACP `kind` "allow_once"/
  "allow_always" onto the sheet's canonical `allow-once`/`allow-session` literals in
  `postV2PermissionRequested`; canonical/kindless ids stay verbatim (omp HostMcp convention).
  `PendingPermission.v2OptionIdMap` reverses the mapping in `handlePermissionResponse` so the
  ACP result carries the SERVER's original optionId. Legacy frame keeps raw ids; bypass and
  settle-once semantics unchanged.
- Host pins: `aiChatPanelAcp.test.ts` #7 (kind field normalizes + maps back, exactly one ACP
  result) and #8 (canonical ids verbatim). RED: both FAILed with only `src/ui/aiChatPanel.ts`
  reverted; GREEN with fix.
- Bundle pin: `#R1 dual-wire permission` — legacy card + V2 sheet dispatched together ⇒ zero
  `.UnicDB-chat-permission` cards, exactly one `[data-chat-permission-request]` sheet, Allow
  enabled, exactly one `permission_response` with the canonical optionId, and composer Enter
  posts `submit_turn` after settle. RED pre-fix (legacy card rendered alongside the sheet).

### P2 — done
1. Empty AG-001 describe husk (aiChatPanelWebview.test.ts): dead V1 `COMPOSER_BUTTON_IDS` +
   bare `;` statements removed; the valid #AG6 null-guard regression kept, describe re-titled.
2. AG-001 icon a11y sweep RESTORED against the V2 composer in aiChatPanelV2E2e.test.ts:
   #AG1 (exactly one inline aria-hidden svg), #AG2 (icon-only, no visible text), #AG3
   (title === aria-label, non-empty) over attachContextBtn/slashCommandBtn/primaryTurnBtn,
   #AG9 (pointer-events:none svg rules kept in webview/aiChat/styles.css).
3. NEW bundle-level dual-wire E2E coverage (the hole that hid all P1s): aiChatPanelV2E2e
   #R1 text / final / tools / attach_error / model chip / permission — production dist driven
   with BOTH frame families; each asserts the legacy twin adds ZERO extra render output and
   the surviving surface settles exactly once.
- Not done (advisory, unchanged): P2 advisory #1 (protocol-defined V2 frames with no host
  emitter), #3 (grounding strip raw postMessage), #4 (stream dataset attr), #5 (engine chip
  mount point). attach_error's store-only V2 renderer is now documented above as the one
  family whose V2 side is dead — flagged for a future lane, not silently dropped.

### Verification (fresh, this round)
- `npm run typecheck` → exit 0
- `npm run compile` → exit 0
- `npx vitest run src/ui/__tests__/aiChatPanelV2E2e.test.ts` → 20 passed | 0 failed
- `npx vitest run webview/aiChat` → 20 files, 393 passed | 0 failed
- `npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts` → 21 passed (husk removed,
  #AG6 kept)
- `npm test` → 309 files passed | 2 skipped; 4637 tests passed | 5 skipped | 0 failed;
  exit 0 (review baseline 4624 + 13 new tests: 10 bundle R1/AG + 3 host pins)
- forbidden-token gate (localStorage/sessionStorage/"Voice input (coming soon)"/paper-plane)
  → PASS
- No version bump, no package/publish/.vsix, no push. CSP untouched; no browser storage; no
  base64/binary in DOM/persistence/export.
