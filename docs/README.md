# LabGate documentation

Short operator guides for the Pi application and the physical lab machines.
Follow the path for a new installation, or jump directly to the procedure for
the current maintenance task.

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

## Operator path

1. [Install the Raspberry Pi](install-pi.md) — host, Docker Compose, Tailscale,
   and the provisioning key.
2. [Configure the application](configuration.md) — OAuth, HTTPS, environment
   variables, protected secrets, and the recovery sweep.
3. [Install a lab machine](install-lab-machine.md) — Ubuntu or Arch-family
   prerequisites, setup, enrollment, and safe updates.
4. [Deploy a release](deployment.md) — backup, migration, health checks, and
   rollback.
5. [Recover and accept](recovery.md) — lifecycle evidence, local safety checks,
   troubleshooting, and physical release gates.
6. [Decommission the deployment](uninstall.md) — the required staged full
   removal.
7. [Remove only the Pi application](pi-uninstall.md) — preserve data and
   endpoint policy.

## Project references

- [Project contract](../AGENTS.md)
- [Build prompt](../BUILD_PROMPT.md)
- [Progress tracker](../PROGRESS.md)
- [Configuration template](../.env.example)

[Project README](../README.md)
