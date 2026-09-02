# PLAN — Cycle AIX-09: Vision model + AI Settings engine-save fix + grid filter align

> **Status: PLANNED — NOT YET ACTIVATED.** This is a sibling plan file (docs-only).
> It does NOT own INDEX.md / ACTIVE.md / RUN.md / tasks/. To activate this cycle after
> the current BQ-01 cycle ships, run `/ukit:handoff-create` for "execute PLAN_AIX09.md"
> (recreate TASK-AIX09-00N.md from §Task Layout below, then proceed to handoff-implement).
> Base when planned: `main @ 9bfd07d` (v1.46.0). Release target: v1.47.0.

Source: user request (session 2026-09-02) — AI Setting Vision model + engine-save bug fix
+ grid set-filter select-all alignment. All scope decisions were made by the user via a
batched AskUserQuestion call (recorded verbatim in §1).

## §1 Intent

1. **Fix the engine-save bug (blocker).** Saving or testing in the AI Settings form always
   fails with "Engine must be builtin or omp" because the webview form has no engine field
   while the host validator (`src/ai/settings.ts:126-128`) requires `engine` to be exactly
   `"builtin"` or `"omp"` (`undefined` rejected). Every Save/Test from the form fails 100%.
   User decision (verbatim): *"Preserve engine (host-side merge) — khi Save/Test, host tự
   ghép engine đã lưu (hoặc 'builtin' mặc định) vào settings trước khi validate. Form KHÔNG
   thêm UI engine."*
2. **Add a dedicated Vision model role.** User decision (verbatim): *"Section riêng trong
   form"* — a 4th model-role section "Vision model" beside Work/Smart/Autocomplete; own
   model ID; shares baseUrl/API key/method; empty = feature off (placeholder suggests
   "dùng work model").
3. **Auto-fallbackVision.** User decision (verbatim): *"Auto-fallbackVision"* — when the
   user attaches an image: work model vision-capable → send image directly (unchanged);
   work NOT vision-capable AND vision model configured → host calls the vision model to
   produce a full description, then the work-model turn proceeds with that TEXT instead of
   image parts. Never blocked, never requires the user to switch models. When vision model
   is empty → keep EXACT current behavior (blocked + amber banner). omp engine stays
   hard-blocked for images regardless.
4. **Description depth.** User decision (verbatim): *"Mô tả đầy đủ"* — the vision describe
   prompt includes the user's question and demands every text, number, table, and chart in
   the image be transcribed so the work model answers as if it saw the image.
5. **Grid filter alignment** is folded into this cycle as its own task (user decision:
   "Gộp vào cycle").

Success definition: AI Settings Save/Test succeeds; Vision model configurable from the
form; attaching an image to a non-vision work model auto-describes and answers; select-all
checkbox aligns with detail-row checkboxes; full suite green; release v1.47.0.

## §2 Scope

**In scope (4 tasks):**
- `TASK-AIX09-001` — engine preserve fix (host-side merge in `src/ui/aiSettingsForm.ts`).
- `TASK-AIX09-002` — vision model role: settings type + store migration + webview form section.
- `TASK-AIX09-003` — auto-fallbackVision runtime (chat panel + attachments).
- `TASK-AIX09-004` — grid set-filter select-all CSS alignment.

**Out of scope:** engine dropdown UI in the form (user rejected); changing runtime engine
routing (reads workspace setting `vsdb.ai.engine`, NOT the store — extension.ts:702/1356);
vision Test button (Test stays role "work" only); a second provider factory or second
endpoint/key storage; omp image support; any change to `package.json` (no new commands or
config needed); telemetry/log of image bytes (never persist or log image data or apiKey).

**CONSTRAINT — same-wave file disjointness:**
- Wave 1 (3 parallel): 001 owns `src/ui/aiSettingsForm.ts` + `src/ui/__tests__/aiSettingsForm.test.ts`;
  002 owns `src/ai/settings.ts` + `src/ai/config.ts` + `webview/aiSettingsFormMain.ts` +
  `src/ai/__tests__/settings.test.ts` + `src/ai/__tests__/config.test.ts` +
  `src/ui/__tests__/aiSettingsFormBundle.test.ts` (+ one-line `vision` fixture keys in
  unrelated `Record<AiModelRole,…>` test literals if tsc flags them); 004 owns
  `webview/styles.css` + `src/ui/__tests__/chatLayoutCss.test.ts` +
  `src/ui/__tests__/webviewSetFilter.test.ts`.
- Wave 2 (1): 003 owns `src/ui/aiChatPanel.ts` + `src/ui/aiChatAttachments.ts` + NEW
  `src/ui/__tests__/aiChatVisionFallback.test.ts` + `src/ui/__tests__/aiChatPanelAttachments.test.ts`.
