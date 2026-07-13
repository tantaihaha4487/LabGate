import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST } from "../app/api/cron/sweep/route";
import { db } from "../lib/db/client";

test("one authenticated sweep releases an expired credential on an unreachable machine", async () => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Backstop test ${suffix}`,
      tailscaleIp: "100.64.0.251",
      webhookToken: randomBytes(32).toString("base64url"),
      status: "occupied",
      lastHeartbeat: new Date(now.getTime() - 5 * 60 * 1000),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `backstop-${suffix}@ubu.ac.th`,
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });

  try {
    const unauthorized = await POST(
      new Request("http://localhost/api/cron/sweep", { method: "POST" }),
    );
    assert.equal(unauthorized.status, 401);

    const response = await POST(
      new Request("http://localhost/api/cron/sweep", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    assert.equal(response.status, 200);

    const result = (await response.json()) as {
      revokedCredentials: number;
      releasedMachines: number;
    };
    const released = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const revoked = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const audit = await db.auditLog.findFirst({
      where: { machineId: machine.id, event: "force_revoke" },
    });

    assert.ok(result.revokedCredentials >= 1);
    assert.ok(result.releasedMachines >= 1);
    assert.equal(released.status, "available");
    assert.ok(revoked.revokedAt);
    assert.ok(audit);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});
