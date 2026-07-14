import { randomInt } from "node:crypto";
import {
  configuredGuestPasswordLength,
  MAX_GUEST_PASSWORD_LENGTH,
  MIN_GUEST_PASSWORD_LENGTH,
  PASSWORD_CHARSET,
  PASSWORD_PATTERN,
} from "@/lib/password-config";

export {
  configuredGuestPasswordLength,
  DEFAULT_GUEST_PASSWORD_LENGTH,
  MAX_GUEST_PASSWORD_LENGTH,
  MIN_GUEST_PASSWORD_LENGTH,
  PASSWORD_CHARSET,
  PASSWORD_PATTERN,
} from "@/lib/password-config";

export function generateGuestPassword(
  length = configuredGuestPasswordLength(),
): string {
  if (
    !Number.isInteger(length) ||
    length < MIN_GUEST_PASSWORD_LENGTH ||
    length > MAX_GUEST_PASSWORD_LENGTH
  ) {
    throw new RangeError(
      `Guest password length must be between ${MIN_GUEST_PASSWORD_LENGTH} and ${MAX_GUEST_PASSWORD_LENGTH}.`,
    );
  }

  return Array.from(
    { length },
    () => PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)],
  ).join("");
}

export function isValidGuestPassword(password: string): boolean {
  return (
    password.length >= MIN_GUEST_PASSWORD_LENGTH &&
    password.length <= MAX_GUEST_PASSWORD_LENGTH &&
    PASSWORD_PATTERN.test(password)
  );
}
