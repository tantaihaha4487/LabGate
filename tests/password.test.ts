import assert from "node:assert/strict";
import test from "node:test";
import {
  generateGuestPassword,
  isValidGuestPassword,
} from "../lib/password";

test("guest passwords use only the unambiguous shell-safe charset", () => {
  for (let index = 0; index < 1_000; index += 1) {
    const password = generateGuestPassword();
    assert.equal(password.length, 16);
    assert.equal(isValidGuestPassword(password), true);
    assert.doesNotMatch(password, /[0O1lI]/);
    assert.match(password, /^[A-Za-z2-9]+$/);
  }
});
