import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST as authPost } from "../app/api/auth/[...all]/route";
import {
  enforceNewUserDomain,
  isAllowedInstitutionEmail,
} from "../lib/auth";
import { db } from "../lib/db/client";

test("accepts only the configured institutional email suffix", () => {
  assert.equal(isAllowedInstitutionEmail("student@ubu.ac.th"), true);
  assert.equal(isAllowedInstitutionEmail("STUDENT@UBU.AC.TH"), true);
  assert.equal(isAllowedInstitutionEmail("student@gmail.com"), false);
  assert.equal(isAllowedInstitutionEmail("student@sub.ubu.ac.th"), false);
  assert.equal(isAllowedInstitutionEmail("student@evilubu.ac.th"), false);
});

test("server-side user hook rejects an off-domain email despite a forged hd value", async () => {
  await assert.rejects(
    enforceNewUserDomain({
      email: "attacker@gmail.com",
      hd: "ubu.ac.th",
    }),
    /restricted to @ubu\.ac\.th accounts/,
  );
});

test("server-side user hook accepts a university account", async () => {
  const user = { email: "student@ubu.ac.th" };
  assert.deepEqual(await enforceNewUserDomain(user), { data: user });
});

test("the auth handler rejects an oversized body before Better Auth buffers it", async () => {
  const response = await authPost(
    new Request("http://localhost/api/auth/sign-in/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70_000) }),
    }),
  );

  assert.equal(response.status, 413);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("successful sign-out deletes the session and records exactly one logout", async () => {
  const suffix = randomUUID();
  const userId = `logout-user-${suffix}`;
  const sessionId = `logout-session-${suffix}`;
  const token = randomBytes(32).toString("base64url");
  const email = `logout-${suffix}@ubu.ac.th`;
  const secret = process.env.BETTER_AUTH_SECRET;

  assert.ok(secret);
  await db.user.create({
    data: {
      id: userId,
      name: "Logout test user",
      email,
      emailVerified: true,
    },
  });
  await db.session.create({
    data: {
      id: sessionId,
      token,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });

  const signedCookie = `better-auth.session_token=${token}.${createHmac(
    "sha256",
    secret,
  )
    .update(token)
    .digest("base64")}`;
  const signOut = () =>
    authPost(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: signedCookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );

  try {
    const first = await signOut();
    assert.equal(first.status, 200);
    assert.equal(
      await db.session.findUnique({ where: { id: sessionId } }),
      null,
    );
    assert.equal(
      await db.auditLog.count({ where: { studentEmail: email, event: "logout" } }),
      1,
    );

    const second = await signOut();
    assert.equal(second.status, 200);
    assert.equal(
      await db.auditLog.count({ where: { studentEmail: email, event: "logout" } }),
      1,
    );
  } finally {
    await db.auditLog.deleteMany({ where: { studentEmail: email } });
    await db.session.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
  }
});
