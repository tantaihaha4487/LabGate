# Remove only the Pi application

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

This removes the running LabGate Compose application from the Pi only. It does
not erase enrolled endpoints, the repository, SQLite data, backups, secrets, or
machine-side policy. For a full retirement, use
[full decommissioning](uninstall.md).

Run on the Pi:

~~~sh
# Pi
cd ~/LabGate
./deploy/uninstall-pi.sh prepare --confirm
# Secure every physical endpoint with machine-setup/uninstall-machine.sh.
./deploy/uninstall-pi.sh finalize --confirm
~~~

The two phases are mandatory. <code>prepare</code> stops checkout traffic and leaves
Compose stopped. Secure every endpoint before <code>finalize</code>; the script then
runs <code>docker compose down</code> without <code>--volumes</code>. The repository, bind-mounted
data, provisioning key, and backups remain.

Inspect without changing the Pi:

~~~sh
# Pi
./deploy/uninstall-pi.sh prepare --dry-run
./deploy/uninstall-pi.sh finalize --dry-run
~~~

Retain or destroy data only under the institution's approved retention process.
For a later reinstall or a release rollback, preserve a verified backup and
follow [Pi installation](install-pi.md), [configuration](configuration.md), and
[deployment](deployment.md).
