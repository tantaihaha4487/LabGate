import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { POST } from "../app/api/admin/register-machine/route";
import { db } from "../lib/db/client";

test("machine registration requires the enrollment secret and returns one token", async () => {
  const name = `registration-${randomUUID()}`;
  const body = { name, tailscaleIp: "100.64.0.253" };
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
  } finally {
    await db.machine.deleteMany({ where: { name } });
  }
});
