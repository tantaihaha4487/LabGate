import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { authenticateWebhookMachine } from "@/lib/webhook-auth";

export async function POST(request: Request) {
  const machine = await authenticateWebhookMachine(request.headers);

  if (!machine) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  await db.$transaction([
    db.machine.update({
      where: { id: machine.id },
      data: { status: "available", lastHeartbeat: now },
    }),
    db.guestCredential.updateMany({
      where: { machineId: machine.id, revokedAt: null },
      data: { revokedAt: now },
    }),
    db.auditLog.create({
      data: { machineId: machine.id, event: "session_close" },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
