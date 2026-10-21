# Local validation

This conversion is delivered locally. The JavaScript checkout and its existing changes are preserved. No production database, machine account, Google credentials, system service, or remote release was changed.

## Automated evidence

- Go tests with the race detector cover atomic concurrent checkout, compensation, expiry/open races, active-session lifetime, stale reports, safety holds, identity/rekey checks, activity cursor pagination, endpoint authorization, CSRF, pairing replay and revocation, and TUI navigation/confirmation/resizing.
- OIDC tests exercise actual signed fixture tokens through discovery, JWKS verification, token exchange, nonce, audience, expiry, verified-email, and institutional-domain checks. They do not use a live Google account.
- Migration tests exercise fresh and legacy SQLite copies, backups, timestamp normalization, dry-run preflight snapshots, running-writer refusal, and transaction rollback without partial schema/data changes.
- First and repeated server setup preserve key/secrets and create no database artifacts. Application and helper dependency graphs exclude the migration package. Actual application startup/check fail on an absent database without creating it.
- Browser tests exercise student checkout/one-time password/expiration, admin protection, theme switching, visibility cancellation/confirmation, enrollment, activity filters, browser-approved pairing, mobile navigation, and refresh failure recovery. Fixture authentication/provisioning routes are development-only and absent from release binaries.
- Root filesystem/lifecycle tests run in disposable Ubuntu 24.04, Debian 12/13, and Arch Linux containers. Cleanup/session simulations use a fake system-command runner to test framing, root permissions, symlink refusal, legacy state/tombstone/outbox compatibility, PAM context matching, fail-locked issuance, and active sessions past their login deadline. They do **not** prove real display-manager, logind, PAM, tmpfs, keyring, or device behavior.
- `go vet`, frontend TypeScript/build checks, and installer Bash syntax checks pass. Frontend lint reports only three Fast Refresh warnings in generated shadcn variant exports.
- Linux amd64 and arm64 release archives are built with embedded assets and no CGO dependency. arm64 is cross-built, not run on a Pi.

## Runtime evidence

The actual Go server starts against a database explicitly prepared by `labgate-migrate`, returns healthy status, and serves embedded web assets. The actual Bubble Tea binary opens its inventory, shows machine details, and logs out after fixture browser-approved CLI pairing. The web login/admin layouts were also visually inspected in Chromium.

## Required deployment acceptance

Before serving students, complete the physical checklist in [recovery.md](recovery.md): live institutional Google login, Raspberry Pi/systemd/reverse-proxy rollout, old enrolled-machine reports against a staging Go server, and real Debian/Ubuntu/Arch display-manager sessions with both home modes, crash recovery, ordered offline delivery, and external-state cleanup. Installer policy changes are syntax/inspection checked; no installer was run against this host.

Run `./scripts/check.sh` for repeatable local checks and `./scripts/build.sh` for both release bundles. Playwright needs its Chromium browser installed (`cd web && npx playwright install chromium`) on a new development computer.

## Debian and Arch compatibility

The machine installer now detects Debian and Raspberry Pi OS alongside Ubuntu and Arch derivatives. Debian uses `polkitd`, matching the Debian 12/13 repositories, rather than requiring the obsolete `policykit-1` transitional package. On apt-based systems, a missing NTP provider adds `systemd-timesyncd` while an installed chrony/ntp provider is preserved. SSH service selection checks actual unit load state (`ssh.service` on Debian/Ubuntu, `sshd.service` on Arch); fresh installations generate missing host keys before validating SSH.

Current Arch shadow tools omit `chage --mindays`. Helpers and installer glue detect that capability, accept empty or zero minimum age, and continue to verify every nonexpiring aging field. A remaining nonzero minimum age fails closed. No shadow file is edited directly.

`./scripts/check-platforms.sh` installs the actual distro prerequisite lists in disposable Debian 12, Debian 13, and Arch containers, exercises real `passwd`/`chpasswd`/`chage`/`getent` through Go issue/revoke, runs the lifecycle suite, previews the packaged machine installer, installs the admin client, and invokes the Go executables and explicit migration tool. These containers do not run a physical desktop or systemd as PID 1, so service/PAM/display-manager acceptance remains separate. The optional checks require Podman and network access and do not change the host package set.

References: [Debian polkitd](https://packages.debian.org/trixie/polkitd), [Arch maintenance guidance](https://wiki.archlinux.org/title/System_maintenance). The lab installer does not run `pacman -Sy` or silently upgrade the host; keep an Arch host fully updated before installing prerequisites. Only the disposable compatibility container runs a full update.
