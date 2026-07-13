# Progress — LabGate

Check off a phase only after its "done when" check in BUILD_PROMPT.md actually
passes. Add a one-line note for any deviation from the plan. If you're resuming
after a break — or you're a different agent picking this up — read this file
first. Don't redo a checked phase. Don't start a phase before the ones above it
are checked.

- [x] Phase 0 — Scaffold
- [x] Phase 1 — Database
- [x] Phase 2 — Auth
- [x] Phase 3 — Machine list + checkout API
- [ ] Phase 4 — Provisioning module
- [ ] Phase 5 — Machine-side scripts
- [ ] Phase 6 — Webhooks + heartbeat
- [ ] Phase 7 — Backstop sweep (server side)
- [ ] Phase 8 — End-to-end pass

## Notes / deviations

- Package manager changed from Bun to npm at the user's request; `AGENTS.md` and
  `BUILD_PROMPT.md` were updated to keep the project contract consistent.

## Blockers
