import { configuredAdminEmails } from "@/lib/admin-emails";
import { auth, isAllowedInstitutionEmail } from "@/lib/auth";

export type AdminAuthorizationStatus =
  | "unauthenticated"
  | "forbidden"
  | "authorized";

export function adminPageRedirectForAuthorization(
  status: AdminAuthorizationStatus,
): "/login" | "/" | null {
  if (status === "unauthenticated") {
    return "/login";
  }

  return status === "forbidden" ? "/" : null;
}

export function isConfiguredAdminEmail(
  email: string | null | undefined,
): email is string {
  if (!isAllowedInstitutionEmail(email)) {
    return false;
  }

  return configuredAdminEmails().includes(email.toLowerCase());
}

export async function getAdminAuthorization(headers: Headers) {
  const session = await auth.api.getSession({ headers });

  if (!session) {
    return { status: "unauthenticated" as const };
  }

  if (!isConfiguredAdminEmail(session.user.email)) {
    return { status: "forbidden" as const };
  }

  return {
    status: "authorized" as const,
    adminEmail: session.user.email.toLowerCase(),
    session,
  };
}
