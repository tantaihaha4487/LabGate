import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
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
