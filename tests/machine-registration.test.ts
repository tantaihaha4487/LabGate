import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  GET as registrationReadiness,
  PATCH as rekeyMachine,
  POST,
} from "../app/api/admin/register-machine/route";
import { POST as heartbeat } from "../app/api/webhook/heartbeat/route";
import { db } from "../lib/db/client";

function sshFingerprint(seed: string): string {
  return `SHA256:${createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

test("registration readiness authenticates without changing machine state", async () => {
  const before = await db.machine.count();
  const unauthorized = await registrationReadiness(
    new Request("http://localhost/api/admin/register-machine"),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");

  const authorized = await registrationReadiness(
    new Request("http://localhost/api/admin/register-machine", {
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
      },
    }),
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    ok: true,
    service: "labgate",
    machineEnrollmentVersion: 1,
    registrationReady: true,
  });
  assert.equal(authorized.headers.get("cache-control"), "no-store");
  assert.equal(await db.machine.count(), before);
});

test("registration readiness reports an unconfigured Pi without mutation", async () => {
  const before = await db.machine.count();
  const configuredSecret = process.env.MACHINE_REGISTRATION_SECRET;
  delete process.env.MACHINE_REGISTRATION_SECRET;

  try {
    const response = await registrationReadiness(
      new Request("http://localhost/api/admin/register-machine"),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      service: "labgate",
      machineEnrollmentVersion: 1,
      registrationReady: false,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await db.machine.count(), before);
  } finally {
    if (configuredSecret === undefined) {
      delete process.env.MACHINE_REGISTRATION_SECRET;
    } else {
      process.env.MACHINE_REGISTRATION_SECRET = configuredSecret;
    }
  }
});

test("machine registration requires the enrollment secret and returns one token", async () => {
  const name = `registration-${randomUUID()}`;
  const body = {
    name,
    sshHostKeySha256: sshFingerprint(name),
    tailscaleIp: "100.64.0.253",
  };
  const unauthorized = await POST(
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  assert.equal(unauthorized.status, 401);

  const authorized = await POST(
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

  try {
    assert.equal(authorized.status, 200);
    const result = (await authorized.json()) as { webhookToken: string };
    assert.match(result.webhookToken, /^[A-Za-z0-9_-]{43}$/);

    const machine = await db.machine.findFirstOrThrow({ where: { name } });
    assert.equal(machine.webhookToken, result.webhookToken);
    assert.equal(machine.sshHostKeySha256, body.sshHostKeySha256);
    assert.equal(machine.status, "offline");
    assert.equal(machine.isHidden, false);
    assert.equal(machine.lastHeartbeat, null);

    const safeHeartbeat = await heartbeat(
      new Request("http://localhost/api/webhook/heartbeat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${result.webhookToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          credentialId: null,
          guestLocked: true,
          sessionActive: false,
          state: null,
          stateVersion: null,
        }),
      }),
    );
    assert.equal(safeHeartbeat.status, 200);
    const confirmed = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(confirmed.status, "available");
    assert.ok(confirmed.lastHeartbeat);
  } finally {
    await db.machine.deleteMany({ where: { name } });
  }
});

test("registration rejects non-canonical or non-Tailscale IPv4 aliases", async () => {
  for (const tailscaleIp of [
    "100.64.0.01",
    "100.064.000.001",
    "100.64.0.1 ",
    "100.128.0.1",
    "192.168.1.1",
  ]) {
    const response = await POST(
      new Request("http://localhost/api/admin/register-machine", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `invalid-ip-${randomUUID()}`,
          sshHostKeySha256: sshFingerprint(tailscaleIp),
          tailscaleIp,
        }),
      }),
    );
    assert.equal(response.status, 400, tailscaleIp);
  }
});

test("registration rejects an oversized body before full buffering", async () => {
  const response = await POST(
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `oversized-${randomUUID()}`,
        sshHostKeySha256: sshFingerprint("oversized-registration"),
        tailscaleIp: "100.64.0.219",
        padding: "x".repeat(5_000),
      }),
    }),
  );

  assert.equal(response.status, 413);
});

test("registration requires a canonical SHA256 host-key pin and exact replay match", async () => {
  const suffix = randomUUID();
  const name = `registration-pin-${suffix}`;
  const tailscaleIp = "100.64.0.220";
  const validPin = sshFingerprint(`registration-pin-${suffix}`);
  const request = (sshHostKeySha256: unknown) =>
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, sshHostKeySha256, tailscaleIp }),
    });

  for (const invalidPin of [
    undefined,
    null,
    "SHA256:short",
    `${validPin}=`,
    `SHA256:${"A".repeat(42)}-`,
    `sha256:${validPin.slice(7)}`,
  ]) {
    assert.equal((await POST(request(invalidPin))).status, 400);
  }

  try {
    const first = await POST(request(validPin));
    assert.equal(first.status, 200);
    const firstToken = ((await first.json()) as { webhookToken: string })
      .webhookToken;

    const replay = await POST(request(validPin));
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { webhookToken: string }).webhookToken,
      firstToken,
    );

    const mismatch = await POST(
      request(sshFingerprint(`replacement-pin-${suffix}`)),
    );
    assert.equal(mismatch.status, 409);
    const unchanged = await db.machine.findFirstOrThrow({ where: { name } });
    assert.equal(unchanged.sshHostKeySha256, validPin);
    assert.equal(unchanged.webhookToken, firstToken);
  } finally {
    await db.machine.deleteMany({ where: { name } });
  }
});

test("re-registering a machine never releases an existing reservation", async () => {
  const suffix = randomUUID();
  const name = `registration-occupied-${suffix}`;
  const machine = await db.machine.create({
    data: {
      name,
      sshHostKeySha256: sshFingerprint(name),
      tailscaleIp: "100.64.0.239",
      webhookToken: `old-token-${suffix}`,
      status: "occupied",
      lastHeartbeat: new Date(Date.now() - 60_000),
    },
  });
  await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `registration-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  try {
    const response = await POST(
      new Request("http://localhost/api/admin/register-machine", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          sshHostKeySha256: machine.sshHostKeySha256,
          tailscaleIp: "100.64.0.239",
        }),
      }),
    );
    assert.equal(response.status, 200);

    const updated = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(updated.status, "occupied");
    assert.equal(updated.tailscaleIp, "100.64.0.239");
    assert.equal(updated.webhookToken, machine.webhookToken);
    assert.equal(
      updated.lastHeartbeat?.getTime(),
      machine.lastHeartbeat?.getTime(),
    );
  } finally {
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("concurrent identical registration creates one machine and returns one stable token", async () => {
  const suffix = randomUUID();
  const body = {
    name: `registration-race-${suffix}`,
    sshHostKeySha256: sshFingerprint(`registration-race-${suffix}`),
    tailscaleIp: "100.64.0.234",
  };
  const request = () =>
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  try {
    const responses = await Promise.all([POST(request()), POST(request())]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    const results = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ webhookToken: string }>;
    assert.equal(results[0].webhookToken, results[1].webhookToken);
    assert.match(results[0].webhookToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await db.machine.count({ where: { name: body.name } }), 1);
    assert.equal(
      await db.machine.count({ where: { tailscaleIp: body.tailscaleIp } }),
      1,
    );
    const registered = await db.machine.findFirstOrThrow({
      where: { name: body.name },
    });
    assert.equal(registered.status, "offline");
    assert.equal(registered.lastHeartbeat, null);
  } finally {
    await db.machine.deleteMany({ where: { name: body.name } });
  }
});

test("concurrent re-registration preserves the existing current token", async () => {
  const suffix = randomUUID();
  const body = {
    name: `registration-existing-race-${suffix}`,
    sshHostKeySha256: sshFingerprint(`registration-existing-race-${suffix}`),
    tailscaleIp: "100.64.0.233",
  };
  const existingToken = `registration-existing-token-${suffix}`;
  const machine = await db.machine.create({
    data: {
      ...body,
      webhookToken: existingToken,
      status: "occupied",
      lastHeartbeat: new Date(Date.now() - 60_000),
    },
  });
  const request = () =>
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  try {
    const responses = await Promise.all([POST(request()), POST(request())]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    const results = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ webhookToken: string }>;
    assert.deepEqual(
      results.map((result) => result.webhookToken),
      [existingToken, existingToken],
    );
    const unchanged = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(unchanged.webhookToken, existingToken);
    assert.equal(unchanged.status, "occupied");
    assert.equal(
      unchanged.lastHeartbeat?.getTime(),
      machine.lastHeartbeat?.getTime(),
    );
  } finally {
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("exact re-registration cannot revive stale checkout eligibility", async () => {
  const suffix = randomUUID();
  const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1_000);
  const body = {
    name: `registration-stale-${suffix}`,
    sshHostKeySha256: sshFingerprint(`registration-stale-${suffix}`),
    tailscaleIp: "100.64.0.238",
  };
  const machine = await db.machine.create({
    data: {
      ...body,
      webhookToken: `registration-stale-token-${suffix}`,
      status: "available",
      lastHeartbeat: staleHeartbeat,
    },
  });

  try {
    const response = await POST(
      new Request("http://localhost/api/admin/register-machine", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { webhookToken: string }).webhookToken,
      machine.webhookToken,
    );

    const unchanged = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(unchanged.status, "available");
    assert.equal(unchanged.lastHeartbeat?.getTime(), staleHeartbeat.getTime());
  } finally {
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("registration cannot concurrently mutate an existing machine identity", async () => {
  const suffix = randomUUID();
  const machine = await db.machine.create({
    data: {
      name: `immutable-registration-${suffix}`,
      sshHostKeySha256: sshFingerprint(`immutable-registration-${suffix}`),
      tailscaleIp: "100.64.0.232",
      webhookToken: `immutable-registration-token-${suffix}`,
    },
  });
  const request = (name: string, tailscaleIp: string) =>
    new Request("http://localhost/api/admin/register-machine", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        sshHostKeySha256: machine.sshHostKeySha256,
        tailscaleIp,
      }),
    });

  try {
    const responses = await Promise.all([
      POST(request(machine.name, "100.64.0.231")),
      POST(request(`renamed-${suffix}`, machine.tailscaleIp)),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [409, 409],
    );
    const unchanged = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(unchanged.name, machine.name);
    assert.equal(unchanged.tailscaleIp, machine.tailscaleIp);
    assert.equal(unchanged.webhookToken, machine.webhookToken);
  } finally {
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("registration refuses to merge a name and address from different machines", async () => {
  const suffix = randomUUID();
  const machines = await Promise.all(
    [
      {
        name: `registration-name-${suffix}`,
        sshHostKeySha256: sshFingerprint(`registration-name-${suffix}`),
        tailscaleIp: "100.64.0.237",
      },
      {
        name: `registration-ip-${suffix}`,
        sshHostKeySha256: sshFingerprint(`registration-ip-${suffix}`),
        tailscaleIp: "100.64.0.236",
      },
    ].map((machine, index) =>
      db.machine.create({
        data: {
          ...machine,
          webhookToken: `registration-conflict-${index}-${suffix}`,
        },
      }),
    ),
  );

  try {
    const response = await POST(
      new Request("http://localhost/api/admin/register-machine", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: machines[0].name,
          sshHostKeySha256: machines[0].sshHostKeySha256,
          tailscaleIp: machines[1].tailscaleIp,
        }),
      }),
    );
    assert.equal(response.status, 409);

    const unchanged = await db.machine.findMany({
      where: { id: { in: machines.map((machine) => machine.id) } },
      orderBy: { name: "asc" },
    });
    assert.equal(unchanged.length, 2);
    assert.deepEqual(
      new Set(unchanged.map((machine) => machine.tailscaleIp)),
      new Set(["100.64.0.237", "100.64.0.236"]),
    );
  } finally {
    await db.machine.deleteMany({
      where: { id: { in: machines.map((machine) => machine.id) } },
    });
  }
});

test("drained machine rekey rotates its token and waits for a safe heartbeat", async () => {
  const suffix = randomUUID();
  const originalToken = `rekey-original-token-${suffix}`;
  const machine = await db.machine.create({
    data: {
      name: `rekey-original-${suffix}`,
      tailscaleIp: "100.64.0.230",
      webhookToken: originalToken,
      status: "available",
      isHidden: true,
      lastHeartbeat: new Date(),
    },
  });
  const historicalCredential = await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `rekey-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() - 120_000),
      revokedAt: new Date(Date.now() - 60_000),
      machineStateVersion: 3,
    },
  });
  const body = {
    machineId: machine.id,
    expectedName: machine.name,
    expectedSshHostKeySha256: null,
    expectedTailscaleIp: machine.tailscaleIp,
    name: `rekey-replacement-${suffix}`,
    sshHostKeySha256: sshFingerprint(`rekey-replacement-${suffix}`),
    tailscaleIp: "100.64.0.229",
  };
  const request = (
    authorization?: string,
    requestBody: Record<string, unknown> = body,
  ) =>
    new Request("http://localhost/api/admin/register-machine", {
      method: "PATCH",
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

  try {
    assert.equal((await rekeyMachine(request())).status, 401);

    const pinConflict = await rekeyMachine(
      request(`Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`, {
        ...body,
        expectedSshHostKeySha256: sshFingerprint(`wrong-current-${suffix}`),
      }),
    );
    assert.equal(pinConflict.status, 409);
    assert.equal(
      (await db.machine.findUniqueOrThrow({ where: { id: machine.id } }))
        .webhookToken,
      originalToken,
    );

    const response = await rekeyMachine(
      request(`Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`),
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      status: string;
      webhookToken: string;
    };
    assert.equal(result.status, "offline");
    assert.match(result.webhookToken, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(result.webhookToken, originalToken);

    const held = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(held.name, body.name);
    assert.equal(held.sshHostKeySha256, body.sshHostKeySha256);
    assert.equal(held.tailscaleIp, body.tailscaleIp);
    assert.equal(held.status, "offline");
    assert.equal(held.isHidden, true);
    assert.equal(held.lastHeartbeat, null);
    assert.equal(held.webhookToken, result.webhookToken);
    assert.equal(
      await db.auditLog.count({
        where: { machineId: machine.id, event: "machine_rekey" },
      }),
      1,
    );

    const report = {
      credentialId: historicalCredential.id,
      guestLocked: true,
      sessionActive: false,
      state: "revoked",
      stateVersion: 3,
    };
    const heartbeatRequest = (token: string) =>
      new Request("http://localhost/api/webhook/heartbeat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(report),
      });
    assert.equal((await heartbeat(heartbeatRequest(originalToken))).status, 401);
    const confirmed = await heartbeat(
      heartbeatRequest(result.webhookToken),
    );
    assert.equal(confirmed.status, 200);
    assert.equal(
      ((await confirmed.json()) as { status: string }).status,
      "already_closed",
    );
    const available = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(available.status, "available");
    assert.equal(available.isHidden, true);
  } finally {
    await db.auditLog.deleteMany({ where: { machineId: machine.id } });
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});

test("machine rekey refuses an occupied or current-credential machine", async () => {
  const suffix = randomUUID();
  const machine = await db.machine.create({
    data: {
      name: `rekey-occupied-${suffix}`,
      sshHostKeySha256: sshFingerprint(`rekey-occupied-${suffix}`),
      tailscaleIp: "100.64.0.228",
      webhookToken: `rekey-occupied-token-${suffix}`,
      status: "occupied",
    },
  });
  await db.guestCredential.create({
    data: {
      machineId: machine.id,
      studentEmail: `rekey-occupied-${suffix}@ubu.ac.th`,
      expiresAt: new Date(Date.now() + 60_000),
      machineStateVersion: 1,
    },
  });

  try {
    const response = await rekeyMachine(
      new Request("http://localhost/api/admin/register-machine", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.MACHINE_REGISTRATION_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          machineId: machine.id,
          expectedName: machine.name,
          expectedSshHostKeySha256: machine.sshHostKeySha256,
          expectedTailscaleIp: machine.tailscaleIp,
          name: `rekey-should-not-apply-${suffix}`,
          sshHostKeySha256: sshFingerprint(`rekey-should-not-apply-${suffix}`),
          tailscaleIp: "100.64.0.227",
        }),
      }),
    );
    assert.equal(response.status, 409);

    const unchanged = await db.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    assert.equal(unchanged.name, machine.name);
    assert.equal(unchanged.tailscaleIp, machine.tailscaleIp);
    assert.equal(unchanged.webhookToken, machine.webhookToken);
    assert.equal(unchanged.status, "occupied");
  } finally {
    await db.guestCredential.deleteMany({ where: { machineId: machine.id } });
    await db.machine.delete({ where: { id: machine.id } });
  }
});