- No two same-wave tasks share a file. `aiSettingsForm.test.ts` (001) vs
  `aiSettingsFormBundle.test.ts` (002) are different files — allowed.

## §3 Approach

**3.1 Engine preserve merge (001).** In `handleSave` AND `handleTest` (src/ui/aiSettingsForm.ts:131/174),
before authoritative validation, resolve:

```ts
let engine = submitted.engine;
if (engine !== "omp" && engine !== "builtin") {
  try {
    engine = (await this.options.store.loadSettings())?.engine ?? "builtin";
  } catch {
    // Unreadable store ⇒ fall back to "builtin" (feature default), never
    // re-throw: the merge must not abort handleSave/handleTest (§4 store-failure row).
    engine = "builtin";
  }
}
const validated = { ...submitted, engine };
```

B13-channel-neutral: the merge never yields an illegal engine and never throws, so a
failed SAVE still posts `saveResult` and a failed TEST still posts `testResult` through the
existing channels (src/ui/aiSettingsForm.ts:138-141) — no new error channel. A follow-on
`store.save` rejection still posts `saveResult{ok:false}` via the existing try/catch.
No webview change for this bug.

**3.2 Vision model role (002).** Extend `AiModelRole` with `"vision"` in
`src/ai/settings.ts`; `defaultAiSettings()` seeds `vision: { modelId: "", vision: false }`
(empty = feature off). `redactAiConfig()` copies the autocomplete `?.` fallback pattern
for vision. `src/ai/config.ts` `loadSettings()` migration seeds a missing
`models.vision` with `{ modelId: "", vision: false }` (mirror the autocomplete migration
at config.ts:55-60) so pre-AIX09 stored configs stay valid; `save()`'s `toPersist`
literal gains the vision role. Webview `webview/aiSettingsFormMain.ts`: add a
`modelBlock("vision", "Vision", false, { placeholder: "vendor/vision-model (tùy chọn — để trống để dùng work model)", showVision: false })`
section; `readSettings()` gains `vision: { modelId: input("modelVision").value.trim(), vision: false }`;
`applyInit()` hydrates `modelVision`; the local `validateSettings()` mirror stays in
lockstep with the host validator — empty vision modelId is ALLOWED (feature off).
Fixture-only `vision:` keys may be added to unrelated `Record<AiModelRole,…>` literals
that tsc flags (folded into 002's typecheck acceptance).

**3.3 Auto-fallbackVision (003).** Current hard gate: `prepareAttachments` in
`src/ui/aiChatPanel.ts` (~1840) calls `validateAttachmentsForVision(attachments, this.engine === "builtin")`
(engine-based; the init-time `visionCapable` value at aiChatPanel.ts:3239 is separate) —
003 widens BOTH: vision-capable = engine builtin AND (work.vision OR vision modelId
non-empty). Turn flow when work is NOT vision-capable but a vision model IS configured:

1. Images pass validation; for each image attachment (bounded by the existing
   `MAX_ATTACHMENTS_PER_TURN = 4`, src/ui/aiChatAttachments.ts:32 — reuse, no new constant)
   the host fires a describe call directly through the panel's existing `deps.complete(cfg, "vision", req)`
   with `req.modelId = cfg.models.vision.modelId` set explicitly. It must bypass `runAgent`
   (agent.ts:314 throws on non-work/smart roles) — no extension.ts/provider.ts change
   (`deps.complete` closures in extension.ts:752-757 ignore the role param; role→model
   binding happens via `cfg.models[role].modelId` in agent.ts:335).
2. Describe prompt (full-depth, user-approved): includes the user's question + demands
   transcription of ALL text, numbers, tables, chart shapes, and layout in the image, so
   the work model can answer as if it saw the image.
3. The work-model turn proceeds with the descriptions injected as clearly-labelled text
   parts (per-image "Ảnh N mô tả: …") instead of image parts.
4. Image part construction uses the INLINE template `data:${a.mime};base64,${a.base64}`
   (as the existing direct path does, src/ui/aiChatPanel.ts:1699). Do NOT use
   `imageBytesToDataUrl` here — `MinimalAttachment` carries `base64: string` +
   `bytes: number` (a count), and the helper is bytes-first
   `imageBytesToDataUrl(bytes: Uint8Array, mime: string)` (aiChatAttachments.ts:204);
   it does not apply to `MinimalAttachment` payloads.
5. Vision describe failure → surface the existing attachment/vision error card for that
   turn (fail that turn, not silently); never block non-image turns.
6. Vision model empty + work not vision-capable → EXACT current behavior (blocked +
   "Cannot attach image — current model does not support images" banner).
7. omp engine → hard-blocked unchanged (`visionCapable=false` regardless of config).
8. Never log/persist image bytes or base64 (follow `summarizeAttachmentsForLog` redaction).

**3.4 Grid select-all alignment (004).** Root cause (verified): `.vsdb-setfilter-selectall`
has NO CSS rule at all, while detail-row checkboxes `.vsdb-setfilter-entry-checkbox` carry
`margin: 0; flex: 0 0 auto` (webview/styles.css; row padding pinned 8px at styles.css:1113).
Fix is checkbox-level: give the select-all checkbox the same margin/flex reset (and any
shared CSS var) so it lines up left with the entry checkboxes. DOM stays untouched unless
a class must move (webview/main.ts:1239-1289 builds the row). Assertions are CSS-text
contract tests (regex on styles.css content, mirroring `chatLayoutCss.test.ts` pattern) +
existing `webviewSetFilter.test.ts` DOM assertions; NO pixel assertions in jsdom.

## §4 Test Plan

TDD: each task ships happy + ≥2 edge cases of different kinds; 001 is a bugfix ⇒ regression
required. All suites DB-free (vitest unit lane).

| Task | Type | Test name | Expected |
|---|---|---|---|
| 001 | regression | save with engineless payload succeeds (was: "Engine must be builtin or omp") | host merges engine from stored settings; `store.save` called with `engine` present; `saved` posted |
| 001 | happy | test button with engineless payload | `complete` called; `testResult{ok}` (when provider ok); NO `saveResult` on Test path (B13) |
| 001 | edge-value | submitted `engine:"omp"` is preserved verbatim | merge keeps `"omp"`; `store.save` receives `"omp"` |
| 001 | edge-store | store read fails / returns null | fallback `"builtin"`; save proceeds; no throw escapes handler |
| 001 | edge-invalid | genuinely invalid settings (e.g. bad baseUrl) still rejected | `saveResult{ok:false}` with existing exact message; `store.save` NOT called |
| 002 | happy | defaults deep-equal include `vision: {modelId:"",vision:false}` | `defaultAiSettings()` shape; validator accepts |
| 002 | edge-migration | stored config WITHOUT `models.vision` loads valid | migration seeds `{modelId:"",vision:false}`; `loadSettings()` non-null |
| 002 | edge-validation | vision modelId empty + work/smart set | NO error (feature off is valid); webview Save button enabled |
| 002 | edge-redaction | `redactAiConfig` on config with vision role | redacted settings carry vision role; apiKey absent |
| 002 | regression | legacy two-role fixture (no vision key anywhere) still loads | `loadSettings()` valid; form init OK (autocomplete-migration precedent) |
| 003 | happy | attach image, work.vision=false, vision model set | image passes validation; ≥1 `deps.complete(cfg,"vision",req)` with `modelId=cfg.models.vision.modelId`; work turn runs with text description parts, no image parts |
| 003 | edge-bound | 5 images attached | describe calls capped at `MAX_ATTACHMENTS_PER_TURN` (4); excess rejected by existing limit path |
| 003 | edge-fail | vision describe call rejects | turn surfaces existing vision/attachment error card; work turn NOT executed with empty description; no image bytes logged |
| 003 | edge-gate | vision model empty + work.vision=false | current behavior preserved: attachments rejected `vision_unsupported`; banner message unchanged |
| 003 | edge-direct | work.vision=true (vision model irrelevant) | direct image path unchanged; zero vision describe calls |
| 003 | edge-dataurl | data-URL construction | byte-exact `data:image/png;base64,<payload>` from `a.mime`+`a.base64` (inline template; helper not applicable) |
| 004 | contract (RED→GREEN) | `.vsdb-setfilter-selectall` gains the entry-checkbox reset | styles.css contains margin/flex reset matching `.vsdb-setfilter-entry-checkbox` contract |
| 004 | regression | set-filter DOM structure assertions still pass | select-all row/label/checkbox structure unchanged in `webviewSetFilter.test.ts` |

## §5 Verification Commands

```bash
# per-task targeted
npx vitest run src/ui/__tests__/aiSettingsForm.test.ts                        # 001
npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts \
  src/ui/__tests__/aiSettingsFormBundle.test.ts                               # 002
npx vitest run src/ui/__tests__/aiChatVisionFallback.test.ts \
  src/ui/__tests__/aiChatPanelAttachments.test.ts                             # 003 (wave 2)
npx vitest run src/ui/__tests__/chatLayoutCss.test.ts \
  src/ui/__tests__/webviewSetFilter.test.ts                                   # 004

# static + bundle gates (every task)
npm run typecheck && npm run compile

# wave/cycle boundaries
npm test                      # wave 1 close (001+002+004) and wave 2 close
npm run verify:release        # cycle close — baseline 3209 passed | 2 skipped at v1.46.0
```

## §6 Acceptance Criteria

- [ ] Save and Test in AI Settings succeed with engineless webview payloads; regression test green; B13 channel separation intact (`npm test` proves).
- [ ] Vision model section renders in the form; pre-AIX09 stored configs load without error; empty vision modelId keeps feature off and Save enabled.
- [ ] Non-vision work model + configured vision model: image attach → describe → text-only work turn; ≤4 describes per turn; failures surface without logging image data.
- [ ] Direct-vision and omp paths byte-unchanged in behavior (banner preserved when vision model empty).
- [ ] Select-all checkbox CSS-aligned with entry checkboxes; DOM structure regression green.
- [ ] `npm run typecheck`, `npm run compile` green after every task; `npm run verify:release` green at cycle close; release v1.47.0.

## §7 Global Constraints

- Existing exact validator error strings in `aiSettingsErrors` stay byte-identical.
- omp stays hard-blocked for images. Vision model shares work config's baseUrl/API key/method.
- Never log or persist image bytes/base64 or apiKey. vitest suites stay DB-free.
- Webview stays vanilla-DOM; bundles must pass `npm run compile`.
- Runtime engine routing (`vsdb.ai.engine` workspace setting) is NOT touched by this cycle.

## Planner Self-Audit

Checklist 12/12 pass. Corrections made during planning (verified against source at v1.46.0):
attachment hard gate is engine-based in `prepareAttachments` (not init-time `visionCapable`);
`deps.complete` closures ignore the role param (role→model binding in agent.ts:335 via
`cfg.models[role].modelId`) so no extension.ts/provider.ts change is needed; reuse
`MAX_ATTACHMENTS_PER_TURN = 4`; CSS root cause = missing select-all checkbox reset.
Known gaps: no vision Test button (out of scope); alignment asserted via CSS-text contract,
not pixels; unrelated `Record<AiModelRole,…>` fixtures may need one-line `vision` keys.

## Plan Review Log

### Round 1 — 2026-09-02 — Issues Found
- IMPORTANT §3.3: `imageBytesToDataUrl(a.mime, a.bytes)` wrong seam — real signature is
  bytes-first `imageBytesToDataUrl(bytes: Uint8Array, mime: string)` (aiChatAttachments.ts:204);
  `MinimalAttachment.bytes` is a number; payload is `base64: string`; inline template is
  `data:${a.mime};base64,${a.base64}` (aiChatPanel.ts:1699).
- MINOR §3.1: merge snippet lacked try/catch while §4 mandated a graceful store-failure path.
- MINOR §3.1: B13-channel-neutrality not stated explicitly.
- Verified clean: engine rejection lines, config migration, agent role binding, extension
  complete closures, MAX_ATTACHMENTS_PER_TURN, set-filter anchors, YAGNI exclusions.

### Round 2 — 2026-09-02 — Resolved (planner revision)
- §3.3 rewrote image-part construction to the inline template + helper-inapplicability warning;
  added the edge-dataurl test row; TASK-AIX09-003 Interfaces/Test rows corrected (the review
  pass at the time operated on the live PLAN.md + TASK files; this file preserves the same fixes).
- §3.1 try/catch → `"builtin"` fallback added; §4 store-failure row reworded to agree.
- B13-neutral paragraph added.

### Round 3 — 2026-09-02 — Approved
- All three findings verified fixed in actionable sections; no new critical/important
  findings. One non-blocking minor (stale "§4 row 87" cross-ref) applied immediately —
  §3.1 comment now reads "§4 store-failure row".
- NOTES: citations re-verified against source: `MinimalAttachment{base64,bytes:number}`
  (aiChatAttachments.ts:69-74), bytes-first helper (:204), inline template (aiChatPanel.ts:1699),
  engine rejection (src/ai/settings.ts:126-128), B13 channels (src/ui/aiSettingsForm.ts:138-141).

## Task Layout (for activation)

| Task | Title | Owns | Depends |
|---|---|---|---|
| TASK-AIX09-001 | Engine preserve fix (host-side merge) | `src/ui/aiSettingsForm.ts` + `src/ui/__tests__/aiSettingsForm.test.ts` | none |
| TASK-AIX09-002 | Vision model role (settings+store+form) | `src/ai/settings.ts`, `src/ai/config.ts`, `webview/aiSettingsFormMain.ts` + their tests | none |
| TASK-AIX09-004 | Grid set-filter select-all alignment | `webview/styles.css` + `chatLayoutCss.test.ts` + `webviewSetFilter.test.ts` | none |
| TASK-AIX09-003 | Auto-fallbackVision runtime | `src/ui/aiChatPanel.ts`, `src/ui/aiChatAttachments.ts`, NEW `aiChatVisionFallback.test.ts`, `aiChatPanelAttachments.test.ts` | TASK-AIX09-002 |

Waves: wave 1 = 001+002+004 (parallel); wave 2 = 003.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 3)
