import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST as credentialExpired } from "../app/api/webhook/credential-expired/route";
import { POST as heartbeat } from "../app/api/webhook/heartbeat/route";
import { POST as sessionClose } from "../app/api/webhook/session-close/route";
import { POST as sessionOpen } from "../app/api/webhook/session-open/route";
import { db } from "../lib/db/client";
import { listAdminActivity } from "../lib/admin-activity";
import { listPublicMachines } from "../lib/machines";

function sshFingerprint(seed: string): string {
  return `SHA256:${createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

function webhookRequest(
  token: string,
  body: Record<string, unknown>,
): Request {
  return new Request("http://localhost/api/webhook", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("machine webhooks activate and close one exact credential generation", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Webhook test ${suffix}`,
      sshHostKeySha256: sshFingerprint(`webhook-${suffix}`),
      tailscaleIp: "100.64.0.252",
      webhookToken,
      status: "available",
      lastHeartbeat: new Date(Date.now() - 5 * 60 * 1_000),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `webhook-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    },
  });

  try {
    const beforeHeartbeat = await listPublicMachines();
    const offlineMachine = beforeHeartbeat.find((item) => item.id === machine.id);
    assert.equal(offlineMachine?.status, "available");
    assert.equal(offlineMachine?.connectivity, "offline");

    assert.equal(
      (
        await sessionOpen(
          webhookRequest("wrong-token-value-that-is-long-enough", {
            credentialId: credential.id,
            stateVersion: 2,
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (await sessionOpen(webhookRequest(webhookToken, { credentialId: "bad" })))
        .status,
      400,
    );
    assert.equal(
      (
        await sessionOpen(
          webhookRequest(webhookToken, {
            credentialId: credential.id,
            stateVersion: 2,
          }),
        )
      ).status,
      200,
    );

    const opened = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
      include: { machine: true },
    });
    assert.equal(opened.machine.status, "occupied");
    assert.ok(opened.sessionOpenedAt);

    assert.equal(
      (
        await heartbeat(
          webhookRequest(webhookToken, {
            credentialId: credential.id,
            guestLocked: false,
            sessionActive: true,
            state: "active",
            stateVersion: 2,
          }),
        )
      ).status,
      200,
    );
    const afterHeartbeat = await listPublicMachines();
    const onlineMachine = afterHeartbeat.find((item) => item.id === machine.id);
    assert.equal(onlineMachine?.status, "occupied");
    assert.equal(onlineMachine?.connectivity, "online");

    assert.equal(
      (
        await sessionClose(
          webhookRequest(webhookToken, {
            credentialId: credential.id,
            stateVersion: 3,
          }),
        )
      ).status,
      200,
    );
    const closed = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
    const revoked = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const events = await db.auditLog.findMany({
      where: { machineId: machine.id },
      orderBy: { createdAt: "asc" },
      select: { event: true },
    });
    const activity = await listAdminActivity({
      source: "physical",
      action: "logout",
      email: credential.studentEmail,
    });

    assert.equal(closed.status, "available");
    assert.ok(revoked.revokedAt);
    assert.deepEqual(events, [
      { event: "session_open" },
      { event: "session_close" },
    ]);
    assert.equal(activity.entries.length, 1);
    assert.deepEqual(activity.entries[0], {
      id: activity.entries[0].id,
      source: "physical",
      action: "logout",
      status: "logged_out",
      email: credential.studentEmail,
      occurredAt: activity.entries[0].occurredAt,
      machine: { id: machine.id, name: machine.name },
    });
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("local expiry confirmation revokes only its locked generation", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Credential expiry ${suffix}`,
      tailscaleIp: "100.64.0.246",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `expired-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });

  try {
    assert.equal(
      (
        await credentialExpired(
          webhookRequest("invalid-token-that-is-long-enough-to-parse", {
            credentialId: credential.id,
            stateVersion: 3,
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await credentialExpired(
          webhookRequest(webhookToken, {
            credentialId: credential.id,
            stateVersion: 3,
          }),
        )
      ).status,
      200,
    );

    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const revoked = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const audit = await db.auditLog.findFirst({
      where: { machineId: machine.id, event: "force_revoke" },
    });
    const timeoutAudit = await db.auditLog.findFirst({
      where: { machineId: machine.id, event: "password_timeout" },
    });

    assert.equal(released.status, "available");
    assert.ok(revoked.revokedAt);
    assert.match(audit?.detail ?? "", /local cleanup timer/i);
    assert.equal(timeoutAudit?.studentEmail, credential.studentEmail);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("heartbeat repairs both a lost open webhook and a lost close webhook", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Heartbeat reconciliation ${suffix}`,
      tailscaleIp: "100.64.0.244",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `heartbeat-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });

  try {
    assert.equal(
      (
        await heartbeat(
          webhookRequest(webhookToken, {
            credentialId: credential.id,
            guestLocked: false,
            sessionActive: true,
            state: "active",
            stateVersion: 2,
          }),
        )
      ).status,
      200,
    );
    const activated = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    assert.ok(activated.sessionOpenedAt);
    assert.equal(activated.revokedAt, null);

    assert.equal(
      (
        await heartbeat(
          webhookRequest(webhookToken, {
            credentialId: credential.id,
            guestLocked: true,
            sessionActive: false,
            state: "revoked",
            stateVersion: 3,
          }),
        )
      ).status,
      200,
    );
    const reconciled = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
      include: { machine: true },
    });
    assert.ok(reconciled.revokedAt);
    assert.equal(reconciled.machine.status, "available");
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a delayed active report quarantines a terminal generation until exact close confirmation", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Reordered lifecycle ${suffix}`,
      tailscaleIp: "100.64.0.241",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `reordered-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      machineStateVersion: 1,
    },
  });

  try {
    const closeResponse = await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: credential.id,
        stateVersion: 3,
      }),
    );
    assert.equal(closeResponse.status, 200);

    const delayedOpenResponse = await sessionOpen(
      webhookRequest(webhookToken, {
        credentialId: credential.id,
        stateVersion: 2,
      }),
    );
    assert.equal(delayedOpenResponse.status, 200);
    assert.equal(
      ((await delayedOpenResponse.json()) as { status: string }).status,
      "stale",
    );

    const terminal = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
      include: { machine: true },
    });
    assert.ok(terminal.revokedAt);
    assert.equal(terminal.sessionOpenedAt, null);
    assert.equal(terminal.machineStateVersion, 3);
    assert.equal(terminal.machine.status, "occupied");
    assert.equal(terminal.machine.safetyHoldCredentialId, credential.id);

    const confirmedClose = await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: credential.id,
        stateVersion: 3,
      }),
    );
    assert.equal(confirmedClose.status, 200);

    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(released.status, "available");
    assert.equal(released.safetyHoldCredentialId, null);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a stale session-open terminalizes a conflicting current reservation", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Stale open conflict ${suffix}`,
      tailscaleIp: "100.64.0.213",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const staleCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `stale-open-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 120_000),
      revokedAt: new Date(Date.now() - 60_000),
      machineStateVersion: 3,
    },
  });
  const currentCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `current-open-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      machineStateVersion: 1,
    },
  });

  try {
    const response = await sessionOpen(
      webhookRequest(webhookToken, {
        credentialId: staleCredential.id,
        stateVersion: 2,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { status: string }).status,
      "stale",
    );

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const terminalized = await db.guestCredential.findUniqueOrThrow({
      where: { id: currentCredential.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(
      held.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );
    assert.equal(terminalized.machineStateVersion, 3);
    assert.ok(terminalized.revokedAt);

    await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: staleCredential.id,
        stateVersion: 3,
      }),
    );
    const afterReportedClose = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(afterReportedClose.status, "occupied");
    assert.equal(
      afterReportedClose.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("heartbeat rejects contradictory state and version combinations", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Invalid heartbeat ${suffix}`,
      tailscaleIp: "100.64.0.240",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `invalid-heartbeat-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  try {
    for (const report of [
      {
        credentialId: credential.id,
        guestLocked: false,
        sessionActive: true,
        state: "active",
        stateVersion: 3,
      },
      {
        credentialId: credential.id,
        guestLocked: false,
        sessionActive: true,
        state: "pending",
        stateVersion: 1,
      },
      {
        credentialId: credential.id,
        guestLocked: true,
        sessionActive: true,
        state: "active",
        stateVersion: 2,
      },
    ]) {
      assert.equal(
        (await heartbeat(webhookRequest(webhookToken, report))).status,
        400,
      );
    }
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("machine webhook bodies are rejected before buffering beyond their limit", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Bounded webhook ${suffix}`,
      tailscaleIp: "100.64.0.214",
      webhookToken,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });

  try {
    const response = await sessionOpen(
      webhookRequest(webhookToken, {
        credentialId: `oversize_${suffix.replaceAll("-", "")}`,
        stateVersion: 2,
        padding: "x".repeat(5_000),
      }),
    );
    assert.equal(response.status, 413);

    const unchanged = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(unchanged.status, "available");
    assert.equal(unchanged.safetyHoldCredentialId, null);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a stale close report cannot release a newer credential generation", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Stale close ${suffix}`,
      tailscaleIp: "100.64.0.243",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const staleCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `stale-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 120_000),
      revokedAt: new Date(Date.now() - 60_000),
    },
  });
  const currentCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `current-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  try {
    assert.equal(
      (
        await sessionClose(
          webhookRequest(webhookToken, {
            credentialId: staleCredential.id,
            stateVersion: 3,
          }),
        )
      ).status,
      200,
    );

    const current = await db.guestCredential.findUniqueOrThrow({
      where: { id: currentCredential.id },
      include: { machine: true },
    });
    assert.equal(current.revokedAt, null);
    assert.equal(current.machine.status, "occupied");
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a duplicate close cannot release an occupied unknown-generation quarantine", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Unknown generation quarantine ${suffix}`,
      tailscaleIp: "100.64.0.238",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(Date.now() - 60_000),
    },
  });
  const historicalCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `historical-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 120_000),
      revokedAt: new Date(Date.now() - 60_000),
      machineStateVersion: 3,
    },
  });

  try {
    const response = await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: historicalCredential.id,
        stateVersion: 3,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { status: string }).status,
      "already_closed",
    );

    const quarantined = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(quarantined.status, "occupied");
    assert.ok(quarantined.lastHeartbeat);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("an unknown active generation conflicting with a current reservation needs a fresh safe heartbeat", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const unknownCredentialId = `unknown_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Unknown active hold ${suffix}`,
      tailscaleIp: "100.64.0.226",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const knownCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `known-active-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      sessionOpenedAt: new Date(),
      machineStateVersion: 2,
    },
  });

  try {
    const unsafeActive = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: unknownCredentialId,
        guestLocked: false,
        sessionActive: true,
        state: "active",
        stateVersion: 2,
      }),
    );
    assert.equal(unsafeActive.status, 200);

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const terminalizedKnown = await db.guestCredential.findUniqueOrThrow({
      where: { id: knownCredential.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(
      held.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );
    assert.equal(terminalizedKnown.machineStateVersion, 3);
    assert.ok(terminalizedKnown.revokedAt);

    await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: knownCredential.id,
        stateVersion: 3,
      }),
    );
    const afterUnrelatedClose = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(afterUnrelatedClose.status, "occupied");
    assert.equal(
      afterUnrelatedClose.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );

    const exactTerminal = await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: unknownCredentialId,
        stateVersion: 3,
      }),
    );
    assert.equal(exactTerminal.status, 200);
    assert.equal(
      ((await exactTerminal.json()) as { status: string }).status,
      "not_found",
    );
    const afterQueuedTerminal = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(afterQueuedTerminal.status, "occupied");
    assert.equal(
      afterQueuedTerminal.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );

    const freshSafe = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: unknownCredentialId,
        guestLocked: true,
        sessionActive: false,
        state: "revoked",
        stateVersion: 3,
      }),
    );
    assert.equal(freshSafe.status, 200);
    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(released.status, "available");
    assert.equal(released.safetyHoldCredentialId, null);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("valid unknown outbox events are acknowledged so an exact terminal event can clear the hold", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const unknownCredentialId = `queued_${suffix.replaceAll("-", "")}`;
  const unrelatedCredentialId = `unrelated_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Ordered unknown outbox ${suffix}`,
      tailscaleIp: "100.64.0.223",
      webhookToken,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });

  try {
    const open = await sessionOpen(
      webhookRequest(webhookToken, {
        credentialId: unknownCredentialId,
        stateVersion: 2,
      }),
    );
    assert.equal(open.status, 200);
    assert.equal(
      ((await open.json()) as { status: string }).status,
      "not_found",
    );

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(held.safetyHoldCredentialId, unknownCredentialId);

    for (const terminalRoute of [sessionClose, credentialExpired]) {
      const unrelated = await terminalRoute(
        webhookRequest(webhookToken, {
          credentialId: unrelatedCredentialId,
          stateVersion: 3,
        }),
      );
      assert.equal(unrelated.status, 200);
      assert.equal(
        ((await unrelated.json()) as { status: string }).status,
        "not_found",
      );
    }

    const stillHeld = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(stillHeld.status, "occupied");
    assert.equal(stillHeld.safetyHoldCredentialId, unknownCredentialId);

    const exactClose = await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: unknownCredentialId,
        stateVersion: 3,
      }),
    );
    assert.equal(exactClose.status, 200);
    assert.equal(
      ((await exactClose.json()) as { status: string }).status,
      "closed",
    );

    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(released.status, "available");
    assert.equal(released.safetyHoldCredentialId, null);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a fresh active heartbeat for a terminal credential creates a safety hold", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Terminal active heartbeat ${suffix}`,
      tailscaleIp: "100.64.0.225",
      webhookToken,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  const terminalCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `terminal-active-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 120_000),
      revokedAt: new Date(Date.now() - 60_000),
      machineStateVersion: 3,
    },
  });

  try {
    const response = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: terminalCredential.id,
        guestLocked: false,
        sessionActive: true,
        state: "active",
        stateVersion: 2,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { status: string }).status,
      "stale",
    );

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(held.safetyHoldCredentialId, terminalCredential.id);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("an unsafe pending generation cannot be released by another credential close", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const unknownCredentialId = `pending_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Unknown pending hold ${suffix}`,
      tailscaleIp: "100.64.0.224",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const knownCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `known-pending-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      machineStateVersion: 1,
    },
  });

  try {
    const response = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: unknownCredentialId,
        guestLocked: false,
        sessionActive: false,
        state: "pending",
        stateVersion: 1,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { status: string }).status,
      "unsafe_pending",
    );

    await sessionClose(
      webhookRequest(webhookToken, {
        credentialId: knownCredential.id,
        stateVersion: 3,
      }),
    );
    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(
      held.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );
    assert.equal(
      (
        await db.guestCredential.findUniqueOrThrow({
          where: { id: knownCredential.id },
        })
      ).machineStateVersion,
      3,
    );
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("contradictory physical generations require a fresh safe heartbeat", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const firstReportedId = `first_${suffix.replaceAll("-", "")}`;
  const secondReportedId = `second_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Conflicting holds ${suffix}`,
      tailscaleIp: "100.64.0.212",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
      safetyHoldCredentialId: firstReportedId,
    },
  });

  try {
    const conflicting = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: secondReportedId,
        guestLocked: false,
        sessionActive: false,
        state: "pending",
        stateVersion: 1,
      }),
    );
    assert.equal(conflicting.status, 200);

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(
      held.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );
    assert.equal(held.status, "occupied");

    for (const credentialId of [firstReportedId, secondReportedId]) {
      const queuedClose = await sessionClose(
        webhookRequest(webhookToken, { credentialId, stateVersion: 3 }),
      );
      assert.equal(queuedClose.status, 200);
      const stillHeld = await db.machine.findUniqueOrThrow({
        where: { id: machine.id },
      });
      assert.equal(stillHeld.status, "occupied");
      assert.equal(
        stillHeld.safetyHoldCredentialId,
        "!conflicting-physical-generations!",
      );
    }

    const freshSafe = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: secondReportedId,
        guestLocked: true,
        sessionActive: false,
        state: "revoked",
        stateVersion: 3,
      }),
    );
    assert.equal(freshSafe.status, 200);

    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(released.status, "available");
    assert.equal(released.safetyHoldCredentialId, null);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a matching active heartbeat cannot erase a different generation hold", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const otherReportedId = `other_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Matching heartbeat conflict ${suffix}`,
      tailscaleIp: "100.64.0.211",
      webhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
      safetyHoldCredentialId: otherReportedId,
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `matching-heartbeat-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      sessionOpenedAt: new Date(),
      machineStateVersion: 2,
    },
  });

  try {
    const response = await heartbeat(
      webhookRequest(webhookToken, {
        credentialId: credential.id,
        guestLocked: false,
        sessionActive: true,
        state: "active",
        stateVersion: 2,
      }),
    );
    assert.equal(response.status, 200);

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(
      held.safetyHoldCredentialId,
      "!conflicting-physical-generations!",
    );
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a webhook token rotated after body read begins cannot mutate lifecycle state", async () => {
  const suffix = randomUUID();
  const oldToken = randomBytes(32).toString("base64url");
  const replacementToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Webhook rekey fence ${suffix}`,
      tailscaleIp: "100.64.0.210",
      webhookToken: oldToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `webhook-fence-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      machineStateVersion: 1,
    },
  });

  let bodyReadStartedResolve: (() => void) | undefined;
  let releaseBodyResolve: (() => void) | undefined;
  const bodyReadStarted = new Promise<void>((resolve) => {
    bodyReadStartedResolve = resolve;
  });
  const releaseBody = new Promise<void>((resolve) => {
    releaseBodyResolve = resolve;
  });
  const request = webhookRequest(oldToken, {
    credentialId: credential.id,
    stateVersion: 2,
  });
  const body = JSON.stringify({
    credentialId: credential.id,
    stateVersion: 2,
  });
  let controlledBody: ReadableStream<Uint8Array> | undefined;
  Object.defineProperty(request, "body", {
    get: () => {
      bodyReadStartedResolve?.();
      controlledBody ??= new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          await releaseBody;
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return controlledBody;
    },
  });

  try {
    const pendingResponse = sessionOpen(request);
    await bodyReadStarted;
    await db.machine.update({
      where: { id: machine.id },
      data: { webhookToken: replacementToken },
    });
    releaseBodyResolve?.();

    const response = await pendingResponse;
    assert.equal(response.status, 401);
    const unchanged = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    assert.equal(unchanged.machineStateVersion, 1);
    assert.equal(unchanged.sessionOpenedAt, null);
    assert.equal(unchanged.revokedAt, null);
  } finally {
    releaseBodyResolve?.();
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});
