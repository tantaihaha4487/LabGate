import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredGuestPasswordLength,
  DEFAULT_GUEST_PASSWORD_LENGTH,
  generateGuestPassword,
  isValidGuestPassword,
} from "../lib/password";

test("guest passwords default to eight shell-safe characters and honor the environment length", () => {
  const previousLength = process.env.GUEST_PASSWORD_LENGTH;

  try {
    delete process.env.GUEST_PASSWORD_LENGTH;
    assert.equal(configuredGuestPasswordLength(), DEFAULT_GUEST_PASSWORD_LENGTH);

    for (let index = 0; index < 1_000; index += 1) {
      const password = generateGuestPassword();
      assert.equal(password.length, 8);
      assert.equal(isValidGuestPassword(password), true);
      assert.doesNotMatch(password, /[0O1lI]/);
      assert.match(password, /^[A-Za-z2-9]+$/);
    }

    process.env.GUEST_PASSWORD_LENGTH = "24";
    assert.equal(generateGuestPassword().length, 24);

    process.env.GUEST_PASSWORD_LENGTH = "7";
    assert.throws(() => generateGuestPassword(), /between 8 and 128/);

    process.env.GUEST_PASSWORD_LENGTH = "8.5";
    assert.throws(() => generateGuestPassword(), /whole number/);

    process.env.GUEST_PASSWORD_LENGTH = " ";
    assert.throws(() => generateGuestPassword(), /whole number/);
  } finally {
    if (previousLength === undefined) {
      delete process.env.GUEST_PASSWORD_LENGTH;
    } else {
      process.env.GUEST_PASSWORD_LENGTH = previousLength;
    }
  }
});
