# TASK-001 (cycle AB) — Host message contract + buildMessages image-parts path

Wave: 1 (parallel with TASK-003 styles + TASK-005 pure helpers).
Owner files: `src/ui/aiChatPanelMessages.ts` + `src/ui/aiChatPanel.ts` + new test file.
Constraint: no same-wave file overlap (T-003 owns `webview/styles.css`; T-005 owns a new test only).

## §Spec

### Wire contract extensions (additive — backward compatible)

1. `AiChatPanelInit` (host → webview) gains `visionCapable: boolean`:
   - True iff the active AI role's `models.<role>.vision === true` at panel-ready time.
   - Source: `AiConfigStore.loadSettings()` → `settings.models[activeRole].vision`.
   - The webview reads this to (a) enable/disable the attach button and (b) accept/reject paste-image.

2. `AiChatPanelWebviewMessage["send"]` gains `attachments?: ImageAttachment[]`:
   - `ImageAttachment { id: string; mime: string; base64: string; bytes: number; }`
   - When present and length > 0, the host forwards them as `ChatContentPart[]` (image_url parts with `dataUrl`) attached to the user message constructed in `handleSend`.
   - When absent OR empty array, legacy text-only path runs (cycle AA baseline).

3. New host → webview message kind `AiChatPanelAttachError`:
   - `{ type: "attach_error"; id: string; reason: "oversize"|"count_cap"|"unsupported_type"|"mime_mismatch"|"vision_unsupported"; message: string }`
   - Fires per-attachment rejection so the webview can name the offending file in its warning bubble.

### Host validation (in `handleSend`)

Before invoking `runAgent`:
- Count: `attachments.length > MAX_ATTACHMENTS_PER_TURN` (4) → emit one `attach_error` per overflowing item with `reason:"count_cap"`, drop them, proceed with the kept prefix. If ALL drop → return early (no runAgent call).
- Per-item bytes: `attachment.bytes > MAX_ATTACH_BYTES` (5 * 1024 * 1024) → emit `attach_error` with `reason:"oversize"`, drop.
- Per-item MIME: not in `{image/png, image/jpeg, image/webp, image/gif}` → emit `attach_error` with `reason:"unsupported_type"`, drop.
- Per-item MIME sniff (magic bytes): decode the first 12 bytes of base64 and compare against expected magic.
  - PNG: `89 50 4E 47 0D 0A 1A 0A` → image/png
  - JPEG: `FF D8 FF` → image/jpeg
  - GIF: `47 49 46 38` (37|39) → image/gif
  - WEBP: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` → image/webp
  - Mismatch (e.g. `25 50 44 46` = `%PDF`) → emit `attach_error` with `reason:"mime_mismatch"`, drop.
- Vision gating: if `currentRole.vision === false` AND `attachments.length > 0` after the above passes → emit ONE `attach_error` with `reason:"vision_unsupported"` PER attachment, drop ALL attachments, proceed with text-only turn. (User can still send the text prompt; image bytes are explicitly rejected, not silently dropped.)

### buildMessages image-parts path (the privacy-critical bit)

No new parameter needed — `buildMessages(factory, history, userMsg, …)` already accepts a `userMsg: ChatMessage` whose `content` field is typed `string | ChatContentPart[]` (`src/ai/provider.ts:24`). The handler constructs the user message directly:
```ts
const textPart: ChatContentPart = { type: "text", text };
const imageParts: ChatContentPart[] = validAttachments.map((a) => ({
  type: "image_url",
  imageUrl: `data:${a.mime};base64,${a.base64}`,
}));
const userMsg: ChatMessage = {
  role: "user",
  content: [textPart, ...imageParts],
};
```
Then call `buildMessages(factory, history, userMsg)`. The legacy string-content path stays byte-identical (no code change to `buildMessages` itself).

**Mention × attachment interaction:** when an `@-mention` block already adds a "Referenced context" section, it appends to the text part (so the text part becomes "user prompt + referenced-context block"). Image parts stay as siblings — never replaced.

### CSP posture (BLOCKING — required for thumbnails)

`buildHtml` (`src/ui/aiChatPanel.ts:2091-2095`) currently sets:
```
"default-src 'none'", "style-src ${webview.cspSource} 'unsafe-inline'", "script-src ${webview.cspSource}"
```
No `img-src` directive → falls back to `default-src 'none'` → every `<img src="data:image/png;base64,…">` thumbnail is BLOCKED. The attachments strip renders empty images.

**Fix:** add `img-src 'self' data:` to the CSP array. Test pins the exact CSP string so a future regression re-tightening cannot strip it silently.

### omp / ACP engine gate

`handleSend` ACP branch (`src/ui/aiChatPanel.ts:1039-1043`) currently coerces `userMsg.content` to a string prompt. If the user attaches images in omp mode, this would silently drop the image parts — violating §1's "never silently drops the image".

**Fix:** when `this.engine === "omp"`, run the SAME vision_unsupported gate as a non-vision model: emit ONE `attach_error` per attachment, drop ALL images, proceed with text-only turn. The user sees the same amber warning. ACP's `streamComplete` is not called with image parts.

The work role (default `agent.ts:204 — "work"`) is the assumed vision lane; `agent.ts:216-218` already throws if the role lacks vision capability — that's the final belt.

### Logging hygiene

`console.log` / `console.warn` MUST NEVER receive base64 bytes. A `summarizeAttachmentsForLog(attachments)` helper returns `{count, totalBytes, mimes:[…]}` — this is the only log shape allowed. Pure helper lives in `src/ui/aiChatAttachments.ts` (new file, task-005 actually owns the helper file; task-001 imports it).

## §Interfaces (downstream contract)

```ts
// src/ui/aiChatPanelMessages.ts — additive extensions
export interface ImageAttachment {
  id: string;
  mime: string;
  base64: string;
  bytes: number;
}
export interface AiChatPanelInit {
  type: "init";
  hasHistory: boolean;
  visionCapable: boolean; // NEW — task-001
}
export interface AiChatPanelAttachError {
  type: "attach_error";
  id: string;
  reason: "oversize" | "count_cap" | "unsupported_type" | "mime_mismatch" | "vision_unsupported";
  message: string;
}
// union AiChatPanelHostMessage gains AiChatPanelAttachError

