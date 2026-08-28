# TASK-003 (cycle AB) — CSS for attachments strip + attach button + warning

Wave: 1 (parallel with TASK-001 host + TASK-005 pure helpers).
Owner files: `webview/styles.css` + new test file.
Constraint: no same-wave file overlap (T-001 owns .ts host; T-005 owns a new test only).

## §Spec

CSS contract additions for the image attach + paste feature. New classes (defined by TASK-002 webview) get theme-aware styles.

### New class declarations to add to `webview/styles.css`

```css
/* Attach button (icon button in composer row, left of send) */
.vsdb-chat-attach-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--vsdb-input-border);
  border-radius: 6px;
  background: var(--vsdb-input-bg);
  color: var(--vsdb-fg);
  cursor: pointer;
}
.vsdb-chat-attach-btn:hover:not(:disabled) {
  background: var(--vsdb-input-hover-bg);
}
.vsdb-chat-attach-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* Attachments strip — horizontal scroll row above the textarea */
.vsdb-chat-attachments {
  display: flex;
  flex-direction: row;
  gap: 8px;
  padding: 6px 8px;
  max-height: 80px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--vsdb-input-border);
}
.vsdb-chat-thumb {
  position: relative;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vsdb-input-border);
}
.vsdb-chat-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.vsdb-chat-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--vsdb-overlay-bg);
  color: var(--vsdb-fg);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.vsdb-chat-thumb-remove:hover {
  background: var(--vsdb-error-bg);
}

/* Warning bubble for attach rejections */
.vsdb-chat-attach-warning {
  background: var(--vsdb-warning-bg);
  color: var(--vsdb-warning-fg);
  border-left: 3px solid var(--vsdb-warning-border);
  padding: 6px 10px;
  margin: 4px 0;
  border-radius: 4px;
  font-size: 12px;
}
```

### Theme tokens (add to the existing `:root` and `[data-theme="dark"]` blocks)

The warning + overlay tokens may already exist; if not, add them. CSS contract test asserts presence.

### Regression pin

The cycle-AA `body.vsdb-chat-body { height: 100vh; }` rule (height chain fix from cycle-AA round 1b) MUST stay present. The new attachments strip lives inside `.vsdb-chat-input` (composer column) — it MUST NOT alter the panel flex chain.

## §Verification Commands

```bash
cd .worktrees/task-003
npx vitest run src/ui/__tests__/chatLayoutCss.test.ts
npm run typecheck
```

## §Dependency direction note (cycle AB review round 2)

T3 (wave 1) consumes T2's (wave 2) class names. Mechanically OK only because T3's tests assert the CSS source as text — the DOM is constructed by T2 and not asserted by T3. T3 declares the contract; T2 fulfils it.

## §Acceptance Criteria (revised round 2 — added edge rows)

1. **Happy**: all required declarations present in `webview/styles.css` (regex check, one assertion per declaration).
2. **Happy (theme)**: theme tokens used (no hardcoded colors).
3. **Happy (thumb)**: `.vsdb-chat-thumb img { object-fit: cover }` ensures 56×56 thumbnails don't distort.
4. **Regression (cycle AA)**: body height chain still present (regression pin: `.vsdb-chat-body { height: 100vh }`).
5. **Edge (overflow)**: with >4 thumbnails the strip scrolls horizontally (`overflow-x: auto`), no layout overflow breaks the composer column.
6. **Edge (theme fallback)**: the warning rule references `var(--vsdb-warning-bg)` (or an existing token) — never a hardcoded color string.
7. **Edge (focus)**: `.vsdb-chat-attach-btn:focus-visible` (or equivalent) declares a visible focus ring via theme token.
8. **Edge (dark theme)**: the `[data-theme="dark"]` block declares dark variants of the new tokens (no light-only fallback that breaks dark mode).


1. All required declarations present in `webview/styles.css` (regex check, one assertion per declaration).
2. Theme tokens used (no hardcoded colors).
3. `.vsdb-chat-thumb img { object-fit: cover }` ensures 56×56 thumbnails don't distort.
4. Cycle-AA body height chain still present (regression pin: `.vsdb-chat-body { height: 100vh }`).
5. CSS contract test exists in `src/ui/__tests__/chatLayoutCss.test.ts` (or a new task-003 file) and asserts the above.

