import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { GET as getAdminLogs } from "../app/api/admin/logs/route";
import { db } from "../lib/db/client";

function sshFingerprint(seed: string): string {
  return `SHA256:${createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

function adminRequest(url: string, token: string): Request {
  const secret = process.env.BETTER_AUTH_SECRET;
  assert.ok(secret);
  const cookie = `better-auth.session_token=${token}.${createHmac(
    "sha256",
    secret,
  )
    .update(token)
    .digest("base64")}`;
  return new Request(url, { headers: { Cookie: cookie } });
}

async function createAdminSession(suffix: string) {
  const userId = `activity-admin-user-${suffix}`;
  const token = randomBytes(32).toString("base64url");
  await db.user.create({
    data: {
      id: userId,
      name: "Activity administrator",
      email: "admin@ubu.ac.th",
      emailVerified: true,
    },
  });
  await db.session.create({
    data: {
      id: `activity-admin-session-${suffix}`,
      token,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  return { userId, token };
}

test("admin activity API maps attributable events and stays secret-safe", async () => {
  const suffix = randomUUID();
  const physicalEmail = `physical-${suffix}@ubu.ac.th`;
  const webEmail = `web-${suffix}@ubu.ac.th`;
  const machine = await db.machine.create({
    data: {
      name: `Activity machine ${suffix}`,
      tailscaleIp: "100.127.240.1",
      sshHostKeySha256: sshFingerprint(`activity-${suffix}`),
      webhookToken: `activity-webhook-secret-${suffix}`,
      status: "occupied",
      lastHeartbeat: new Date(),
    },
  });
  const admin = await createAdminSession(suffix);
  const nonAdminUserId = `activity-non-admin-user-${suffix}`;
  const nonAdminToken = randomBytes(32).toString("base64url");
  const timestamp = new Date("2026-07-16T05:00:00.000Z");
  const detailSecret = `detail-secret-${suffix}`;

  try {
    await db.auditLog.createMany({
      data: [
        {
          id: `activity-web-login-${suffix}`,
          studentEmail: webEmail,
          event: "login",
          createdAt: timestamp,
        },
        {
          id: `activity-web-logout-${suffix}`,
          studentEmail: webEmail,
          event: "logout",
          detail: detailSecret,
          createdAt: new Date(timestamp.getTime() + 1_000),
        },
        {
          id: `activity-physical-open-${suffix}`,
          machineId: machine.id,
          studentEmail: physicalEmail,
          event: "session_open",
          createdAt: new Date(timestamp.getTime() + 2_000),
        },
        {
          id: `activity-physical-close-${suffix}`,
          machineId: machine.id,
          studentEmail: physicalEmail,
          event: "session_close",
          createdAt: new Date(timestamp.getTime() + 3_000),
        },
        {
          id: `activity-password-timeout-${suffix}`,
          machineId: machine.id,
          studentEmail: physicalEmail,
          event: "password_timeout",
          createdAt: new Date(timestamp.getTime() + 4_000),
        },
        {
          id: `activity-unattributed-${suffix}`,
          machineId: machine.id,
          studentEmail: null,
          event: "session_open",
          detail: detailSecret,
          createdAt: new Date(timestamp.getTime() + 5_000),
        },
        {
          id: `activity-checkout-${suffix}`,
          machineId: machine.id,
          studentEmail: webEmail,
          event: "checkout",
          detail: detailSecret,
          createdAt: new Date(timestamp.getTime() + 6_000),
        },
      ],
    });

    const unauthenticated = await getAdminLogs(
      new Request("http://localhost/api/admin/logs"),
    );
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("cache-control") ?? "", /no-store/);

    await db.user.create({
      data: {
        id: nonAdminUserId,
        name: "Activity non-admin",
        email: `non-admin-${suffix}@ubu.ac.th`,
        emailVerified: true,
      },
    });
    await db.session.create({
      data: {
        id: `activity-non-admin-session-${suffix}`,
        token: nonAdminToken,
        userId: nonAdminUserId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    const forbidden = await getAdminLogs(
      adminRequest("http://localhost/api/admin/logs", nonAdminToken),
    );
    assert.equal(forbidden.status, 403);

    const authorized = await getAdminLogs(
      adminRequest("http://localhost/api/admin/logs", admin.token),
    );
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get("cache-control") ?? "", /no-store/);
    const payload = (await authorized.json()) as {
      entries: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    const entries = payload.entries.filter((entry) =>
      String(entry.email).includes(suffix),
    );
    assert.deepEqual(
      entries.map((entry) => ({
        id: entry.id,
        source: entry.source,
        action: entry.action,
        status: entry.status,
        email: entry.email,
        machine: entry.machine,
      })),
      [
        {
          id: `activity-checkout-${suffix}`,
          source: "web",
          action: "checkout",
          status: "reserved",
          email: webEmail,
          machine: { id: machine.id, name: machine.name },
        },
        {
          id: `activity-password-timeout-${suffix}`,
          source: "physical",
          action: "timeout",
          status: "password_timeout",
          email: physicalEmail,
          machine: { id: machine.id, name: machine.name },
        },
        {
          id: `activity-physical-close-${suffix}`,
          source: "physical",
          action: "logout",
          status: "logged_out",
          email: physicalEmail,
          machine: { id: machine.id, name: machine.name },
        },
        {
          id: `activity-physical-open-${suffix}`,
          source: "physical",
          action: "login",
          status: "logged_in",
          email: physicalEmail,
          machine: { id: machine.id, name: machine.name },
        },
        {
          id: `activity-web-logout-${suffix}`,
          source: "web",
          action: "logout",
          status: "logged_out",
          email: webEmail,
          machine: null,
        },
        {
          id: `activity-web-login-${suffix}`,
          source: "web",
          action: "login",
          status: "logged_in",
          email: webEmail,
          machine: null,
        },
      ],
    );
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(detailSecret), false);
    assert.equal(serialized.includes(machine.webhookToken), false);
    assert.equal(serialized.includes("tailscaleIp"), false);
    assert.equal(serialized.includes("userAgent"), false);

    const filtered = await getAdminLogs(
      adminRequest(
        `http://localhost/api/admin/logs?source=physical&action=logout&email=${encodeURIComponent(
          physicalEmail.toUpperCase(),
        )}`,
        admin.token,
      ),
    );
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      ((await filtered.json()) as { entries: Array<{ id: string }> }).entries.map(
        (entry) => entry.id,
      ),
      [`activity-physical-close-${suffix}`],
    );

    const timeoutFiltered = await getAdminLogs(
      adminRequest(
        `http://localhost/api/admin/logs?source=physical&action=timeout&email=${encodeURIComponent(
          physicalEmail,
        )}`,
        admin.token,
      ),
    );
    assert.equal(timeoutFiltered.status, 200);
    assert.deepEqual(
      ((await timeoutFiltered.json()) as { entries: Array<{ id: string }> }).entries.map(
        (entry) => entry.id,
      ),
      [`activity-password-timeout-${suffix}`],
    );

    const checkoutFiltered = await getAdminLogs(
      adminRequest(
        `http://localhost/api/admin/logs?source=web&action=checkout&email=${encodeURIComponent(
          webEmail,
        )}`,
        admin.token,
      ),
    );
    assert.equal(checkoutFiltered.status, 200);
    assert.deepEqual(
      ((await checkoutFiltered.json()) as {
        entries: Array<Record<string, unknown>>;
      }).entries,
      [
        {
          id: `activity-checkout-${suffix}`,
          source: "web",
          action: "checkout",
          status: "reserved",
          email: webEmail,
          occurredAt: new Date(timestamp.getTime() + 6_000).toISOString(),
          machine: { id: machine.id, name: machine.name },
        },
      ],
    );

    for (const query of ["source=invalid", "cursor=invalid", "unknown=true"]) {
      const invalid = await getAdminLogs(
        adminRequest(`http://localhost/api/admin/logs?${query}`, admin.token),
      );
      assert.equal(invalid.status, 400);
      assert.match(invalid.headers.get("cache-control") ?? "", /no-store/);
    }
  } finally {
    await db.auditLog.deleteMany({ where: { id: { contains: suffix } } });
    await db.session.deleteMany({ where: { userId: admin.userId } });
    await db.user.deleteMany({ where: { id: admin.userId } });
    await db.session.deleteMany({ where: { userId: nonAdminUserId } });
    await db.user.deleteMany({ where: { id: nonAdminUserId } });
    await db.machine.deleteMany({ where: { id: machine.id } });
  }
});