// WebviewMessage.send extension (additive):
export interface AiChatPanelWebviewSend {
  type: "send";
  text: string;
  attachments?: ImageAttachment[]; // NEW — task-001
}
```

```ts
// caps (export for tests + webview mirror)
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_ATTACHMENTS_PER_TURN = 4;
export const ATTACH_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
```

## §Verification Commands

```bash
cd .worktrees/task-001
npx vitest run src/ui/__tests__/aiChatPanelAttachments.test.ts
npx vitest run src/ui/__tests__/aiChatPanelPrivacy.test.ts
npm run typecheck
```

## §Acceptance Criteria (revised round 2)

0. **CSP img-src**: `buildHtml` output's `<meta http-equiv="Content-Security-Policy">` contains `img-src 'self' data:`. Source-text test against `src/ui/aiChatPanel.ts`.

0a. **omp/ACP gate**: when `this.engine === "omp"` AND `attachments.length > 0` after per-item validation → emit `attach_error { reason: "vision_unsupported" }` per attachment, drop ALL images, proceed with text-only turn (NOT a silent drop). BuildMessages never receives image parts in omp mode.

0b. **Mention × attachment**: when user sends `@schema.table` + 2 valid images → user message has 1 text part (containing prompt + referenced-context block) + 2 image_url parts. The text part is augmented, the image parts are siblings.

1. `handleSend({text, attachments:[…valid]})` constructs a user message with text + image_url parts and forwards to `runAgent` (RED first against current code that has no `attachments` field, GREEN after).
2. `handleReady()` reads `loadSettings()` and posts `{type:"init", hasHistory, visionCapable}` matching the active role's vision flag.
3. `AiChatPanelAttachError` posted per rejected attachment with the named `reason` (oversize / count_cap / unsupported_type / mime_mismatch / vision_unsupported).
4. `handleSend` produces a user message carrying text + image_url parts; system message still DDL-only.
5. Text-only path (attachments absent or empty) is byte-identical to cycle AA baseline.
6. Privacy sentinel test (cycle-AA `aiChatPanelPrivacy.test.ts`) extended: seed sentinel + 2 valid attachments → sentinel absent from system AND user parts; `runQuery` spy still 0.
7. `MAX_ATTACH_BYTES = 5 MB`, `MAX_ATTACHMENTS_PER_TURN = 4`, `ATTACH_ALLOWED_MIME` exactly the four MIMEs — exported and unit-tested.
8. No apiKey string appears anywhere in the new message shapes (grep test on the host file).
9. Image bytes NEVER enter the system prompt, the auto-context, or resume replay (TASK-001 regression row).
10. `summarizeAttachmentsForLog` is the ONLY function allowed to receive `attachments` for logging; all log call sites use it (static check).

## §Out of scope
- Webview UX (TASK-002)
- CSS (TASK-003)
- Pure helpers (TASK-005 — note: `summarizeAttachmentsForLog` is task-005, task-001 imports it)


## Executor Report (cycle AB) — TASK-001
- **EXECUTOR_MODEL**: unic-code
- **EXECUTOR_TOOL**: task agent (general-purpose), worktree `.worktrees/task-001` (branch `handoff/ab-task-001`)
- **FILES_CHANGED**:
  - `src/ui/aiChatPanelMessages.ts` — additive: `ImageAttachment`, `AiChatPanelInit.visionCapable`, `AiChatPanelAttachError`, `AiChatPanelWebviewSend.attachments?`
  - `src/ui/aiChatPanel.ts` — CSP `img-src 'self' data:` (line 2096), `prepareAttachments` host validation + `omp` engine gate, `handleSend` builds `userMsg.content = [textPart, ...imageParts]`
  - `src/ui/__tests__/aiChatPanelAttachments.test.ts` — new file (313 lines, 10 cases a-j)
- **RED_OUTPUT (baseline, before any implementation)**:
  ```
  $ npx vitest run src/ui/__tests__/aiChatPanelAttachments.test.ts
  FAIL  src/ui/__tests__/aiChatPanelAttachments.test.ts > AiChatPanel — image attach (TASK-001 cycle AB) > #a happy: handleSend forwards {text, attachments:[valid]} as ChatContentPart[] (1 text + 1 image_url)
  FAIL  #b oversize (6 MB png): attach_error{reason:oversize}
  FAIL  #c count cap: 5 attachments → 5th rejected
  FAIL  #d mime text/plain → reason:unsupported_type
  FAIL  #e mime mismatch (jpeg + PDF magic)
  FAIL  #f engine='omp' + 2 valid → 2×{reason:vision_unsupported}
  FAIL  #g buildMessages with image parts → DDL-only sentinel
  ... 7 failed / 3 passed
  ```
- **GREEN_CONFIRMED**: 10/10 in aiChatPanelAttachments.test.ts; 164/164 across 8 chat-panel suites; `npm run typecheck` exit 0.
- **COMMIT**: `ad87300` (`handoff: cycle AB task-001 — host image attach (CSP fix, omp gate, buildMessages parts)`)

## Reviewer Verdict — R1 [TASK-001] (unic-smart)
- TASK: TASK-001
- VERDICT: CHANGES-REQUESTED
- VERIFICATION_RERUN: npx vitest run aiChatPanelAttachments/aiChatAttachments/aiChatPanelPrivacy/chatLayoutCss → 4 files, 64 pass / 0 fail (10+23+6+25); regression sweep aiChatPanelAcp+Messages+Mentions+ThoughtRegen → 104 pass / 0 fail; npm run typecheck → exit 0. Code substance verified: CSP at src/ui/aiChatPanel.ts:2211-2219 has img-src 'self' data: AND retains default-src 'none'/style-src/script-src; omp vision gate runs in prepareAttachments (aiChatPanel.ts:1055-1067) BEFORE the acpPrompt coercion (aiChatPanel.ts:1031-1033), so image parts can never reach ACP; prepareAttachments covers all 5 reasons (vision_unsupported :1055, count_cap :1075, oversize/unsupported_type/mime_mismatch via validateImageAttachment :1084-1092); only log shaper is summarizeAttachmentsForLog (aiChatPanel.ts:966-975), no raw base64 in any console call; no apiKey in message shapes (test #j green); text-only path byte-identity pinned by test #i; aiChatPanelPrivacy 6/6 green.
- BLOCKING:
  - docs/AI_HANDOFF/tasks/TASK-001.md (current revision @ 7db7faf) — no cycle-AB `## Executor Report`: EXECUTOR_MODEL / EXECUTOR_TOOL / RED_OUTPUT absent, so reviewer-vs-executor model isolation is unverifiable (the report visible in commit ad87300's tree is stale cycle-AA thought/regenerate text, never rewritten for AB). Fix: executor appends the AB report to this file — EXECUTOR_MODEL, FILES_CHANGED, VERIFICATION, and real RED output (failing vitest run of aiChatPanelAttachments.test.ts against pre-attachment host code) — then resubmit for re-review.
  - src/ui/__tests__/aiChatPanelPrivacy.test.ts (acceptance criterion 6) — required extension missing: file still contains only the 6 cycle-AA tests; no sentinel-seeded case with 2 valid attachments exists (grep "attachment|image" → 0 fixtures). Fix: add test [#7] seeding sentinelRows + driving the turn with 2 valid PNG attachments; assert SENTINEL_ROW/SENTINEL_VIEW absent from the system message AND every user part (stringified) and adapter runQuery spy still 0.
  - (minor→fix in same round) acceptance criterion 0b has no dedicated test: no suite combines @-mention + attachments (aiChatPanelMentions.test.ts has no attach cases; aiChatPanelAttachments.test.ts has no mention cases) even though the code path exists at src/ui/aiChatPanel.ts:1003-1014. Fix: one test sending "@public.users" + 2 valid attachments → user message has exactly 1 text part containing "--- Referenced context ---" + 2 sibling image_url parts.
- NOTES: No functional defect found in the diff (ba08bb7/8db1482 lineage); blockers are Quality-Gate paperwork (model self-report, per contract "executor did not self-report model") plus one named missing acceptance test. Minor drift noted, non-blocking: host vision gate is engine-only (aiChatPanel.ts:1057 passes engine==="builtin" as capability) — model-flag enforcement lives in init.visionCapable → webview (TASK-002) + agent.ts final belt, consistent with revised criterion 0a but diverging from the §Spec "Vision gating" bullet. package.json has no lint script; typecheck is the declared static gate and passed. Suggest INDEX_AB.md Status: done → changes_requested for this row after orchestrator reconciles (left untouched to avoid concurrent-writer conflict with R2/R3).

## Reviewer Verdict — R1.5 [TASK-001] (unic-smart)
- TASK: TASK-001
- VERDICT: APPROVED
- VERIFICATION_RERUN: aiChatPanelPrivacy.test.ts 7/7 (incl. [#7 cycle AB] sentinel + 2 attachments, :425); aiChatPanelAttachments.test.ts 11/11 (incl. #0b @public.users + 2 PNGs → 1 text part w/ Referenced context + 2 sibling image_url parts, :671); npm run typecheck exit 0; full sweep src/ui/__tests__/ 75 files, 1139/1139 pass @ 8db1482.
- BLOCKING: none — all 3 R1 blockers resolved: (1) `## Executor Report (cycle AB)` present before Reviewer Verdict with EXECUTOR_MODEL=unic-code (≠ reviewer unic-smart), FILES_CHANGED, real RED_OUTPUT ("7 failed / 3 passed" failing vitest run), GREEN_CONFIRMED, COMMIT ad87300; (2) privacy test #7 asserts SENTINEL_* absent from system AND user parts; (3) acceptance #0b dedicated mention×attachment test present.
- NOTES: Regression re-checks clean — CSP (src/ui/aiChatPanel.ts:2211-2219) retains default-src 'none'/style-src/script-src and adds img-src 'self' data:; prepareAttachments still emits all 5 reject reasons (vision_unsupported :1064, count_cap :1079, oversize/unsupported_type/mime_mismatch via validateImageAttachment src/ui/aiChatAttachments.ts:144-161 with PNG/JPEG/GIF/WEBP magic sniff). Non-blocking: executor RED_OUTPUT predates the two R1.5 tests (7 failed/3 passed = original 10-case cycle) — acceptable since c6000c7 is the R1.5 fix commit, not the executor's TDD cycle.
