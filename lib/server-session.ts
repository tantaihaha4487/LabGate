import { auth, isAllowedInstitutionEmail } from "@/lib/auth";

export async function getInstitutionSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });

  if (!session || !isAllowedInstitutionEmail(session.user.email)) {
    return null;
  }

  return session;
}
