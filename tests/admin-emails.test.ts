import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAdminEmail } from "../lib/admin-email-validation";
import {
  configuredAdminEmails,
  parseAdminEmails,
} from "../lib/admin-emails";
import {
  adminPageRedirectForAuthorization,
  isConfiguredAdminEmail,
} from "../lib/admin-authorization";

test("administrator lists normalize case and whitespace and deduplicate addresses", () => {
  assert.deepEqual(
    parseAdminEmails(
      " Admin@UBU.AC.TH,operator@ubu.ac.th, admin@ubu.ac.th ",
      "ubu.ac.th",
    ),
    ["admin@ubu.ac.th", "operator@ubu.ac.th"],
  );
  assert.equal(
    normalizeAdminEmail(" ADMIN@UBU.AC.TH ", "@UBU.AC.TH"),
    "admin@ubu.ac.th",
  );
});

test("administrator lists require valid exact-domain addresses", () => {
  for (const value of [
    undefined,
    "",
    "   ",
    ",",
    "admin@ubu.ac.th,",
    "admin",
    "@ubu.ac.th",
    ".admin@ubu.ac.th",
    "admin..operator@ubu.ac.th",
    "admin@gmail.com",
    "admin@sub.ubu.ac.th",
    "admin@evilubu.ac.th",
    "admin@ubu.ac.th.example.com",
    '"admin@ubu.ac.th"',
  ]) {
    assert.throws(
      () => parseAdminEmails(value, "ubu.ac.th"),
      /(ADMIN_EMAILS|valid @ubu\.ac\.th)/,
    );
  }
});

test("runtime administrator configuration is required", () => {
  const previous = process.env.ADMIN_EMAILS;

  try {
    delete process.env.ADMIN_EMAILS;
    assert.throws(() => configuredAdminEmails(), /ADMIN_EMAILS is required/);

    process.env.ADMIN_EMAILS = "ADMIN@UBU.AC.TH,admin@ubu.ac.th";
    assert.deepEqual(configuredAdminEmails(), ["admin@ubu.ac.th"]);
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = previous;
    }
  }
});

test("administrator authorization is case-insensitive but exact-domain", () => {
  assert.equal(isConfiguredAdminEmail("ADMIN@UBU.AC.TH"), true);
  assert.equal(isConfiguredAdminEmail("student@ubu.ac.th"), false);
  assert.equal(isConfiguredAdminEmail("admin@sub.ubu.ac.th"), false);
  assert.equal(isConfiguredAdminEmail("admin@ubu.ac.th.example.com"), false);
});

test("admin page authorization uses the required redirects", () => {
  assert.equal(
    adminPageRedirectForAuthorization("unauthenticated"),
    "/login",
  );
  assert.equal(adminPageRedirectForAuthorization("forbidden"), "/");
  assert.equal(adminPageRedirectForAuthorization("authorized"), null);
});
