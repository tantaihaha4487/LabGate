import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { POST as sessionClose } from "../app/api/webhook/session-close/route";
import { sweepExpiredCredentials } from "../lib/backstop";
import { CheckoutError, checkoutMachine } from "../lib/checkout";
import { db } from "../lib/db/client";
import { listPublicMachines } from "../lib/machines";

function sshFingerprint(seed: string): string {
  return `SHA256:${createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

function webhookRequest(token: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/webhook/session-close", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("checkout defaults to a three-minute credential lifetime", async () => {
  const previousTtl = process.env.CREDENTIAL_TTL_HOURS;
  const suffix = randomUUID();
  const now = new Date("2026-07-13T12:00:00.000Z");
  const machine = await db.machine.create({
    data: {
      name: `Default TTL ${suffix}`,
      sshHostKeySha256: sshFingerprint(`default-ttl-${suffix}`),
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
      provision: async (_target, issued) => {
        assert.equal(issued.password.length, 8);
        assert.equal(issued.expiresAt.getTime(), now.getTime() + 3 * 60 * 1_000);
      },
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
      sshHostKeySha256: sshFingerprint(`concurrency-${suffix}`),
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

test("an unpinned machine is hidden from availability and cannot be claimed", async () => {
  const suffix = randomUUID();
  const machine = await db.machine.create({
    data: {
      name: `Unpinned checkout ${suffix}`,
      tailscaleIp: "100.64.0.221",
      webhookToken: `unpinned-checkout-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  let provisionCalls = 0;

  try {
    const listed = (await listPublicMachines()).find(
      (candidate) => candidate.id === machine.id,
    );
    assert.equal(listed?.status, "occupied");
    assert.equal(listed?.connectivity, "online");

    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail: `unpinned-${suffix}@ubu.ac.th`,
        provision: async () => {
          provisionCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 409,
    );
    assert.equal(provisionCalls, 0);
    assert.equal(
      await db.guestCredential.count({ where: { machineId: machine.id } }),
      0,
    );
  } finally {
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("a far-future heartbeat is offline and cannot be claimed", async () => {
  const suffix = randomUUID();
  const now = new Date("2026-07-13T12:00:00.000Z");
  const machine = await db.machine.create({
    data: {
      name: `Future heartbeat ${suffix}`,
      sshHostKeySha256: sshFingerprint(`future-heartbeat-${suffix}`),
      tailscaleIp: "100.64.0.209",
      webhookToken: `future-heartbeat-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(now.getTime() + 60 * 60 * 1_000),
    },
  });
  let provisionCalls = 0;

  try {
    const listed = (await listPublicMachines(now)).find(
      (candidate) => candidate.id === machine.id,
    );
    assert.equal(listed?.connectivity, "offline");

    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail: `future-heartbeat-${suffix}@ubu.ac.th`,
        now,
        provision: async () => {
          provisionCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 409,
    );
    assert.equal(provisionCalls, 0);
    assert.equal(
      await db.guestCredential.count({ where: { machineId: machine.id } }),
      0,
    );
  } finally {
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("failed provisioning revokes the credential and releases the machine", async () => {
  const suffix = randomUUID();
  const studentEmail = `rollback-${suffix}@ubu.ac.th`;
  const machine = await db.machine.create({
    data: {
      name: `Rollback test ${suffix}`,
      sshHostKeySha256: sshFingerprint(`rollback-${suffix}`),
      tailscaleIp: "100.64.0.251",
      webhookToken: `test-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  let issuedPassword = "";

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail,
        provision: async (_target, issued) => {
          issuedPassword = issued.password;
          throw new Error(
            `sudo rejected guest-account issue command containing ${issued.password}`,
          );
        },
        revoke: async (_target, credentialId) => {
          assert.match(credentialId, /^[A-Za-z0-9_-]{20,64}$/);
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
    const audit = await db.auditLog.findFirstOrThrow({
      where: { machineId: machine.id, event: "provision_fail" },
    });

    assert.equal(releasedMachine.status, "available");
    assert.ok(credential.revokedAt);
    assert.equal(credential.machineStateVersion, 3);
    assert.equal(issuedPassword.length, 8);
    assert.doesNotMatch(audit.detail ?? "", new RegExp(issuedPassword));
    assert.match(audit.detail ?? "", /\[REDACTED\]/);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("ambiguous provisioning failure stays occupied until its generation is locked", async (context) => {
  const suffix = randomUUID();
  const machine = await db.machine.create({
    data: {
      name: `Ambiguous rollback ${suffix}`,
      sshHostKeySha256: sshFingerprint(`ambiguous-${suffix}`),
      tailscaleIp: "100.64.0.245",
      webhookToken: `test-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  context.mock.method(console, "error", () => undefined);

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail: `ambiguous-${suffix}@ubu.ac.th`,
        provision: async () => {
          throw new Error("SSH command result was ambiguous");
        },
        revoke: async () => {
          throw new Error("Compensating SSH lock was unreachable");
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 502,
    );

    const heldMachine = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const pendingCredential = await db.guestCredential.findFirstOrThrow({
      where: { machineId: machine.id },
    });

    assert.equal(heldMachine.status, "occupied");
    assert.equal(
      heldMachine.safetyHoldCredentialId,
      pendingCredential.id,
    );
    assert.equal(pendingCredential.revokedAt, null);
    assert.ok(pendingCredential.expiresAt.getTime() <= Date.now());
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("ambiguous compensation preserves a different physical generation hold", async () => {
  const suffix = randomUUID();
  const physicalHoldId = `physical_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Ambiguous physical race ${suffix}`,
      sshHostKeySha256: sshFingerprint(`ambiguous-race-${suffix}`),
      tailscaleIp: "100.64.0.223",
      webhookToken: `ambiguous-race-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail: `ambiguous-race-${suffix}@ubu.ac.th`,
        provision: async () => {
          await db.machine.update({
            where: { id: machine.id },
            data: {
              status: "occupied",
              safetyHoldCredentialId: physicalHoldId,
            },
          });
          throw new Error("Issue outcome became ambiguous after heartbeat");
        },
        revoke: async () => {
          throw new Error("Compensating lock was unreachable");
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 502,
    );

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(held.status, "occupied");
    assert.equal(held.safetyHoldCredentialId, physicalHoldId);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { machineId: machine.id, event: "provision_fail" },
    });
    assert.match(audit.detail ?? "", /different physical generation/i);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("checkout never discloses a password after its pending generation loses the machine CAS", async () => {
  const suffix = randomUUID();
  const physicalHoldId = `physical_${suffix.replaceAll("-", "")}`;
  const machine = await db.machine.create({
    data: {
      name: `Post-issue CAS ${suffix}`,
      sshHostKeySha256: sshFingerprint(`post-issue-${suffix}`),
      tailscaleIp: "100.64.0.222",
      webhookToken: `post-issue-cas-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  let issuedCredentialId = "";
  let compensationAttempts = 0;

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail: `post-issue-cas-${suffix}@ubu.ac.th`,
        provision: async (_target, issued) => {
          issuedCredentialId = issued.credentialId;
          await db.guestCredential.updateMany({
            where: { machineId: machine.id, revokedAt: null },
            data: { revokedAt: new Date(), machineStateVersion: 3 },
          });
          await db.machine.update({
            where: { id: machine.id },
            data: {
              status: "occupied",
              safetyHoldCredentialId: physicalHoldId,
            },
          });
        },
        revoke: async (_target, credentialId) => {
          compensationAttempts += 1;
          assert.equal(credentialId, issuedCredentialId);
          throw new Error("Simulated ambiguous compensating lock");
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 502,
    );

    assert.equal(compensationAttempts, 1);
    const retryCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: issuedCredentialId },
      include: { machine: true },
    });
    assert.equal(retryCredential.revokedAt, null);
    assert.equal(retryCredential.machineStateVersion, 1);
    assert.ok(retryCredential.expiresAt.getTime() <= Date.now());
    assert.equal(retryCredential.machine.status, "occupied");
    assert.equal(
      retryCredential.machine.safetyHoldCredentialId,
      physicalHoldId,
    );

    const physicalClose = await sessionClose(
      webhookRequest(machine.webhookToken, {
        credentialId: physicalHoldId,
        stateVersion: 3,
      }),
    );
    assert.equal(physicalClose.status, 200);
    const afterPhysicalClose = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(afterPhysicalClose.status, "occupied");
    assert.equal(afterPhysicalClose.safetyHoldCredentialId, null);

    const swept = await sweepExpiredCredentials(new Date(), async () => undefined);
    assert.ok(swept.revokedCredentials >= 1);
    const safelyReleased = await db.guestCredential.findUniqueOrThrow({
      where: { id: issuedCredentialId },
      include: { machine: true },
    });
    assert.ok(safelyReleased.revokedAt);
    assert.equal(safelyReleased.machine.status, "available");
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("old-target issue compensation cannot mutate a concurrently rekeyed machine", async () => {
  const suffix = randomUUID();
  const originalPin = sshFingerprint(`rekey-compensation-old-${suffix}`);
  const replacementPin = sshFingerprint(`rekey-compensation-new-${suffix}`);
  const originalIp = "100.64.0.208";
  const replacementIp = "100.64.0.207";
  const machine = await db.machine.create({
    data: {
      name: `Rekey compensation ${suffix}`,
      sshHostKeySha256: originalPin,
      tailscaleIp: originalIp,
      webhookToken: `rekey-compensation-old-${suffix}`,
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
  let issuedCredentialId = "";
  let revokeCalls = 0;

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machine.id,
        studentEmail: `rekey-compensation-${suffix}@ubu.ac.th`,
        provision: async (target, issued) => {
          assert.equal(target.tailscaleIp, originalIp);
          assert.equal(target.sshHostKeySha256, originalPin);
          issuedCredentialId = issued.credentialId;
          await db.$transaction([
            db.guestCredential.update({
              where: { id: issued.credentialId },
              data: { revokedAt: new Date(), machineStateVersion: 3 },
            }),
            db.machine.update({
              where: { id: machine.id },
              data: {
                sshHostKeySha256: replacementPin,
                tailscaleIp: replacementIp,
                webhookToken: `rekey-compensation-new-${suffix}`,
                status: "offline",
                lastHeartbeat: null,
              },
            }),
          ]);
        },
        revoke: async (target, credentialId) => {
          revokeCalls += 1;
          assert.equal(target.tailscaleIp, originalIp);
          assert.equal(target.sshHostKeySha256, originalPin);
          assert.equal(credentialId, issuedCredentialId);
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 502,
    );

    assert.equal(revokeCalls, 1);
    const replacement = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const oldCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: issuedCredentialId },
    });
    assert.equal(replacement.tailscaleIp, replacementIp);
    assert.equal(replacement.sshHostKeySha256, replacementPin);
    assert.equal(replacement.status, "offline");
    assert.equal(replacement.lastHeartbeat, null);
    assert.equal(replacement.safetyHoldCredentialId, null);
    assert.ok(oldCredential.revokedAt);
    assert.equal(oldCredential.machineStateVersion, 3);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("one student cannot concurrently reserve two different machines", async () => {
  const suffix = randomUUID();
  const studentEmail = `student-race-${suffix}@ubu.ac.th`;
  const machines = await Promise.all(
    ["A", "B"].map((label, index) =>
      db.machine.create({
        data: {
          name: `Student race ${label} ${suffix}`,
          sshHostKeySha256: sshFingerprint(`student-race-${label}-${suffix}`),
          tailscaleIp: `100.64.0.${240 + index}`,
          webhookToken: `student-race-${label}-${suffix}`,
          status: "available",
          lastHeartbeat: new Date(),
        },
      }),
    ),
  );

  try {
    const results = await Promise.allSettled(
      machines.map((machine) =>
        checkoutMachine({
          machineId: machine.id,
          studentEmail,
          provision: async () => undefined,
        }),
      ),
    );

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejection = results.find((result) => result.status === "rejected");
    assert.equal(rejection?.status, "rejected");
    assert.ok(rejection.reason instanceof CheckoutError);
    assert.equal(rejection.reason.status, 409);
    assert.equal(
      await db.guestCredential.count({
        where: { studentEmail, revokedAt: null },
      }),
      1,
    );
  } finally {
    const machineIds = machines.map((machine) => machine.id);
    await db.auditLog.deleteMany({ where: { machineId: { in: machineIds } } });
    await db.guestCredential.deleteMany({
      where: { machineId: { in: machineIds } },
    });
    await db.machine.deleteMany({ where: { id: { in: machineIds } } });
  }
});

test("expired credentials still block another checkout until lock confirmation", async () => {
  const suffix = randomUUID();
  const studentEmail = `lock-pending-${suffix}@ubu.ac.th`;
  const machines = await Promise.all(
    ["held", "target"].map((label, index) =>
      db.machine.create({
        data: {
          name: `Lock pending ${label} ${suffix}`,
          sshHostKeySha256: sshFingerprint(`lock-pending-${label}-${suffix}`),
          tailscaleIp: `100.64.0.${238 + index}`,
          webhookToken: `lock-pending-${label}-${suffix}`,
          status: label === "held" ? "occupied" : "available",
          lastHeartbeat: new Date(),
        },
      }),
    ),
  );
  await db.guestCredential.create({
    data: {
      machineId: machines[0].id,
      studentEmail,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });

  try {
    await assert.rejects(
      checkoutMachine({
        machineId: machines[1].id,
        studentEmail,
        provision: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof CheckoutError && error.status === 409,
    );
    const untouchedTarget = await db.machine.findUniqueOrThrow({
      where: { id: machines[1].id },
    });
    assert.equal(untouchedTarget.status, "available");
  } finally {
    const machineIds = machines.map((machine) => machine.id);
    await db.auditLog.deleteMany({ where: { machineId: { in: machineIds } } });
    await db.guestCredential.deleteMany({
      where: { machineId: { in: machineIds } },
    });
    await db.machine.deleteMany({ where: { id: { in: machineIds } } });
  }
});
