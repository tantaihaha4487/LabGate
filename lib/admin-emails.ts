import {
  AdminEmailsConfigurationError,
  normalizeAdminEmail,
} from "@/lib/admin-email-validation";

export {
  AdminEmailsConfigurationError,
  normalizeAdminEmail,
} from "@/lib/admin-email-validation";

export function parseAdminEmails(
  rawValue: string | undefined,
  allowedDomain: string,
): string[] {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    throw new AdminEmailsConfigurationError(
      "ADMIN_EMAILS is required and must contain at least one administrator address.",
    );
  }

  const entries = rawValue.split(",");
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new AdminEmailsConfigurationError(
      "ADMIN_EMAILS must be a comma-separated list without empty entries.",
    );
  }

  return [
    ...new Set(
      entries.map((entry) => normalizeAdminEmail(entry, allowedDomain)),
    ),
  ];
}

export function configuredAdminEmails(): string[] {
  const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN;

  if (!allowedDomain?.trim()) {
    throw new AdminEmailsConfigurationError(
      "ALLOWED_EMAIL_DOMAIN is required before ADMIN_EMAILS can be validated.",
    );
  }

  return parseAdminEmails(process.env.ADMIN_EMAILS, allowedDomain);
}
