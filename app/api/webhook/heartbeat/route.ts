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
      data: { lastHeartbeat: now },
    }),
    db.machine.updateMany({
      where: {
        id: machine.id,
        guestCredentials: { some: { revokedAt: null } },
      },
      data: { status: "occupied" },
    }),
    db.machine.updateMany({
      where: {
        id: machine.id,
        guestCredentials: { none: { revokedAt: null } },
      },
      data: { status: "available" },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
