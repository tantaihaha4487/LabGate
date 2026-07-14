import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST } from "../app/api/checkout/expire/route";
import { sweepExpiredCredentials } from "../lib/backstop";
import { db } from "../lib/db/client";

function sshFingerprint(seed: string): string {
  return `SHA256:${createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

function sessionCookie(token: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;

  assert.ok(secret);
  const signature = createHmac("sha256", secret)
    .update(token)
    .digest("base64");
  return `better-auth.session_token=${token}.${signature}`;
}

test("checkout expiry requires authentication and preserves an active physical session", async () => {
  const suffix = randomUUID();
  const userId = `expiry-user-${suffix}`;
  const token = randomBytes(32).toString("base64url");
  const machine = await db.machine.create({
    data: {
      name: `Active expiry route ${suffix}`,
      sshHostKeySha256: sshFingerprint(`active-expiry-${suffix}`),
      tailscaleIp: "100.64.0.235",
      webhookToken: `active-expiry-${suffix}`,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  await db.user.create({
    data: {
      id: userId,
      name: "Expiry Route Student",
      email: `expiry-route-${suffix}@ubu.ac.th`,
      emailVerified: true,
    },
  });
  await db.session.create({
    data: {
      id: `expiry-session-${suffix}`,
      token,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `expiry-route-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 60_000),
      sessionOpenedAt: new Date(Date.now() - 120_000),
      machineStateVersion: 2,
    },
  });

  try {
    const unauthorized = await POST(
      new Request("http://localhost/api/checkout/expire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId: machine.id }),
      }),
    );
    assert.equal(unauthorized.status, 401);

    const response = await POST(
      new Request("http://localhost/api/checkout/expire", {
        method: "POST",
        headers: {
          Cookie: sessionCookie(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ machineId: machine.id }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { status: string }).status,
      "active",
    );

    const preserved = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
      include: { machine: true },
    });
    assert.equal(preserved.revokedAt, null);
    assert.equal(preserved.machineStateVersion, 2);
    assert.equal(preserved.machine.status, "occupied");
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
    await db.session.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  }
});

test("checkout expiry reports a machine safety hold after the backstop already locked the password", async () => {
  const suffix = randomUUID();
  const userId = `held-expiry-user-${suffix}`;
  const token = randomBytes(32).toString("base64url");
  const physicalHoldId = `physical-generation-${suffix}`;
  const now = new Date();
  const studentEmail = `held-expiry-route-${suffix}@ubu.ac.th`;
  const machine = await db.machine.create({
    data: {
      name: `Held expiry route ${suffix}`,
      sshHostKeySha256: sshFingerprint(`held-expiry-${suffix}`),
      tailscaleIp: "100.64.0.234",
      webhookToken: `held-expiry-${suffix}`,
      status: "occupied",
      lastHeartbeat: now,
      safetyHoldCredentialId: physicalHoldId,
    },
  });
  await db.user.create({
    data: {
      id: userId,
      name: "Held Expiry Route Student",
      email: studentEmail,
      emailVerified: true,
    },
  });
  await db.session.create({
    data: {
      id: `held-expiry-session-${suffix}`,
      token,
      userId,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail,
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });

  try {
    const sweep = await sweepExpiredCredentials(now, async () => undefined);
    assert.ok(sweep.revokedCredentials >= 1);

    const response = await POST(
      new Request("http://localhost/api/checkout/expire", {
        method: "POST",
        headers: {
          Cookie: sessionCookie(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ machineId: machine.id }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { status: string }).status,
      "held",
    );

    const preserved = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const revoked = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    assert.equal(preserved.status, "occupied");
    assert.equal(preserved.safetyHoldCredentialId, physicalHoldId);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.machineStateVersion, 3);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
    await db.session.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  }
});
