import { db } from "@/lib/db/client";

export async function authenticateWebhookMachine(headers: Headers) {
  const authorization = headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length);

  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return null;
  }

  return db.machine.findUnique({
    where: { webhookToken: token },
    select: { id: true, webhookToken: true },
  });
}