test("admin activity pagination includes reservations deterministically without duplicates", async () => {
  const suffix = randomUUID();
  const admin = await createAdminSession(`page-${suffix}`);
  const createdAt = new Date("2026-07-16T06:00:00.000Z");
  const ids = Array.from({ length: 55 }, (_, index) =>
    `activity-page-${suffix}-${String(index).padStart(2, "0")}`,
  );

  try {
    await db.auditLog.createMany({
      data: ids.map((id, index) => ({
        id,
        studentEmail: `page-${suffix}-${index}@ubu.ac.th`,
        event: "checkout" as const,
        createdAt,
      })),
    });

    const first = await getAdminLogs(
      adminRequest(
        `http://localhost/api/admin/logs?source=web&action=checkout&email=page-${suffix}`,
        admin.token,
      ),
    );
    assert.equal(first.status, 200);
    const firstPayload = (await first.json()) as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.equal(firstPayload.entries.length, 50);
    assert.ok(firstPayload.nextCursor);

    const second = await getAdminLogs(
      adminRequest(
        `http://localhost/api/admin/logs?source=web&action=checkout&email=page-${suffix}&cursor=${encodeURIComponent(
          firstPayload.nextCursor,
        )}`,
        admin.token,
      ),
    );
    assert.equal(second.status, 200);
    const secondPayload = (await second.json()) as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.equal(secondPayload.entries.length, 5);
    assert.equal(secondPayload.nextCursor, null);

    const combined = [
      ...firstPayload.entries.map((entry) => entry.id),
      ...secondPayload.entries.map((entry) => entry.id),
    ];
    assert.equal(new Set(combined).size, 55);
    assert.deepEqual(combined, [...ids].reverse());
  } finally {
    await db.auditLog.deleteMany({ where: { id: { startsWith: `activity-page-${suffix}` } } });
    await db.session.deleteMany({ where: { userId: admin.userId } });
    await db.user.deleteMany({ where: { id: admin.userId } });
  }
});
