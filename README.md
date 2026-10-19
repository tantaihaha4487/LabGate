# LabGate

Reserve shared physical lab desktops with university Google login. LabGate is a Go server with a shadcn/ui student and admin website, a Bubble Tea admin terminal, and Go helpers on each Debian, Ubuntu, or Arch-family desktop.

## Use it

Extract the release archive matching your Linux machine (`amd64` or `arm64`) and run:

```sh
./install.sh
```

Choose **Server**, **Admin client**, or **Lab machine**. The wizard handles configuration and installation. The server generates secrets and an Ed25519 provisioning key; Google client credentials still come from your university’s Google Cloud project.

For administration, run:

```sh
labgate
```

First run asks for the server address. Open the displayed pairing page, sign in as a configured administrator, and approve the code shown in your own terminal. The connection and session are saved privately. The admin website remains available at `/admin`.

Students open the server website, sign in with their institutional Google account, reserve a desktop, and type its one-time guest password at the physical keyboard.

## Uninstall

Run `sudo labgate uninstall`. It detects and displays whether this host is a **Server**, **Admin client**, or **Lab machine** from installed service/helper artifacts. The uninstall TUI shows the detected role and removal plan, then asks you to type `uninstall` to confirm. If both server and machine roles are present, select the target in the TUI. Use `--role server` or `--role machine` to select a target for noninteractive commands. Removal runs directly in Go. Preview the detected removal with `sudo labgate uninstall --dry-run`; use `--role server|client|machine --confirm` for noninteractive removal.

Server/client removal retains databases, accounts, configuration, keys, and saved client sessions. Machine removal requires a drained endpoint and retains its guest lock, accounts, SSH restrictions, safety helpers, and local state; PAM files are backed up before removing session hooks.

## Database preparation is separate

**Installation, setup, and server startup never create or upgrade database tables.** A missing or incompatible schema keeps the service stopped. The standalone `labgate-migrate` executable owns all schema changes.

On a newly installed server:

```sh
sudo -u labgate-server labgate-migrate
sudo systemctl enable --now labgate
```

For an existing installation, follow [migration and rollback](docs/migration.md). Stop both the old JavaScript service and any Go writers before migration. Existing identities, reservations, safety holds, and audit history are preserved; users sign in again after the conversion.

## Develop and build

Requirements: Go 1.27+, Node.js 22.12+ (build only), npm, and Linux. Production needs neither Node.js nor a Go toolchain.

```sh
./scripts/build.sh
```

This builds the embedded web UI, three local binaries in `bin/`, and self-contained amd64/arm64 release archives in `dist/`. Release archives contain their installer, machine configuration, and checksum manifest. They have not been published to a remote release service.

```sh
./scripts/check.sh
```

Runs Go tests with the race detector, `go vet`, frontend checks, browser flows, shell syntax checks, and the migration dependency boundary check. Browser tests use an isolated loopback fixture with fake Google sessions and provisioning; it is never included in releases.

Clean generated binaries, release archives, frontend output/caches, and test reports:

```sh
./scripts/clean.sh
```

Use `--dry-run` to preview or `--deps` to also remove `web/node_modules`. Source files, databases, secrets, and backups are retained. After cleaning, run `./scripts/build.sh` to rebuild; Go builds require the generated `web/dist` assets.

See [configuration](docs/configuration.md), [machine setup](docs/machines.md), and [recovery and acceptance](docs/recovery.md).

## Safety contract

One existing `guest` OS account serves each physical desktop. Issuing rotates its password; revoking locks the exact credential generation. Guest passwords are never persisted. A login deadline limits only the first login, never an active session. Ambiguous physical state remains occupied with a persistent safety hold until exact terminal evidence or a complete safe heartbeat resolves it.

Machine-side Go executables retain the historical `.sh` entrypoint names to preserve sudoers, forced-command SSH, PAM, and systemd compatibility. Installer glue remains Bash; uninstall runs in Go. Old enrolled machines can report to the Go backend before a drained helper upgrade.

Live university Google login, Raspberry Pi deployment, and physical display-manager/PAM acceptance remain release gates. See [validation evidence](docs/validation.md) for the boundary between automated checks and physical proof.