## §Out of scope
- Webview DOM construction (TASK-002)
- Webview runtime logic (TASK-002)

## Reviewer Verdict — R2 [TASK-003] (unic-smart)
- TASK: TASK-003
- VERDICT: APPROVED-WITH-MINOR
- VERIFICATION_RERUN: npx vitest run src/ui/__tests__/chatLayoutCss.test.ts → 25/25 pass (1 file); npm run typecheck → exit 0. All 8 acceptance rows confirmed in webview/styles.css (attach-btn 1453, strip 1481, thumb 1489, img cover 1499, remove overlay 1507, warning token 1529, focus ring 1473, dark block 1436) + cycle-AA pin body.vsdb-chat-body{height:100vh} intact at 1302 (guarded by test h). No hardcoded color values in new rules — hex appears only as var() fallbacks per file-wide convention.
- BLOCKING: none
- NOTES: Minor (non-blocking): (1) styles.css:1452 comment says "24×24 hit target" but the rule is 28×28 — fix the comment; (2) styles.css:1436-1448 dark-block overrides for warning/error tokens are byte-identical to :root (only --vsdb-overlay-bg alpha 0.4→0.6 differs), so the "sharpen contrast" comment overstates — harmless since --vscode-* vars track theme; (3) chatLayoutCss.test.ts:469-493 test g only requires ≥1 dark token, could pin all 6. Model isolation OK: executor unic-code ≠ reviewer unic-smart. RED baseline evidence (8 fail / 17 pass → 25/25) is in commit da29b04 message, not appended to this task file.


## Executor Metadata (cycle AB)
- EXECUTOR_MODEL: unic-code
- EXECUTOR_TOOL: task agent (general-purpose)

## Reviewer Metadata (cycle AB)
- REVIEWER_MODEL: unic-smart
- REVIEWER_TOOL: code-reviewer (agent type)

## Reviewer Verdict — Cycle AD R1 (commit de6c6482)

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
COMMIT_SHA: de6c6482f2895a9de2f1512099d5798e1e8e7005
SCOPE: src/ui/aiChatPanel.ts (formatSystemPrompt extraction, ~695-852), src/extensionConfigExport.ts (NEW, 217), src/extension.ts (+100), src/__tests__/extensionConfigExport.test.ts (NEW, 122)
VERIFICATION_RERUN:
  command: npx vitest run src/__tests__/extensionConfigExport.test.ts src/ui/__tests__/aiChatPanelPrivacy.test.ts src/ui/__tests__/aiChatPanelAttachments.test.ts && npm run typecheck
  result: 23/23 pass (5 new + AA 7 + AB 11); typecheck exit 0 (tree = main @ 5934983, contains the commit)
FINDINGS:
  important:
    - package.json — vsdb.ai.useWithOmp + vsdb.ai.refreshDbContext are registered in extension.ts:410/421 but ABSENT from contributes.commands AND activationEvents; no webview button or menu exists either (git grep: only PLAN_AD.md + extension.ts). Commands are invisible in the Command Palette, so the user has NO invocation path — §9/§10 feature unreachable as shipped. Correct: add both to contributes.commands (category VSDB) + activationEvents onCommand entries.
  minor:
    - src/extensionConfigExport.ts:117-119 — ompCommandLine double-quotes configPath/contextPath/model without shell-escaping; `$`, backtick, or `"` in folder names breaks the copy-pasteable line. `-p` prompt is a fixed literal (no user input) — safe.
    - src/extension.ts:1095+ — multi-root workspace: always writes to workspaceFolders[0], not the root of the active connection.
    - src/extensionConfigExport.ts:186-217 — emitVsdbAiConfigRaw + renderYamlPublic + renderCommandLinePublic are needless wrappers; "Re-export the internal helpers" comment is false. Call renderYaml/renderCommandLine directly.
    - src/__tests__/extensionConfigExport.test.ts:87-97 — byte-equality pin only exercises the null-adapter (empty-context) branch; DDL-path bytes unpinned by this test (indirectly covered by AA privacy suite; direct source diff confirms core body byte-identical to pre-refactor).
    - src/extensionConfigExport.ts:166-172 — comment claims createDirectory throws "already exists"; vscode.workspace.fs.createDirectory is idempotent — comment misleading, catch is dead.
