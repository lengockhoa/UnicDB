# TASK-001 — Expose per-connection manual-commit mode

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 item 3, §3.1

## Goal

Expose the already-implemented manual transaction mode through the add/edit connection form.
A saved connection must persist `manualCommit`; when enabled, the existing host transaction path
and existing webview Commit/Rollback controls become reachable. Do not alter
`webview/main.ts`: the `transactionStatus`-gated controls already exist.

## Target Files

- `src/ui/connectionFormMessages.ts` — add `manualCommit: boolean` to submit and test payloads.
- `webview/connectionFormMain.ts` — render, read, and edit-prefill the checkbox.
- `src/extension.ts` — copy payload `manualCommit` into both add and edit connection config paths.
- `src/ui/__tests__/connectionForm.test.ts` — host message/protocol regression coverage.
- `src/extension.test.ts` — add/edit config forwarding coverage using the existing extension test harness.
- `src/ui/__tests__/connectionFormManualCommitBundle.test.ts` **(new)** — jsdom bundle test for the
  real checkbox render/read/prefill behavior in `dist/connectionForm.js`.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Checked add-form submission persists manual mode | Clicking Save with `#manualCommit.checked === true` posts `{type:"submit", manualCommit:true, …}`; `onSave` receives `manualCommit:true`; the add config passed to `mgr.addConnection` has `manualCommit:true`. | Real compiled form bundle for post shape; existing `ConnectionForm`/extension mocks for host forwarding. |
| 2 | edge — empty/default | Untouched add form is explicitly automatic | With the new checkbox never selected, the post and add config contain exactly `manualCommit:false`, not omitted/`undefined`. | Valid required connection form inputs; checkbox left unchecked. |
| 3 | regression — edit/persistence | Edit mode prefills and retains manual mode | Init with `existing.manualCommit === true` checks `#manualCommit`; Save sends true and `mgr.editConnection` receives a patch whose `manualCommit` is true. An existing record with no field initializes unchecked. | One existing config with true and one legacy config omitting the optional field. |
| 4 | edge — protocol symmetry | Test-connection payload keeps the field | Clicking Test from a checked form posts `type:"test"` with `manualCommit:true`; the host accepts it while retaining its existing factory/test behavior. | Existing SSL test fixture with the new checkbox checked. |

## Test Files

- `src/ui/__tests__/connectionForm.test.ts`
- `src/extension.test.ts`
- `src/ui/__tests__/connectionFormManualCommitBundle.test.ts` **(new)**

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/connectionForm.test.ts src/ui/__tests__/connectionFormManualCommitBundle.test.ts src/extension.test.ts
npm run typecheck
```

`npm run compile` is required before the new bundle test because it reads
`dist/connectionForm.js`. `package.json` has no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [ ] Add and Edit forms visibly contain a manual-commit checkbox using the existing form-checkbox
      styling pattern.
- [ ] `ConnectionFormSubmit` and `ConnectionFormTest` both carry a concrete boolean,
      `manualCommit`.
- [ ] Add and edit configuration paths persist the checkbox value exactly.
- [ ] Existing connections without the optional persisted field display unchecked and remain
      editable.
- [ ] Existing `transactionStatus` behavior remains the only control for showing the existing
      Commit/Rollback buttons; no duplicate toolbar is added.
- [ ] All listed verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes: `ConnectionFormSubmit` and `ConnectionFormTest` in
  `src/ui/connectionFormMessages.ts`; `SubmitPayload = Omit<ConnectionFormSubmit, "type">`
  in `src/ui/connectionForm.ts:18`; `ConnectionManager.addConnection(cfg, password)` and
  `editConnection(id, patch, password?)` from the existing extension path.
- Produces: persisted `ConnectionConfig.manualCommit` supplied by UI; the existing
  `SaveContext.getManualCommit(): boolean` in `src/extension.ts:97` then observes it.

---

## Discussion

1. **Product decision is fixed.** The human chose *EXPOSE THE UI*, not removal of the existing
   path. Do not replace this with a VS Code setting or command.
2. **Grounded existing behavior.** `webview/main.ts:557-560` already inserts/removes
   `transactionControls` based on the `transactionStatus` protocol; it needs no change here.
3. **Stated unknown — do not guess.** This planner could not read `src/config/types.ts` because
   the directory was permission-denied. A repository-wide grep confirmed
   `manualCommit?: boolean` at line 44 only. Before editing `extension.ts`, open that file and
   confirm the precise `ConnectionConfig` declaration; if it contradicts the confirmed grep,
   stop and record the conflict rather than inventing a type.
4. **TDD order.** First add the failing form bundle/host assertions for `manualCommit`; then add
   the protocol and forwarding fields. Do not mark ready after a type-only change.

---
