import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST as credentialExpired } from "../app/api/webhook/credential-expired/route";
import { POST as heartbeat } from "../app/api/webhook/heartbeat/route";
import { POST as sessionClose } from "../app/api/webhook/session-close/route";
import { POST as sessionOpen } from "../app/api/webhook/session-open/route";
import { db } from "../lib/db/client";
import { listPublicMachines } from "../lib/machines";

test("machine webhooks authenticate, update status, and record session events", async () => {
  const suffix = randomUUID();
  const webhookToken = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Webhook test ${suffix}`,
      tailscaleIp: "100.64.0.252",
      webhookToken,
      status: "available",
      lastHeartbeat: new Date(Date.now() - 5 * 60 * 1000),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `webhook-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const request = (token: string) =>
    new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

  try {
    const beforeHeartbeat = await listPublicMachines();
    assert.equal(
      beforeHeartbeat.find((item) => item.id === machine.id)?.status,
      "offline",
    );

    assert.equal((await credentialExpired(request(webhookToken))).status, 409);
    assert.equal((await sessionOpen(request("wrong-token-value-that-is-long-enough"))).status, 401);
    assert.equal((await sessionOpen(request(webhookToken))).status, 200);

    const opened = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(opened.status, "occupied");

    assert.equal((await heartbeat(request(webhookToken))).status, 200);
    const afterHeartbeat = await listPublicMachines();
    assert.equal(
      afterHeartbeat.find((item) => item.id === machine.id)?.status,
      "occupied",
    );

    assert.equal((await sessionClose(request(webhookToken))).status, 200);
    const closed = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
    const revoked = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const events = await db.auditLog.findMany({
      where: { machineId: machine.id },
      orderBy: { createdAt: "asc" },
      select: { event: true },
    });

    assert.equal(closed.status, "available");
    assert.ok(revoked.revokedAt);
    assert.deepEqual(events, [
      { event: "session_open" },
      { event: "session_close" },
    ]);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("local expiry confirmation revokes the password metadata and releases the machine", async () => {
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
  const request = (token: string) =>
    new Request("http://localhost/api/webhook/credential-expired", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

  try {
    assert.equal((await heartbeat(request(webhookToken))).status, 200);
    const stillReserved = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(stillReserved.status, "occupied");

    assert.equal((await credentialExpired(request("invalid-token-that-is-long-enough-to-parse"))).status, 401);
    assert.equal((await credentialExpired(request(webhookToken))).status, 200);

    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const revoked = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const audit = await db.auditLog.findFirst({
      where: { machineId: machine.id, event: "force_revoke" },
    });

    assert.equal(released.status, "available");
    assert.ok(revoked.revokedAt);
    assert.match(audit?.detail ?? "", /Local cleanup timer locked/);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});
