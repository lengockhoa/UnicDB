# TASK-004 — AI Settings form (webview) + extension wiring + README privacy
- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §2,§3,§7

## Goal
One chỗ config AI (user requirement #1): AI Settings webview form (ConnectionForm pattern)
to view/edit baseUrl, method, timeout, maxSteps, both model roles (id + vision), and apiKey;
Test button smoke-fires the provider; `vsdb.openAiSettings` command wiring; README documents
the privacy/egress contract. The apiKey NEVER round-trips to the webview (host sends
`hasApiKey` only; empty key on submit = keep stored key).

## Target Files
- `src/ui/aiSettingsForm.ts` (new) — host panel class (ConnectionForm/NewTableForm mirror).
- `src/ui/aiSettingsFormMessages.ts` (new) — typed message protocol.
- `webview/aiSettingsFormMain.ts` (new) — vanilla DOM entry (connectionFormMain.ts style).
- `esbuild.js` (edit) — add `aiSettingsFormConfig` entry → `dist/aiSettingsForm.js` (both watch and build arrays).
- `package.json` (edit) — contribute `vsdb.openAiSettings` command + command-palette category (no menus/views this cycle).
- `src/extension.ts` (edit) — register `vsdb.openAiSettings` → `AiSettingsForm.show()` (instantiate store + form; keep single-instance reveal-on-reshow inside the form).
- `README.md` (edit) — new **AI** section: privacy/egress contract (below).
- `src/ui/__tests__/aiSettingsForm.test.ts` (new) · `src/ui/__tests__/aiSettingsFormBundle.test.ts` (new) · `src/extension.test.ts` (edit — command registration).

## Spec — contract (normative, frozen)
```ts
// src/ui/aiSettingsFormMessages.ts
export interface AiSettingsFormInit {           // host → webview (on ready)
  type: "init";
  settings: AiSettings;                         // REDACTED — never carries apiKey
  hasApiKey: boolean;
}
export interface AiSettingsFormSave {           // webview → host: OK pressed
  type: "save";
  settings: AiSettings;                         // validated webview-side, re-validated host-side
  apiKey: string;                               // "" ⇒ keep stored key (host decides)
}
export interface AiSettingsFormTest {           // webview → host: Test pressed
  type: "test";
  settings: AiSettings;
  apiKey: string;                               // "" ⇒ host uses stored key
}
export interface AiSettingsFormCancel { type: "cancel" }   // webview → host (Cancel/Escape)
export type AiSettingsFormWebviewMessage = AiSettingsFormSave | AiSettingsFormTest | AiSettingsFormCancel;
export interface AiSettingsFormTestResult {     // host → webview
  type: "testResult"; ok: boolean; latencyMs?: number; error?: string;  // error string is apiKey-FREE
}
export interface AiSettingsFormSaved { type: "saved" }     // host → webview after store.save
export type AiSettingsFormHostMessage = AiSettingsFormTestResult | AiSettingsFormSaved;
```
```ts
// src/ui/aiSettingsForm.ts
export interface AiSettingsFormOptions {
  extensionUri: vscode.Uri;
  store: Pick<AiConfigStore, "loadSettings" | "loadApiKey" | "save">;   // injected → fake-able
  /** Injected để Test button không cần store API key. */
  complete: (cfg: AiConfig, role: "work", req: ProviderRequest) => Promise<ProviderResult>;
}
export class AiSettingsForm {
  constructor(options: AiSettingsFormOptions)
  show(): void          // create panel or reveal existing; posts init on webview ready
  dispose(): void
}
```
Host behavior (normative): `init` = `{settings: (await store.loadSettings()) ??
defaultAiSettings(), hasApiKey: (await store.loadApiKey()) !== undefined}`. `save`:
re-validate via `aiSettingsErrors`; apiKey `""` + `hasApiKey` ⇒ reuse `loadApiKey()`; `""` +
no stored ⇒ error (testResult-style guard — do NOT save); valid ⇒ `store.save(settings,
apiKey)` then post `{type:"saved"}` (webview shows success). `test`: build cfg from
submitted values + resolved key ⇒ `complete(cfg, "work", {modelId: settings.models.work.modelId,
messages:[{role:"user",content:"Reply with: ok"}], maxOutputTokens: 8})` ⇒ post
`{type:"testResult", ok:true, latencyMs}` or `{ok:false, error: ProviderError.message}`
(apiKey never included — provider scrubs; host adds no key material). Invalid submitted
settings ⇒ `{ok:false, error: firstAiSettingsError}` — provider/fetch never invoked.
Webview behavior: field per settings key + 2 role blocks (modelId input + vision checkbox);
live validation via `aiSettingsErrors` (imported from `src/ai/settings.ts` — bundle-safe);
OK disabled while errors; key input placeholder shows `•••• stored` when `hasApiKey` and
empty key means keep; Escape/Cancel ⇒ `{type:"cancel"}` (host disposes). Test button
disabled while invalid or while a test is in flight.

README **AI** section (normative content): settings stored per-machine (VS Code
SecretStorage for the API key, global state for the rest); ALL AI requests go ONLY to the
configured baseUrl — no third-party endpoints, no telemetry; the key is never logged or
included in error messages; how to open the form (`VSDB: Open AI Settings`).

## Test Cases (REQUIRED — TDD)
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | init round-trip | loadSettings→fixture, loadApiKey→"sk-1": ready handler posts init with the settings deep-equal + `hasApiKey:true`; posted message has NO `apiKey` key |
| 2 | unit | unconfigured init | both stores empty → init settings deep-equal `defaultAiSettings()`, hasApiKey false |
| 3 | unit | save happy path | `{type:"save", settings: valid, apiKey:"sk-2"}` → `store.save` called with (valid, "sk-2"); posts `{type:"saved"}` |
| 4 | unit | save keeps stored key on empty | hasApiKey true + submitted apiKey "" → save called with stored "sk-1" |
| 5 | edge (security) | empty key, nothing stored | hasApiKey false + apiKey "" → save NOT called; webview receives error-bearing message (`{type:"testResult", ok:false, error:"API key is required"}` or equivalent) |
| 6 | edge (validation) | host re-validates | submitted invalid settings → save NOT called, error message posted, no complete call |
| 7 | unit | test happy path | `{type:"test", settings: valid, apiKey:""}` (stored "sk-1") → complete called once with `{modelId: models.work.modelId, messages:[{role:"user",content:"Reply with: ok"}], maxOutputTokens:8}`, role "work", cfg.apiKey "sk-1" → posts `{type:"testResult", ok:true, latencyMs≥0}` |
| 8 | edge (error) | test failure maps to testResult | complete rejects ProviderError("401 Unauthorized — bad key") → `{ok:false, error:"401 Unauthorized — bad key"}`; error string contains no "sk-" |
| 9 | unit | bundle renders + live validation | jsdom over `dist/aiSettingsForm.js`: init → all fields present (baseUrl, method select, timeout, maxSteps, work/smart modelId, vision checkboxes, apiKey); type garbage baseUrl → error shown + OK disabled; fix → OK enabled |
| 10 | unit | bundle submit | valid fields + key "sk-9" → OK posts `{type:"save", settings:{…values}, apiKey:"sk-9"}` |
| 11 | edge (UI) | cancel/Escape | dispatch cancel (host test: panel disposed, save never called); jsdom: Escape key → cancel message posted |
| 12 | unit | extension wiring | `vsdb.openAiSettings` in package.json contributes.commands; extension activate registers a handler for it (assert registration list contains the command id) |
| 13 | edge (security) | README contract | README contains the AI section naming SecretStorage, the single-endpoint egress promise, and the no-telemetry/no-log statement |

## Test Files
- `src/ui/__tests__/aiSettingsForm.test.ts` (host tests #1–#8, #11a) · `src/ui/__tests__/aiSettingsFormBundle.test.ts` (jsdom #9, #10, #11b) · `src/extension.test.ts` (#12, edit existing)

## Verification Commands
```bash
npm run compile && npx vitest run src/ui/__tests__/aiSettingsForm.test.ts src/ui/__tests__/aiSettingsFormBundle.test.ts src/extension.test.ts && npx tsc --noEmit
```
(`npm run compile` first so `dist/aiSettingsForm.js` exists for the bundle test — house pattern from newTableFormBundle. No lint script in this repo; typecheck is `npx tsc --noEmit`.)

## Acceptance Criteria
- [ ] All 13 §Test Cases PASS (RED→GREEN, real output pasted) — bundle tests run after `npm run compile`.
- [ ] No host→webview message ever contains an apiKey; webview→host key only inside save/test payloads.
- [ ] Strict CSP + reveal-on-reshow + dispose wired exactly like ConnectionForm.
- [ ] README AI section present with the normative content above. Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 (`AiSettings`, `AiConfig`, `defaultAiSettings`, `aiSettingsErrors`, `AiConfigStore` from `src/ai/settings.ts` + `src/ai/config.ts`), TASK-002 (`ProviderRequest`, `ProviderResult`, `ProviderError`, `createProviderClient` from `src/ai/provider.ts` — the real client binds at wiring: host `complete` = `createProviderClient({...cfg}).complete`)

## Interfaces
- Consumes: TASK-001 + TASK-002 symbols above (exact names); ConnectionForm/NewTableForm panel patterns (`src/ui/connectionForm.ts`, `src/ui/newTableForm.ts`).
- Produces: `vsdb.openAiSettings` command + `AiSettingsForm` class (`show(): void`, `dispose(): void`) — the single user-facing config surface for cycle J and all later AI cycles.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
hasApiKey-instead-of-key is the privacy decision for this form: the webview can never leak what it never receives; empty-key-keeps-stored matches ConnectionForm's password UX. @executor: host tests reuse the fake-webview-panel pattern from `src/ui/__tests__/connectionForm.test.ts` / `newTableForm.test.ts`; bundle test stubs `acquireVsCodeApi` + ResizeObserver/matchMedia exactly like `newTableFormBundle.test.ts` and MUST skip-with-message if `dist/aiSettingsForm.js` is missing. No chat panel, no streaming, no DB tools here — scope guards in PLAN §2.

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
