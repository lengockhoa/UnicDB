# Handoff INDEX

## Cycle RES2ROW — split the Results toolbar into exactly 2 rows

Base: main @ 7e29d2e (v1.53.38). Cycle kicked off 2026-09-09: user asked to split the
results toolbar in half — "Từ Where là đưa xuống dòng dưới" (from WHERE onwards moves to
a second line). Row 1 keeps the 8 icon buttons + `tsv` dropdown; row 2 holds WHERE,
ORDER BY, Re-Run, Clear, header checkbox, Copy, Export-file, schema chip, Search.

Supersedes the RES-BAR single-row contract (`.UnicDB-toolbar { flex-wrap: nowrap }`,
pinned by TASK-COLLAPSE-001 tests). Prior cycle archived at `INDEX_RES.md` / `ACTIVE_RES.md`
/ `PLAN_RES.md`.

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-COLLAPSE-002 | Webview: enforce exactly 2-row toolbar — `.UnicDB-toolbar` column + two `.UnicDB-toolbar-row` wrappers; WHERE/ORDER BY `flex: 1 1 100%` in row 2; re-target transactionControls insertBefore; flip 4 test pins | done | none | webview/main.ts, webview/styles.css, src/ui/__tests__/webviewToolbar.test.ts, tests/webviewRequeryAlignment.test.ts, src/ui/__tests__/aiChatPanelCloneCss.test.ts, src/ui/__tests__/webviewRequery.test.ts | unic-smart |

Waves: **wave 1 = TASK-COLLAPSE-002** (single task — all edits share webview/main.ts +
webview/styles.css, so no parallel split is possible).

Wave-boundary gates: `npm run typecheck` exit 0 · `npm run compile` clean (before any
bundle-eval test — they eval `dist/webview.js` and self-skip without it) · targeted
`npx vitest run …` GREEN · full `npm test` GREEN at closeout.
