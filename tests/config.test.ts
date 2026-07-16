import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialTtlMilliseconds,
  DEFAULT_CREDENTIAL_TTL_HOURS,
  validateRuntimeConfiguration,
} from "../lib/config";

test("runtime configuration defaults are explicit and invalid values fail clearly", () => {
  const previousLength = process.env.GUEST_PASSWORD_LENGTH;
  const previousTtl = process.env.CREDENTIAL_TTL_HOURS;

  try {
    delete process.env.GUEST_PASSWORD_LENGTH;
    delete process.env.CREDENTIAL_TTL_HOURS;
    assert.doesNotThrow(() => validateRuntimeConfiguration());
    assert.equal(
      credentialTtlMilliseconds(),
      DEFAULT_CREDENTIAL_TTL_HOURS * 60 * 60 * 1_000,
    );

    process.env.GUEST_PASSWORD_LENGTH = "4";
    assert.throws(
      () => validateRuntimeConfiguration(),
      /GUEST_PASSWORD_LENGTH must be between 5 and 128/,
    );

    process.env.GUEST_PASSWORD_LENGTH = "5";
    assert.doesNotThrow(() => validateRuntimeConfiguration());

    process.env.GUEST_PASSWORD_LENGTH = "8";
    process.env.CREDENTIAL_TTL_HOURS = "0";
    assert.throws(
      () => validateRuntimeConfiguration(),
      /CREDENTIAL_TTL_HOURS must be at least one minute/,
    );

    process.env.CREDENTIAL_TTL_HOURS = " ";
    assert.throws(
      () => validateRuntimeConfiguration(),
      /CREDENTIAL_TTL_HOURS must be at least one minute/,
    );

    process.env.CREDENTIAL_TTL_HOURS = "0.001";
    assert.throws(
      () => validateRuntimeConfiguration(),
      /CREDENTIAL_TTL_HOURS must be at least one minute/,
    );

    process.env.CREDENTIAL_TTL_HOURS = "0.05";
    process.env.GUEST_PASSWORD_LENGTH = " ";
    assert.throws(
      () => validateRuntimeConfiguration(),
      /GUEST_PASSWORD_LENGTH must be a whole number/,
    );
  } finally {
    if (previousLength === undefined) {
      delete process.env.GUEST_PASSWORD_LENGTH;
    } else {
      process.env.GUEST_PASSWORD_LENGTH = previousLength;
    }
    if (previousTtl === undefined) {
      delete process.env.CREDENTIAL_TTL_HOURS;
    } else {
      process.env.CREDENTIAL_TTL_HOURS = previousTtl;
    }
  }
});