ACCEPTANCE_8_9_10_11: §8 PASS (extracted core byte-identical; buildMessages + exporter both call formatSystemPrompt; privacy invariant preserved, AA 7/7) · §9 PASS in code (AiSettings structurally cannot carry apiKey; YAML emits `# apiKey: $OPENAI_API_KEY` hint only; sentinel pin green; UTF-8 no-BOM, LF newlines) · §10 PARTIAL (line format has all 4 flags but command unreachable → important finding) · §11 PASS (AA 7/7 + AB 11/11 green).
SUGGESTED_FIXES:
  1. package.json: declare vsdb.ai.useWithOmp ("VSDB: Use with OMP") + vsdb.ai.refreshDbContext ("VSDB: Refresh DB Context") under contributes.commands and add onCommand activation entries; re-run build + palette smoke.
  2. (Optional, non-blocking) shell-escape paths in renderCommandLine; drop the Public/Raw wrapper trio.
NOTES: Model isolation OK — executor unic-code ≠ reviewer unic-smart. Core refactor is a clean, verified byte-preserving extraction; the only blocker is the missing package.json declaration that leaves the feature undiscoverable.

## Executor Report (cycle AD) — TASK-003
- **EXECUTOR_MODEL**: unic-code
- **EXECUTOR_TOOL**: task agent (general-purpose), worktree `.worktrees/task-ad-003` (branch `handoff/ad-task-003`)
- **FILES_CHANGED**: `src/ui/aiChatPanel.ts`, `src/extensionConfigExport.ts`, `src/extension.ts`, `src/__tests__/extensionConfigExport.test.ts`.
- **RED_OUTPUT**: `extensionConfigExport.test.ts` failed to load before implementation: missing exporter module and `formatSystemPrompt` export.
- **GREEN_CONFIRMED**: exporter suite 5/5; privacy 7/7; attachments 11/11; `npm run typecheck`: exit 0.
- **FIX ROUND**: `package.json` now declares and activates `vsdb.ai.useWithOmp` and `vsdb.ai.refreshDbContext`, making both commands discoverable. JSON parse and full test suite pass.
- **COMMIT**: `de6c6482` (task) + `247471e` (shared review fixes).


## Reviewer Verdict — cycle AD R2 [TASK-003]

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart (matches .ukit/storage/config.json handoff.reviewer.model)
EXECUTOR_MODEL: unic-code
COMMIT_SHA: 247471e (fix) on main @ 5934983
SCOPE: package.json (+10/-4; T3-relevant), readonlySqlParser.ts + 2 test files (T1/T2 scope)
VERIFICATION_RERUN:
  command: npx vitest run src/__tests__/extensionConfigExport.test.ts src/scaffold.test.ts
  result: 12/12 pass (2 files); package.json JSON.parse OK; typecheck exit 0 (shared facts)
FINDINGS:
  critical: none
  important:
    - package.json:186-192 — commit 247471e REPLACED the vsdb.aiChat contributes.commands block instead of inserting alongside (pre-state 247471e^:186 had title "VSDB: AI Chat" + icon; both deleted). extension.ts:389 still registers vsdb.aiChat and view/title menus (package.json:367-371) still reference it, so the schema-tree toolbar AI-chat item now points at an undeclared command (VS Code drops it) and "VSDB: AI Chat" vanished from the Command Palette. No test pins contributes.commands membership, so the suite stays green while the feature loses its invocation surface. Fix: re-insert the vsdb.aiChat command block.
  minor:
    - package.json:59 — trailing whitespace after "onCommand:vsdb.browseTableData", introduced by 247471e.
    - src/extensionConfigExport.ts:207-217 — R1 minor still open (renderYamlPublic/renderCommandLinePublic wrappers); unchanged, non-blocking.
