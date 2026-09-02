# TASK-BQ01-004 — Connection form + diagnostics for bigquery

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Form)

## Goal

BigQuery-specific fields (billing project, location, maxBytesBilled) render ONLY when
`driver === "bigquery"` (with host/port/user/password/SSL hidden for it, and the reverse
for the three SQL drivers), ADC remediation renders copy-safe verbatim, and an invalid
bigquery state cannot silently submit.

## Target Files

- `src/ui/connectionFormMessages.ts` — add `billingProject`, `bqLocation`,
  `bqMaxBytesBilled` (string, "" = unset) to `ConnectionFormSubmit` +
  `ConnectionFormTest`.
- `src/ui/connectionForm.ts` — pass the new fields through test/submit payloads; forward
  host `testResult` remediation text unchanged.
- `webview/connectionFormMain.ts` — render/hide BQ field group per driver; submit
  gating; verbatim remediation rendering.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | bigquery driver renders BQ group, hides SQL-only fields | built HTML/DOM has `billingProject` (and `bqLocation`, `bqMaxBytesBilled`) inputs; NO `host`/`port`/`password` input and no SSL block | webview harness with driver select = "bigquery" |
| 2 | edge-state | invalid bigquery state cannot silently submit | billingProject empty → Save click posts NO `{type:"submit"}` message; status element carries an inline error naming the billing project; same for `bqMaxBytesBilled:"0"` / non-numeric when present | harness, saved received-messages array |
| 3 | edge-copy | ADC remediation is copy-safe | host `testResult` remediation text renders verbatim in the status node; user-typed field values never concatenated into that node (assert node text === fixed copy exactly) | testResult with `gcloud auth application-default login` copy |
| 4 | regression | postgres form unchanged | driver=postgres renders host/port/user/password/SSL and NOT the BQ group; existing `connectionForm.test.ts` assertions stay green | existing suite |
| 5 | edge-wire | new fields ride the wire symmetrically | Test from a filled BQ form posts `{type:"test", billingProject:"proj-billing", bqLocation:"EU", bqMaxBytesBilled:"1000000", ...}`; empty fields post `""` (never omitted/undefined — TASK-001 manualCommit precedent) | harness |

## Test Files

- `src/ui/__tests__/connectionForm.test.ts` (modify — add bigquery group; existing tests
  untouched)
- `src/ui/__tests__/connectionFormBigqueryBundle.test.ts` (new, jsdom bundle test —
  mirror `connectionFormManualCommitBundle.test.ts`: loads `dist/connectionForm.js`,
  fake `acquireVsCodeApi`, asserts render/gating on the REAL bundle)

## Verification Commands

```bash
# 0. Compile first — bundle test evaluates dist/connectionForm.js
npm run compile

# 1. Focused proof
npx vitest run src/ui/__tests__/connectionForm.test.ts src/ui/__tests__/connectionFormBigqueryBundle.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED output pasted in Executor Report first).
- [ ] BQ fields render only for `driver === "bigquery"`; host/port/password/SSL never
      render for bigquery.
- [ ] Invalid bigquery form state blocks save with visible inline status (no silent
      submit, no host round-trip).
- [ ] Remediation/status text is never built by concatenating user input (copy-safe).
- [ ] `connectionFormManualCommitBundle.test.ts` stays green (existing webview behavior).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ01-001 (field names/types on the config shape this form mirrors). The host-side
  payload is validated end-to-end in TASK-BQ01-003's manager; this task only pins the
  wire + render contract, so 003 is a consumer, not a blocker.

## Interfaces

- Consumes:

```ts
// TASK-BQ01-001 config shape mirrored on the wire (string fields, "" = unset):
type BqFormFields = { billingProject: string; bqLocation: string; bqMaxBytesBilled: string };
// Extended messages (this task): ConnectionFormSubmit & ConnectionFormTest gain BqFormFields.
// Host → webview testResult.message carries the fixed AdcDiagnostic.remediation copy verbatim.
```

- Produces: `ConnectionFormSubmit`/`ConnectionFormTest` with `billingProject`,
  `bqLocation`, `bqMaxBytesBilled` — consumed by `connectionManager.addConnection`
  (TASK-BQ01-003, which maps `bqMaxBytesBilled:""` → omitted).

---

## Discussion

### 2026-09-02 · planner · unic-smart
`ConnectionForm`/`AdapterFactory` signatures are NOT changed; the form keeps posting the
existing flat payload plus the three new string fields. The host maps them into
`cfg.bigquery` (TASK-BQ01-003's territory) — the split is: 004 owns wire + DOM, 003 owns
config mapping.

### 2026-09-02 · planner · unic-smart
Driver select currently has 3 options (postgres/mysql/mssql, `DRIVER_PORTS` map in
`connectionFormMain.ts`). Add `"bigquery"` to the webview `Driver` union and render the
port field with the SQL drivers only; bigquery disables/clears port (validator pins
`port === 0`).

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
