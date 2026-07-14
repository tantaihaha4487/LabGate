import assert from "node:assert/strict";
import test from "node:test";
import { POST as authPost } from "../app/api/auth/[...all]/route";
import {
  enforceNewUserDomain,
  isAllowedInstitutionEmail,
} from "../lib/auth";

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
