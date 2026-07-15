import { configuredGuestPasswordLength } from "@/lib/password-config";
import { configuredAdminEmails } from "@/lib/admin-emails";

export const DEFAULT_CREDENTIAL_TTL_HOURS = 0.05;
export const MIN_CREDENTIAL_TTL_HOURS = 1 / 60;
export const MAX_CREDENTIAL_TTL_HOURS = 24;

export function credentialTtlMilliseconds(): number {
  const rawConfiguredTtl = process.env.CREDENTIAL_TTL_HOURS;
  const hours =
    rawConfiguredTtl === undefined
      ? DEFAULT_CREDENTIAL_TTL_HOURS
      : Number(rawConfiguredTtl.trim());

  if (
    !Number.isFinite(hours) ||
    hours < MIN_CREDENTIAL_TTL_HOURS ||
    hours > MAX_CREDENTIAL_TTL_HOURS
  ) {
    throw new RangeError(
      `CREDENTIAL_TTL_HOURS must be at least one minute and no more than ${MAX_CREDENTIAL_TTL_HOURS} hours.`,
    );
  }

  return hours * 60 * 60 * 1_000;
}

export function validateRuntimeConfiguration(): void {
  configuredAdminEmails();
  configuredGuestPasswordLength();
  credentialTtlMilliseconds();
}
