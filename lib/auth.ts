import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "@/lib/db/client";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const allowedEmailDomain = requiredEnvironment(
  "ALLOWED_EMAIL_DOMAIN",
)
  .replace(/^@/, "")
  .toLowerCase();

export function isAllowedInstitutionEmail(
  email: string | null | undefined,
): email is string {
  return email?.toLowerCase().endsWith(`@${allowedEmailDomain}`) ?? false;
}

export function assertAllowedInstitutionEmail(
  email: string | null | undefined,
): asserts email is string {
  if (!isAllowedInstitutionEmail(email)) {
    throw new APIError("FORBIDDEN", {
      message: `Sign-in is restricted to @${allowedEmailDomain} accounts.`,
    });
  }
}

export async function enforceNewUserDomain<T extends { email: string }>(
  user: T,
) {
  assertAllowedInstitutionEmail(user.email);
  return { data: user };
}

export const auth = betterAuth({
  appName: "LabGate",
  baseURL: requiredEnvironment("BETTER_AUTH_URL"),
  secret: requiredEnvironment("BETTER_AUTH_SECRET"),
  database: prismaAdapter(db, {
    provider: "sqlite",
  }),
  socialProviders: {
    google: {
      clientId: requiredEnvironment("GOOGLE_CLIENT_ID"),
      clientSecret: requiredEnvironment("GOOGLE_CLIENT_SECRET"),
      hd: allowedEmailDomain,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: enforceNewUserDomain,
      },
    },
    session: {
      create: {
        before: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          });

          assertAllowedInstitutionEmail(user?.email);
          return { data: session };
        },
        after: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          });

          if (isAllowedInstitutionEmail(user?.email)) {
            await db.auditLog.create({
              data: {
                studentEmail: user.email,
                event: "login",
              },
            });
          }
        },
      },
    },
  },
});