R1_FIX_VERIFIED:
  - vsdb.ai.useWithOmp: declared package.json:188-192 (category VSDB, $(terminal)) + activation :57; ID matches registration extension.ts:410.
  - vsdb.ai.refreshDbContext: declared package.json:194-198 ($(refresh)) + activation :58; ID matches registration extension.ts:421.
  - Exporter behavior valid: 247471e did not touch extensionConfigExport.ts/extension.ts; exporter suite 5/5; §9 apiKey-never-on-disk and byte-identical-core invariants carry over.
SUGGESTED_FIXES:
  1. package.json: re-insert {"command":"vsdb.aiChat","title":"VSDB: AI Chat","category":"VSDB","icon":"$(comment-discussion)"} before the vsdb.ai.useWithOmp block; strip trailing space on :59; re-run build + palette smoke.
NOTES: Model isolation OK. Machine cross-check: 28 declared commands; activationEvents referencing undeclared commands = ["vsdb.aiChat"]. INDEX.md has no cycle AD rows (its TASK-003 row is the cycle-AA CSS task) — index left untouched.

## Reviewer Verdict — cycle AD R3 [TASK-003]

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart (matches .ukit/storage/config.json handoff.reviewer.model)
EXECUTOR_MODEL: unic-code
COMMIT_SHA: 247471e + uncommitted package.json correction (restores vsdb.aiChat block, strips trailing whitespace at :59)
VERIFICATION_RERUN:
  command: npx vitest run src/__tests__/extensionConfigExport.test.ts src/ui/__tests__/chatLayoutCss.test.ts src/ui/__tests__/aiChatPanelPrivacy.test.ts src/ui/__tests__/aiChatPanelAttachments.test.ts src/scaffold.test.ts src/ui/__tests__/tableCommands.test.ts && npm run typecheck
  result: 90/90 pass (6 files: exporter 5, CSS 25, privacy 7, attachments 11, scaffold 20, tableCommands 22); typecheck exit 0; package.json JSON.parse OK
TEST_PLAN_COVERAGE: all-followed — R2 blocker fixed: vsdb.aiChat contributes.commands block restored (package.json, title "VSDB: AI Chat", category VSDB, icon $(comment-discussion)); R2 minor fixed: trailing whitespace after onCommand:vsdb.browseTableData stripped. Machine cross-check: 29 declared commands, 0 activationEvents referencing undeclared commands, 0 declared commands missing activation events (vsdb.filterSchemaTree/clearSchemaTreeFilter/postmanPayload are programmatic-only by design — declared commands MAY omit onCommand events since VS Code auto-generates them from contributes). All three task commands verified end-to-end: vsdb.aiChat declared (package.json contributes) + activated (activationEvents :59) + registered (extension.ts:389); vsdb.ai.useWithOmp declared + activated (:60) + registered (extension.ts:410); vsdb.ai.refreshDbContext declared + activated (:61) + registered (extension.ts:421). §8 byte-equality, §9 apiKey-never-on-disk, §10 command-line flags invariants all green in extensionConfigExport.test.ts.
FINDINGS:
  critical: none
  important: none
  minor:
    - webview/styles.css:1451 — R2 minor still open (pre-existing, T3 cycle-AA scope): comment says "24×24 hit target" but rule is 28×28; cosmetic comment fix only.
    - src/extensionConfigExport.ts:207-217 — R1/R2 minor still open: renderYamlPublic/renderCommandLinePublic wrappers; unchanged, non-blocking.
    - src/__tests__/extensionConfigExport.test.ts:103-106 — ompCommandLine flag assertions check substring presence, not exact ordering; acceptable for a shape contract, noted for a future pin.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Model isolation OK — executor unic-code ≠ reviewer unic-smart. R2's critical path (vsdb.aiChat schema-tree toolbar entry + palette item pointing at an undeclared command) is fully resolved; no genuine blocker remains. INDEX.md TASK-003 row describes the cycle-AA CSS task, not this cycle-AD work — index left untouched as in R2.
