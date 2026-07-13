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
      data: { status: "occupied", lastHeartbeat: now },
    }),
    db.auditLog.create({
      data: { machineId: machine.id, event: "session_open" },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
