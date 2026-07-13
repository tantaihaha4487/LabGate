import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CheckoutError, checkoutMachine } from "../lib/checkout";
import { db } from "../lib/db/client";

test("checkout defaults to a three-minute credential lifetime", async () => {
  const previousTtl = process.env.CREDENTIAL_TTL_HOURS;
  const suffix = randomUUID();
  const now = new Date("2026-07-13T12:00:00.000Z");
  const machine = await db.machine.create({
    data: {
      name: `Default TTL ${suffix}`,
      tailscaleIp: "100.64.0.248",
      webhookToken: `test-${suffix}`,
      status: "available",
      lastHeartbeat: now,
    },
  });

  delete process.env.CREDENTIAL_TTL_HOURS;

  try {
    const credential = await checkoutMachine({
      machineId: machine.id,
      studentEmail: `ttl-${suffix}@ubu.ac.th`,
      provision: async () => undefined,
      now,
    });

    assert.equal(
      new Date(credential.expiresAt).getTime(),
      now.getTime() + 3 * 60 * 1000,
    );
  } finally {
    if (previousTtl === undefined) {
      delete process.env.CREDENTIAL_TTL_HOURS;
    } else {
      process.env.CREDENTIAL_TTL_HOURS = previousTtl;
    }
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("concurrent checkout claims produce one credential and one conflict", async () => {
  const suffix = randomUUID();
  const studentEmail = `concurrency-${suffix}@ubu.ac.th`;
  const machine = await db.machine.create({
    data: {
      name: `Concurrency test ${suffix}`,
      tailscaleIp: "100.64.0.250",
      webhookToken: `test-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  const provision = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  };

  try {
    const results = await Promise.allSettled([
      checkoutMachine({ machineId: machine.id, studentEmail, provision }),
      checkoutMachine({ machineId: machine.id, studentEmail, provision }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const rejection = rejected[0];
    assert.equal(rejection.status, "rejected");
    assert.ok(rejection.reason instanceof CheckoutError);
    assert.equal(rejection.reason.status, 409);

    const rows = await db.guestCredential.findMany({
      where: { machineId: machine.id, revokedAt: null },
    });
    assert.equal(rows.length, 1);
    assert.equal(Object.hasOwn(rows[0], "password"), false);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("failed provisioning revokes the credential and releases the machine", async () => {
  const suffix = randomUUID();
  const studentEmail = `rollback-${suffix}@ubu.ac.th`;
  const machine = await db.machine.create({
    data: {
      name: `Rollback test ${suffix}`,
      tailscaleIp: "100.64.0.251",
      webhookToken: `test-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail,
        provision: async () => {
          throw new Error("Simulated SSH failure");
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 502,
    );

    const releasedMachine = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const credential = await db.guestCredential.findFirstOrThrow({
      where: { machineId: machine.id },
    });

    assert.equal(releasedMachine.status, "available");
    assert.ok(credential.revokedAt);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});
