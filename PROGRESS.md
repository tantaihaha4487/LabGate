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
- [x] Phase 4 — Provisioning module
- [x] Phase 5 — Machine-side scripts
- [x] Phase 6 — Webhooks + heartbeat
- [x] Phase 7 — Backstop sweep (server side)
- [ ] Phase 8 — End-to-end pass

## Notes / deviations

- Package manager changed from Bun to npm at the user's request; `AGENTS.md` and
  `BUILD_PROMPT.md` were updated to keep the project contract consistent.
- Restored the full `AGENTS.md` contract after `create-next-app` replaced it with
  generated Next.js guidance; that guidance is retained at the end of the file.
- Added `MACHINE_REGISTRATION_SECRET` so one-time machine enrollment is not a
  publicly callable token-minting endpoint.

## Blockers

- Phase 8 requires real Google OAuth credentials and an Ubuntu Desktop lab
  machine or VM with a display-manager login screen. This environment verified
  the production container, SSH password rotation, PAM tmpfs remount, local
  cleanup backstop, and server sweep, but cannot perform the physical login and
  mid-desktop-session kill checks.
