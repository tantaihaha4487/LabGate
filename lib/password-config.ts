export const PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const PASSWORD_PATTERN = /^[A-HJ-NP-Za-km-z2-9]+$/;
export const DEFAULT_GUEST_PASSWORD_LENGTH = 8;
export const MIN_GUEST_PASSWORD_LENGTH = 5;
export const MAX_GUEST_PASSWORD_LENGTH = 128;

export function configuredGuestPasswordLength(): number {
  const rawConfiguredLength = process.env.GUEST_PASSWORD_LENGTH;

  if (rawConfiguredLength === undefined) {
    return DEFAULT_GUEST_PASSWORD_LENGTH;
  }

  const configuredLength = rawConfiguredLength.trim();

  if (!/^\d+$/.test(configuredLength)) {
    throw new Error("GUEST_PASSWORD_LENGTH must be a whole number.");
  }

  const length = Number(configuredLength);

  if (
    !Number.isSafeInteger(length) ||
    length < MIN_GUEST_PASSWORD_LENGTH ||
    length > MAX_GUEST_PASSWORD_LENGTH
  ) {
    throw new RangeError(
      `GUEST_PASSWORD_LENGTH must be between ${MIN_GUEST_PASSWORD_LENGTH} and ${MAX_GUEST_PASSWORD_LENGTH}.`,
    );
  }

  return length;
}
