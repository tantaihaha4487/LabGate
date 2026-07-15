const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const LOCAL_PART_PATTERN =
  /^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]*[a-z0-9])?$/i;

export class AdminEmailsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminEmailsConfigurationError";
  }
}

function normalizedDomain(allowedDomain: string): string {
  return allowedDomain.trim().replace(/^@/, "").toLowerCase();
}

export function normalizeAdminEmail(
  value: string,
  allowedDomain: string,
): string {
  const email = value.trim().toLowerCase();
  const domain = normalizedDomain(allowedDomain);
  const parts = email.split("@");
  const localPart = parts[0] ?? "";

  if (
    email.length > MAX_EMAIL_LENGTH ||
    parts.length !== 2 ||
    localPart.length === 0 ||
    localPart.length > MAX_LOCAL_PART_LENGTH ||
    localPart.includes("..") ||
    !LOCAL_PART_PATTERN.test(localPart) ||
    parts[1] !== domain
  ) {
    throw new AdminEmailsConfigurationError(
      `Administrator addresses must be valid @${domain} email addresses.`,
    );
  }

  return email;
}
