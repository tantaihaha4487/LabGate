# LabGate

LabGate lets students sign in with an <code>@ubu.ac.th</code> Google account, reserve a
shared physical Ubuntu or Arch-family desktop, and receive a temporary password
for that machine's existing <code>guest</code> account. The password is typed at the
physical keyboard. LabGate is not remote-desktop software.

The web app returns a generated password once and never stores it. Checkout
rotates the one shared account's password; it never creates or deletes student
Linux accounts. Read [AGENTS.md](AGENTS.md) before changing that contract.

> [!IMPORTANT]
> Physical end-to-end checks are a release gate. Review [PROGRESS.md](PROGRESS.md)
> and complete [recovery and acceptance](docs/recovery.md) before putting a
> machine into service.

## Start here

Follow the operator path:

1. [Install the Raspberry Pi](docs/install-pi.md)
2. [Configure OAuth, HTTPS, secrets, and cron](docs/configuration.md)
3. [Install and enroll a physical lab machine](docs/install-lab-machine.md)
4. [Deploy a reviewed release](docs/deployment.md)
5. [Recover and accept machines](docs/recovery.md)
6. [Decommission everything](docs/uninstall.md)

For a Pi-only removal, use [Pi uninstall](docs/pi-uninstall.md).

## Lifecycle

<code>CREDENTIAL_TTL_HOURS</code> is only the deadline for entering a new password at the
physical login screen. It does not limit an active desktop session.

There is no maximum duration for an active session unless you specify one.

| State | Version | Meaning |
| --- | ---: | --- |
| <code>pending</code> | 1 | Password issued; no physical PAM session yet. |
| <code>active</code> | 2 | PAM opened a fresh tmpfs home; the machine remains occupied. |
| <code>revoked</code> | 3 | The exact generation is locked and local cleanup completed. |

The server releases a machine only after an exact generation-3 report or a
genuinely safe locked, session-free heartbeat. A missed heartbeat, expired
pending credential, or unreachable host is not proof of safety. Ambiguous
physical state becomes a persistent <code>safety_hold_credential_id</code> quarantine.

## Architecture

~~~text
Student browser --HTTPS--> Raspberry Pi 5 --Tailscale SSH--> physical desktop
                              ^                         |
                              +---- versioned webhooks-+
~~~

The Pi runs Next.js, Better Auth, SQLite/Prisma, and Docker Compose. Machines
run PAM and systemd lifecycle hooks locally. The <code>provisioner</code> SSH identity is a
forced-command transport, not a shell; <code>guest</code> cannot use SSH. PAM never makes a
network call: it completes local safety work, then queues a versioned event in a
root-controlled outbox. A systemd path unit wakes the separate delivery worker
immediately, while a 10-second timer remains the retry backstop.

## Development

Requirements: Node.js 22+, npm, and SQLite-compatible Prisma dependencies.

~~~sh
npm install
cp .env.example .env.local
npx prisma generate
npx prisma migrate dev
npm run dev
~~~

Before a release:

~~~sh
git diff --check
npm test
npm run lint
npm run typecheck
npm run build
~~~

Keep <code>.env.local</code>, <code>data/</code>, and provisioning keys out of source control. Use
the [documentation hub](docs/README.md) for operator procedures, and treat
[PROGRESS.md](PROGRESS.md) as the acceptance tracker.

## Project references

- [AGENTS.md](AGENTS.md) — binding architecture and security invariants
- [BUILD_PROMPT.md](BUILD_PROMPT.md) — phased implementation and evidence gates
- [PROGRESS.md](PROGRESS.md) — current completion and acceptance status
- [.env.example](.env.example) — configuration template
- [machine-setup/](machine-setup/) — physical endpoint installer and lifecycle units
