import { NextResponse } from "next/server";
import { expireCredential } from "@/lib/credential-expiry";
import { db } from "@/lib/db/client";
import {
  readBoundedJsonObject,
  RequestBodyError,
} from "@/lib/request-body";
import { getInstitutionSession } from "@/lib/server-session";

export const runtime = "nodejs";

interface ExpireCheckoutBody {
  machineId?: unknown;
}

const MAX_EXPIRE_BODY_BYTES = 2_048;

export async function POST(request: Request) {
  const session = await getInstitutionSession(request.headers);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ExpireCheckoutBody;

  try {
    body =
      (await readBoundedJsonObject(request, MAX_EXPIRE_BODY_BYTES)) ?? {};
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.machineId !== "string" || body.machineId.length === 0) {
    return NextResponse.json({ error: "machineId is required." }, { status: 400 });
  }

  const now = new Date();
  const credential = await db.guestCredential.findFirst({
    where: {
      machineId: body.machineId,
      studentEmail: session.user.email.toLowerCase(),
      revokedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  if (!credential) {
    const machine = await db.machine.findUnique({
      where: { id: body.machineId },
      select: { safetyHoldCredentialId: true },
    });

    return NextResponse.json(
      {
        ok: true,
        status: machine?.safetyHoldCredentialId ? "held" : "already_released",
        serverTime: now.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (credential.expiresAt > now) {
    return NextResponse.json(
      {
        error: "Credential has not expired yet.",
        expiresAt: credential.expiresAt.toISOString(),
        serverTime: now.toISOString(),
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await expireCredential({
    credentialId: credential.id,
    now,
  });

  if (result.status === "retry") {
    return NextResponse.json(
      {
        error: "The guest account lock is still pending.",
        status: result.status,
        serverTime: now.toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, status: result.status, serverTime: now.toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
