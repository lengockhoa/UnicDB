# Active Cycle

Cycle: OC4O (Open Console for Object)
Date: 2026-09-03
Base: main @ 4c71e40 (v1.51.0)
Goal: ship right-click "Open Console for Object" on schema-tree table/view nodes + Help Grid panel
Tasks: 2 total (TASK-OC4O-001, TASK-OC4O-002)
Status: implementation done — R2 review caught 2 issues (AI chat card pointed to non-existent `vsdb.ai.open`; bq04SurfaceGuard menu-key regex silently dropped `dependencies:`/`devDependencies:` lines). Both fixed; 3417/3417 tests pass, typecheck 0, compile clean. CHANGELOG entry pre-staged for v1.51.1. **BLOCKED on user**: `package-lock.json` is write-protected by repo hooks, so version bump to v1.51.1 must be done by user (run `npm version patch` or manually bump + `npm install`). After user bumps, commit + tag + push proceeds.
