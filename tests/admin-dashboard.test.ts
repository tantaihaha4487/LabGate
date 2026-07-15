import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { GET as getAdminMachines } from "../app/api/admin/machines/route";
import { PATCH as patchVisibility } from "../app/api/admin/machines/[machineId]/visibility/route";
import { checkoutMachine, CheckoutError } from "../lib/checkout";
import { db } from "../lib/db/client";
import { listPublicMachines } from "../lib/machines";

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

function adminRequest(
  url: string,
  token: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", sessionCookie(token));
  return new Request(url, { ...init, headers });
}

function visibilityContext(machineId: string) {
  return { params: Promise.resolve({ machineId }) };
}

test("admin APIs authorize independently and visibility changes preserve lifecycle state", async () => {
  const suffix = randomUUID();
  const adminEmail = "admin@ubu.ac.th";
  const nonAdminEmail = `student-admin-check-${suffix}@ubu.ac.th`;
  const adminUserId = `admin-user-${suffix}`;
  const nonAdminUserId = `non-admin-user-${suffix}`;
  const adminToken = randomBytes(32).toString("base64url");
  const nonAdminToken = randomBytes(32).toString("base64url");
  const activeWebhookToken = `secret-active-webhook-${suffix}`;
  const visibleWebhookToken = `secret-visible-webhook-${suffix}`;

  await db.user.createMany({
    data: [
      {
        id: adminUserId,
        name: "Configured Administrator",
        email: adminEmail,
        emailVerified: true,
      },
      {
        id: nonAdminUserId,
        name: "Institutional Non-admin",
        email: nonAdminEmail,
        emailVerified: true,
      },
    ],
  });
  await db.session.createMany({
    data: [
      {
        id: `admin-session-${suffix}`,
        token: adminToken,
        userId: adminUserId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
      {
        id: `non-admin-session-${suffix}`,
        token: nonAdminToken,
        userId: nonAdminUserId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    ],
  });

  const activeMachine = await db.machine.create({
    data: {
      name: `Admin active ${suffix}`,
      tailscaleIp: "100.127.250.1",
      sshHostKeySha256: sshFingerprint(`admin-active-${suffix}`),
      webhookToken: activeWebhookToken,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const availableMachine = await db.machine.create({
    data: {
      name: `Admin available ${suffix}`,
      tailscaleIp: "100.127.250.2",
      sshHostKeySha256: sshFingerprint(`admin-available-${suffix}`),
      webhookToken: visibleWebhookToken,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  const activeCredential = await db.guestCredential.create({
    data: {
      machineId: activeMachine.id,
      studentEmail: `reserved-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 60_000),
      sessionOpenedAt: new Date(Date.now() - 120_000),
      machineStateVersion: 2,
    },
  });

  try {
    const unauthenticated = await getAdminMachines(
      new Request("http://localhost/api/admin/machines"),
    );
    assert.equal(unauthenticated.status, 401);

    const forbidden = await getAdminMachines(
      adminRequest(
        "http://localhost/api/admin/machines",
        nonAdminToken,
      ),
    );
    assert.equal(forbidden.status, 403);

    const authorized = await getAdminMachines(
      adminRequest("http://localhost/api/admin/machines", adminToken),
    );
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get("cache-control") ?? "", /no-store/);
    const adminPayload = (await authorized.json()) as {
      serverTime: string;
      machines: Array<Record<string, unknown>>;
    };
    assert.ok(Number.isFinite(new Date(adminPayload.serverTime).getTime()));
    assert.equal(adminPayload.machines.length >= 2, true);
    const activeResponse = adminPayload.machines.find(
      (machine) => machine.id === activeMachine.id,
    );
    assert.ok(activeResponse);
    assert.equal(activeResponse.status, "occupied");
    assert.equal(activeResponse.connectivity, "online");
    assert.equal(activeResponse.isHidden, false);
    assert.deepEqual(
      (activeResponse.currentReservation as { studentEmail: string; state: string }),
      {
        id: activeCredential.id,
        studentEmail: activeCredential.studentEmail,
        state: "active",
        createdAt: activeCredential.createdAt.toISOString(),
        expiresAt: activeCredential.expiresAt.toISOString(),
        revokedAt: null,
        sessionOpenedAt: activeCredential.sessionOpenedAt?.toISOString() ?? null,
        machineStateVersion: 2,
      },
    );
    const serializedPayload = JSON.stringify(adminPayload);
    assert.equal(serializedPayload.includes(activeWebhookToken), false);
    assert.equal(serializedPayload.includes(visibleWebhookToken), false);
    assert.equal(serializedPayload.includes("webhookToken"), false);
    assert.equal(serializedPayload.includes("password"), false);

    const unauthenticatedPatch = await patchVisibility(
      new Request(
        `http://localhost/api/admin/machines/${activeMachine.id}/visibility`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: true }),
        },
      ),
      visibilityContext(activeMachine.id),
    );
    assert.equal(unauthenticatedPatch.status, 401);

    const forbiddenPatch = await patchVisibility(
      adminRequest(
        `http://localhost/api/admin/machines/${activeMachine.id}/visibility`,
        nonAdminToken,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: true }),
        },
      ),
      visibilityContext(activeMachine.id),
    );
    assert.equal(forbiddenPatch.status, 403);

    for (const hidden of [true, true, false, false]) {
      const response = await patchVisibility(
        adminRequest(
          `http://localhost/api/admin/machines/${activeMachine.id}/visibility`,
          adminToken,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hidden }),
          },
        ),
        visibilityContext(activeMachine.id),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        machineId: activeMachine.id,
        hidden,
      });
    }

    const preservedMachine = await db.machine.findUniqueOrThrow({
      where: { id: activeMachine.id },
    });
    const preservedCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: activeCredential.id },
    });
    assert.equal(preservedMachine.isHidden, false);
    assert.equal(preservedMachine.status, "occupied");
    assert.equal(preservedMachine.lastHeartbeat?.getTime(), activeMachine.lastHeartbeat?.getTime());
    assert.equal(preservedMachine.safetyHoldCredentialId, null);
    assert.equal(preservedCredential.revokedAt, null);
    assert.equal(preservedCredential.sessionOpenedAt?.getTime(), activeCredential.sessionOpenedAt?.getTime());
    assert.equal(preservedCredential.machineStateVersion, 2);
    assert.equal(
      await db.auditLog.count({
        where: { machineId: activeMachine.id, event: "machine_hide" },
      }),
      1,
    );
    assert.equal(
      await db.auditLog.count({
        where: { machineId: activeMachine.id, event: "machine_restore" },
      }),
      1,
    );
    const visibilityAudits = await db.auditLog.findMany({
      where: {
        machineId: activeMachine.id,
        event: { in: ["machine_hide", "machine_restore"] },
      },
      select: { studentEmail: true },
    });
    assert.deepEqual(
      visibilityAudits.map((audit) => audit.studentEmail),
      [adminEmail, adminEmail],
    );

    const hideAvailable = await patchVisibility(
      adminRequest(
        `http://localhost/api/admin/machines/${availableMachine.id}/visibility`,
        adminToken,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: true }),
        },
      ),
      visibilityContext(availableMachine.id),
    );
    assert.equal(hideAvailable.status, 200);
    assert.equal(
      (await listPublicMachines()).some(
        (machine) => machine.id === availableMachine.id,
      ),
      false,
    );

    let provisionCalls = 0;
    await assert.rejects(
      checkoutMachine({
        machineId: availableMachine.id,
        studentEmail: `checkout-hidden-${suffix}@ubu.ac.th`,
        provision: async () => {
          provisionCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 409,
    );
    assert.equal(provisionCalls, 0);

    const restoreAvailable = await patchVisibility(
      adminRequest(
        `http://localhost/api/admin/machines/${availableMachine.id}/visibility`,
        adminToken,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: false }),
        },
      ),
      visibilityContext(availableMachine.id),
    );
    assert.equal(restoreAvailable.status, 200);
    const restoredAvailable = await db.machine.findUniqueOrThrow({
      where: { id: availableMachine.id },
    });
    assert.equal(restoredAvailable.isHidden, false);
    assert.equal(restoredAvailable.status, "available");
    assert.equal(
      (await listPublicMachines()).some(
        (machine) => machine.id === availableMachine.id,
      ),
      true,
    );

    const unknown = `unknown-${suffix}`;
    const notFound = await patchVisibility(
      adminRequest(
        `http://localhost/api/admin/machines/${unknown}/visibility`,
        adminToken,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: true }),
        },
      ),
      visibilityContext(unknown),
    );
    assert.equal(notFound.status, 404);

    const invalidBody = await patchVisibility(
      adminRequest(
        `http://localhost/api/admin/machines/${availableMachine.id}/visibility`,
        adminToken,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: "yes" }),
        },
      ),
      visibilityContext(availableMachine.id),
    );
    assert.equal(invalidBody.status, 400);
  } finally {
    await db.auditLog.deleteMany({
      where: { machineId: { in: [activeMachine.id, availableMachine.id] } },
    });
    await db.guestCredential.deleteMany({
      where: { machineId: { in: [activeMachine.id, availableMachine.id] } },
    });
    await db.machine.deleteMany({
      where: { id: { in: [activeMachine.id, availableMachine.id] } },
    });
    await db.session.deleteMany({
      where: { userId: { in: [adminUserId, nonAdminUserId] } },
    });
    await db.user.deleteMany({
      where: { id: { in: [adminUserId, nonAdminUserId] } },
    });
  }
});
