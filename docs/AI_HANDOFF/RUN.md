Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ af88e47 (v1.43.0 + plan commit)
Phase: R5
Cursor: R2 done — 4/4 approved round 1 (001 approved_minor: PLAN §4 draftsCleared note + uncapped name-field minor, both non-blocking). INDEX rows done, PORT-ARP-08 superseded (v1.44.0). Suite 3160 | 2.
Next: R5 release v1.44.0 — CHANGELOG → version bump 1.44.0 → lockfile dual sync → verify:release + hygiene tests → commit → tag v1.44.0 → push main+tag → vsce package → gh release → close-out (RUN done).
