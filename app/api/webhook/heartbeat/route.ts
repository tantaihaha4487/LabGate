import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { authenticateWebhookMachine } from "@/lib/webhook-auth";

export async function POST(request: Request) {
  const machine = await authenticateWebhookMachine(request.headers);

  if (!machine) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const activeCredential = await db.guestCredential.findFirst({
    where: {
      machineId: machine.id,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });

  await db.machine.update({
    where: { id: machine.id },
    data: {
      lastHeartbeat: now,
      status: activeCredential ? "occupied" : "available",
    },
  });

  return NextResponse.json({ ok: true });
}
