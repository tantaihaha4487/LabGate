import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { hasValidBearerToken } from "@/lib/secure-bearer";

export const runtime = "nodejs";

interface RegistrationBody {
  name?: unknown;
  tailscaleIp?: unknown;
}

function isTailscaleIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);

  return (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ) &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

export async function POST(request: Request) {
  const expectedSecret = process.env.MACHINE_REGISTRATION_SECRET?.trim();

  if (!expectedSecret) {
    return NextResponse.json(
      { error: "Machine registration is not configured." },
      { status: 503 },
    );
  }

  if (!hasValidBearerToken(request.headers, expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RegistrationBody;

  try {
    body = (await request.json()) as RegistrationBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body.name !== "string" ||
    !/^[A-Za-z0-9._ -]{1,64}$/.test(body.name) ||
    typeof body.tailscaleIp !== "string" ||
    !isTailscaleIpv4(body.tailscaleIp)
  ) {
    return NextResponse.json(
      { error: "A valid machine name and Tailscale IPv4 address are required." },
      { status: 400 },
    );
  }

  const webhookToken = randomBytes(32).toString("base64url");
  const existing = await db.machine.findFirst({
    where: {
      OR: [{ name: body.name }, { tailscaleIp: body.tailscaleIp }],
    },
    select: { id: true },
  });

  if (existing) {
    await db.machine.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        tailscaleIp: body.tailscaleIp,
        webhookToken,
        status: "available",
        lastHeartbeat: new Date(),
      },
    });
  } else {
    await db.machine.create({
      data: {
        name: body.name,
        tailscaleIp: body.tailscaleIp,
        webhookToken,
        status: "available",
        lastHeartbeat: new Date(),
      },
    });
  }

  return NextResponse.json(
    { webhookToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}
