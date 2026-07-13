import { NextResponse } from "next/server";
import { finalizeExpiredCredential } from "@/lib/credential-expiry";
import { db } from "@/lib/db/client";
import { authenticateWebhookMachine } from "@/lib/webhook-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const machine = await authenticateWebhookMachine(request.headers);

  if (!machine) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const unexpiredCredential = await db.guestCredential.findFirst({
    where: {
      machineId: machine.id,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });

  if (unexpiredCredential) {
    return NextResponse.json(
      { error: "The current credential has not expired yet." },
      { status: 409 },
    );
  }

  const expiredCredentials = await db.guestCredential.findMany({
    where: {
      machineId: machine.id,
      revokedAt: null,
      expiresAt: { lte: now },
    },
    select: { id: true },
  });
  let revokedCredentials = 0;

  for (const credential of expiredCredentials) {
    const result = await finalizeExpiredCredential({
      credentialId: credential.id,
      now,
      detail: "Local cleanup timer locked the expired guest credential.",
    });

    if (result.status === "released") {
      revokedCredentials += 1;
    }
  }

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

  return NextResponse.json(
    { ok: true, revokedCredentials },
    { headers: { "Cache-Control": "no-store" } },
  );
}
