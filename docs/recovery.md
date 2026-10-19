# Recovery and physical acceptance

A healthy HTTP endpoint proves only server readiness. It does not prove that a guest password works, PAM cleanup succeeds, or a machine is physically safe.

Keep ambiguous machines occupied. Inspect the root-only credential state, recovery marker, PAM owner marker, outbox, systemd unit status, and SSH host-key identity without printing passwords or bearer tokens. Do not delete state/outbox files, reset sequence counters, clear safety holds, or advertise an unreachable machine as available.

Machine recovery must confirm account lock, guest process termination, external-state cleanup, and guest-home unmount/sealing. Local cleanup remains mandatory even during API/network outages. An active physical session is never expired simply because its original password deadline has passed.

## Physical acceptance

Perform these checks on disposable desktops/VMs using the actual supported display manager before a live rollout:

- Institutional Google login works; non-institutional and non-admin accounts cannot use restricted operations.
- A freshly enrolled machine remains offline until a locked, session-free safe heartbeat.
- Checkout wins exactly once, rotates the existing guest account’s password, and lets the student log in at the physical keyboard.
- An unused password stops working after its first-login deadline; account lock and cleanup precede server release.
- An active desktop remains occupied after that deadline and is cleaned up when its matching PAM session closes.
- A concurrent failed PAM open/close cannot terminate a different transaction’s session.
- Both home modes enforce the documented runtime/IPC/keyring/mailbox/scratch cleanup, guest linger removal, sudo denial, account-change denial, and Polkit restrictions.
- A reboot locks and cleans guest before display-manager/SSH login availability.
- During a webhook outage, PAM still secures locally. Events persist, then drain in sequence after connectivity returns, including acknowledged unknown/conflicting reports.
- Hide/restore changes visibility without changing reservation or safety state. Drained rekey cannot bypass active reservations/holds.
- Native helper upgrades preserve old state, pins, tokens, and outbox contents. Failed validation keeps the endpoint out of service.

If Google login fails after a proxy/Funnel redirect, check provider DNS and HTTPS from the actual service/container context. A reachable public origin does not prove the Google token exchange succeeds.
