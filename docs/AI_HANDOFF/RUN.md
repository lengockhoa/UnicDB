Command: handoff-fullstack (MENU cycle)
Goal: reorder schema-tree table-node context menu — New Table #1, Modify Table #2, rest alphabetical below
Base: main @ 0fc7106 (v1.51.0)
Phase: done (committed b0fb1f9; tag/push deferred to maintainer)
Cursor: TASK-MENU-001 (schema-tree table-node context menu order) implemented; declarative `"order": "1"` / `"order": "2"` added on `vsdb.newTable` / `vsdb.modifyTable` `view/item/context` entries; `bq04SurfaceGuard` `contributesKeyPattern` whitelist extended with `order` to keep the dependency-drift guard filtering contributes changes; 3 new MENU tests (happy + structural + behavioral) TDD-embedded — RED before package.json edit, GREEN after; 3420|2 green (baseline 3417 + 3 new), typecheck 0, compile clean; CHANGELOG pre-staged for v1.51.1
Next: maintainer runs `npm version patch` (bumps package.json + package-lock.json to 1.51.1), then `git tag v1.51.1 && git push origin main v1.51.1` to publish
