import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { NodeSSH } from "node-ssh";
import { POST } from "../app/api/cron/sweep/route";
import {
  MAX_CREDENTIALS_PER_SWEEP,
  sweepExpiredCredentials,
} from "../lib/backstop";
import { finalizeExpiredCredential } from "../lib/credential-expiry";
import { db } from "../lib/db/client";

function sshFingerprint(seed: string): string {
  return `SHA256:${createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

test(
  "the sweep has a bounded concurrent batch and defers excess backlog",
  { timeout: 5_000 },
  async () => {
    const suffix = randomUUID();
    const now = new Date();
    const machineIds: string[] = [];
    let revokeCalls = 0;
    let allBatchCallsStartedResolve: (() => void) | undefined;
    let releaseRevokesResolve: (() => void) | undefined;
    const allBatchCallsStarted = new Promise<void>((resolve) => {
      allBatchCallsStartedResolve = resolve;
    });
    const releaseRevokes = new Promise<void>((resolve) => {
      releaseRevokesResolve = resolve;
    });

    try {
      for (let index = 0; index < MAX_CREDENTIALS_PER_SWEEP + 1; index += 1) {
        const machine = await db.machine.create({
          data: {
            name: `Bounded sweep ${index} ${suffix}`,
            sshHostKeySha256: sshFingerprint(
              `bounded-sweep-${index}-${suffix}`,
            ),
            tailscaleIp: `100.64.0.${180 + index}`,
            webhookToken: randomBytes(32).toString("base64url"),
            status: "occupied",
            lastHeartbeat: now,
          },
        });
        machineIds.push(machine.id);
        await db.guestCredential.create({
          data: {
            machineId: machine.id,
            studentEmail: `bounded-${index}-${suffix}@ubu.ac.th`,
            expiresAt: new Date(now.getTime() - 60_000 + index),
          },
        });
      }

      const sweep = sweepExpiredCredentials(now, async () => {
        revokeCalls += 1;
        if (revokeCalls === MAX_CREDENTIALS_PER_SWEEP) {
          allBatchCallsStartedResolve?.();
        }
        await releaseRevokes;
      });

      await allBatchCallsStarted;
      assert.equal(revokeCalls, MAX_CREDENTIALS_PER_SWEEP);
      releaseRevokesResolve?.();

      const result = await sweep;
      assert.equal(result.revokedCredentials, MAX_CREDENTIALS_PER_SWEEP);
      assert.equal(result.releasedMachines, MAX_CREDENTIALS_PER_SWEEP);
      assert.equal(result.deferredCredentials, 1);
      assert.equal(
        await db.guestCredential.count({
          where: { machineId: { in: machineIds }, revokedAt: null },
        }),
        1,
      );
    } finally {
      releaseRevokesResolve?.();
      await db.auditLog.deleteMany({ where: { machineId: { in: machineIds } } });
      await db.guestCredential.deleteMany({
        where: { machineId: { in: machineIds } },
      });
      await db.machine.deleteMany({ where: { id: { in: machineIds } } });
    }
  },
);

test("one authenticated sweep keeps an unreachable generation occupied until lock confirmation", async (context) => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Backstop test ${suffix}`,
      sshHostKeySha256: sshFingerprint(`backstop-${suffix}`),
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
    context.mock.method(NodeSSH.prototype, "connect", async () => {
      throw new Error("Simulated unreachable machine");
    });
    context.mock.method(console, "error", () => undefined);

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
      pendingCredentials: number;
    };
    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const pending = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });

    assert.equal(result.revokedCredentials, 0);
    assert.equal(result.releasedMachines, 0);
    assert.ok(result.pendingCredentials >= 1);
    assert.equal(held.status, "occupied");
    assert.equal(pending.revokedAt, null);
    assert.equal(pending.machineStateVersion, 0);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("the sweep locks and releases an expired credential when SSH succeeds despite a stale heartbeat", async () => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Recent activity ${suffix}`,
      sshHostKeySha256: sshFingerprint(`recent-${suffix}`),
      tailscaleIp: "100.64.0.249",
      webhookToken: randomBytes(32).toString("base64url"),
      status: "occupied",
      lastHeartbeat: new Date(now.getTime() - 5 * 60 * 1_000),
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
      async (target, credentialId) => {
        assert.equal(target.tailscaleIp, machine.tailscaleIp);
        assert.equal(target.sshHostKeySha256, machine.sshHostKeySha256);
        assert.equal(credentialId, credential.id);
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
    assert.equal(revokedCredential.machineStateVersion, 3);
    assert.match(audit?.detail ?? "", /locked over SSH/);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("an unpinned expired machine cannot use SSH or become assignable", async () => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Unpinned expiry ${suffix}`,
      tailscaleIp: "100.64.0.219",
      webhookToken: `unpinned-expiry-${suffix}`,
      status: "occupied",
      lastHeartbeat: now,
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `unpinned-expiry-${suffix}@ubu.ac.th`,
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });
  let revokeCalls = 0;

  try {
    const retry = await sweepExpiredCredentials(now, async () => {
      revokeCalls += 1;
    });
    assert.equal(revokeCalls, 0);
    assert.ok(retry.pendingCredentials >= 1);
    assert.equal(
      (await db.machine.findUniqueOrThrow({ where: { id: machine.id } }))
        .status,
      "occupied",
    );
    assert.equal(
      (await db.guestCredential.findUniqueOrThrow({ where: { id: credential.id } }))
        .revokedAt,
      null,
    );

    const finalized = await finalizeExpiredCredential({
      credentialId: credential.id,
      now,
      detail: "Test-only confirmed local lock.",
    });
    assert.equal(finalized.status, "held");
    assert.equal(finalized.releasedMachine, false);
    assert.equal(
      (await db.machine.findUniqueOrThrow({ where: { id: machine.id } }))
        .status,
      "offline",
    );
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("the sweep locks an expired credential without releasing a different physical safety hold", async () => {
  const suffix = randomUUID();
  const now = new Date();
  const physicalHoldId = `physical-generation-${suffix}`;
  const machine = await db.machine.create({
    data: {
      name: `Safety-held expiry ${suffix}`,
      sshHostKeySha256: sshFingerprint(`safety-held-${suffix}`),
      tailscaleIp: "100.64.0.248",
      webhookToken: randomBytes(32).toString("base64url"),
      status: "occupied",
      lastHeartbeat: now,
      safetyHoldCredentialId: physicalHoldId,
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `held-expiry-${suffix}@ubu.ac.th`,
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });
  let revokeCalls = 0;

  try {
    const result = await sweepExpiredCredentials(
      now,
      async (_target, credentialId) => {
        assert.equal(credentialId, credential.id);
        revokeCalls += 1;
      },
    );

    const heldMachine = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    const revokedCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });

    assert.equal(revokeCalls, 1);
    assert.equal(result.revokedCredentials, 1);
    assert.equal(result.releasedMachines, 0);
    assert.equal(result.pendingCredentials, 0);
    assert.equal(heldMachine.status, "occupied");
    assert.equal(heldMachine.safetyHoldCredentialId, physicalHoldId);
    assert.ok(revokedCredential.revokedAt);
    assert.equal(revokedCredential.machineStateVersion, 3);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("an active session remains occupied with no maximum duration after login TTL", async () => {
  const suffix = randomUUID();
  const now = new Date();
  const machine = await db.machine.create({
    data: {
      name: `Long active session ${suffix}`,
      sshHostKeySha256: sshFingerprint(`long-active-${suffix}`),
      tailscaleIp: "100.64.0.242",
      webhookToken: randomBytes(32).toString("base64url"),
      status: "occupied",
      lastHeartbeat: now,
    },
  });
  const credential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `active-${suffix}@ubu.ac.th`,
      expiresAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000),
      sessionOpenedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000),
      machineStateVersion: 2,
    },
  });
  let revokeCalls = 0;

  try {
    const result = await sweepExpiredCredentials(now, async () => {
      revokeCalls += 1;
    });
    const activeCredential = await db.guestCredential.findUniqueOrThrow({
      where: { id: credential.id },
      include: { machine: true },
    });

    assert.equal(revokeCalls, 0);
    assert.ok(result.activeCredentials >= 1);
    assert.equal(activeCredential.revokedAt, null);
    assert.equal(activeCredential.machine.status, "occupied");
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
      sshHostKeySha256: sshFingerprint(`lock-retry-${suffix}`),
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
