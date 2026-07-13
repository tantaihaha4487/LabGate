import { randomInt } from "node:crypto";

export const PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const PASSWORD_PATTERN = /^[A-HJ-NP-Za-km-z2-9]+$/;

export function generateGuestPassword(length = 16): string {
  if (!Number.isInteger(length) || length < 12 || length > 128) {
    throw new RangeError("Guest password length must be between 12 and 128.");
  }

  return Array.from(
    { length },
    () => PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)],
  ).join("");
}

export function isValidGuestPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    password.length <= 128 &&
    PASSWORD_PATTERN.test(password)
  );
}
