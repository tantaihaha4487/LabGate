import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST } from "../app/api/cron/sweep/route";
import { sweepExpiredCredentials } from "../lib/backstop";
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

test("the sweep locks and releases an expired credential on a healthy machine", async () => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Recent activity ${suffix}`,
      tailscaleIp: "100.64.0.249",
      webhookToken: randomBytes(32).toString("base64url"),
      status: "occupied",
      lastHeartbeat: now,
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `recent-${suffix}@ubu.ac.th`,
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });
  let revokeCalls = 0;

  try {
    const result = await sweepExpiredCredentials(
      now,
      async (target) => {
        assert.equal(target.tailscaleIp, machine.tailscaleIp);
        revokeCalls += 1;
      },
    );

    const releasedMachine = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const revokedCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const audit = await db.auditLog.findFirst({
      where: { machineId: machine.id, event: "force_revoke" },
    });

    assert.equal(revokeCalls, 1);
    assert.equal(result.revokedCredentials, 1);
    assert.equal(result.releasedMachines, 1);
    assert.equal(result.pendingCredentials, 0);
    assert.equal(releasedMachine.status, "available");
    assert.ok(revokedCredential.revokedAt);
    assert.match(audit?.detail ?? "", /locked over SSH/);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("the sweep keeps a healthy machine occupied when its account cannot be locked", async (context) => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Lock retry ${suffix}`,
      tailscaleIp: "100.64.0.247",
      webhookToken: randomBytes(32).toString("base64url"),
      status: "occupied",
      lastHeartbeat: now,
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `retry-${suffix}@ubu.ac.th`,
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });
  context.mock.method(console, "error", () => undefined);

  try {
    const result = await sweepExpiredCredentials(now, async () => {
      throw new Error("Simulated SSH failure");
    });
    const occupiedMachine = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const pendingCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });

    assert.equal(result.revokedCredentials, 0);
    assert.equal(result.releasedMachines, 0);
    assert.equal(result.pendingCredentials, 1);
    assert.equal(occupiedMachine.status, "occupied");
    assert.equal(pendingCredential.revokedAt, null);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});
