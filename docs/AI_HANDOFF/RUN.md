Command: handoff-fullstack (OC4O cycle)
Goal: ship OC4O (Open Console for Object) + help grid
Base: main @ 4c71e40 (v1.51.0)
Phase: done (committed a05fa7d; tag/push deferred to maintainer)
Cursor: TASK-OC4O-001 (right-click Open Console for Object) + TASK-OC4O-002 (help grid panel) both implemented; bq04SurfaceGuard filter anchored to known contributes.menus sub-keys; 3417|2 green, typecheck 0, compile clean; R2 review caught 2 issues (AI chat card commandId + bq04SurfaceGuard filter latent bug), both fixed; CHANGELOG pre-staged for v1.51.1
Next: maintainer runs `npm version patch` (bumps package.json + package-lock.json to 1.51.1), then `git tag v1.51.1 && git push origin main v1.51.1` to publish
