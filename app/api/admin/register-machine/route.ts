import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { machineEnrollmentProtocol } from "@/lib/machine-enrollment-protocol";
import {
  readBoundedJsonObject,
  RequestBodyError,
} from "@/lib/request-body";
import { hasValidBearerToken } from "@/lib/secure-bearer";
import { isValidSshHostKeySha256Fingerprint } from "@/lib/ssh-host-key";

export const runtime = "nodejs";

interface RegistrationBody {
  name?: unknown;
  sshHostKeySha256?: unknown;
  tailscaleIp?: unknown;
}

interface RekeyBody {
  expectedName?: unknown;
  expectedSshHostKeySha256?: unknown;
  expectedTailscaleIp?: unknown;
  machineId?: unknown;
  name?: unknown;
  sshHostKeySha256?: unknown;
  tailscaleIp?: unknown;
}

const MAX_REGISTRATION_BODY_BYTES = 4_096;

function isTailscaleIpv4(value: string): boolean {
  const parts = value.split(".");

  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))
  ) {
    return false;
  }

  const octets = parts.map(Number);

  return (
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ) &&
    octets.join(".") === value &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function identityConflictResponse() {
  return NextResponse.json(
    {
      error:
        "Machine name, Tailscale address, or SSH host-key pin identifies a different registration.",
    },
    { status: 409 },
  );
}

export async function GET(request: Request) {
  const expectedSecret = process.env.MACHINE_REGISTRATION_SECRET?.trim();

  if (!expectedSecret) {
    return NextResponse.json(
      {
        ok: false,
        ...machineEnrollmentProtocol,
        registrationReady: false,
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  if (!hasValidBearerToken(request.headers, expectedSecret)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      ...machineEnrollmentProtocol,
      registrationReady: true,
    },
    { headers: { "Cache-Control": "no-store" } },
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
    body =
      (await readBoundedJsonObject(request, MAX_REGISTRATION_BODY_BYTES)) ?? {};
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body.name !== "string" ||
    !/^[A-Za-z0-9._ -]{1,64}$/.test(body.name) ||
    typeof body.tailscaleIp !== "string" ||
    !isTailscaleIpv4(body.tailscaleIp) ||
    !isValidSshHostKeySha256Fingerprint(body.sshHostKeySha256)
  ) {
    return NextResponse.json(
      {
        error:
          "A valid machine name, Tailscale IPv4 address, and Ed25519 SHA256 SSH host-key fingerprint are required.",
      },
      { status: 400 },
    );
  }

  const matches = await db.machine.findMany({
    where: {
      OR: [
        { name: body.name },
        { tailscaleIp: body.tailscaleIp },
        { sshHostKeySha256: body.sshHostKeySha256 },
      ],
    },
    select: {
      id: true,
      name: true,
      sshHostKeySha256: true,
      tailscaleIp: true,
      webhookToken: true,
    },
    take: 2,
  });

  if (matches.length > 1) {
    return identityConflictResponse();
  }

  const existing = matches[0];
  let webhookToken: string;

  if (existing) {
    if (
      existing.name !== body.name ||
      existing.tailscaleIp !== body.tailscaleIp ||
      existing.sshHostKeySha256 !== body.sshHostKeySha256
    ) {
      return identityConflictResponse();
    }

    const current = await db.machine.findFirst({
      where: {
        id: existing.id,
        name: body.name,
        sshHostKeySha256: body.sshHostKeySha256,
        tailscaleIp: body.tailscaleIp,
      },
      select: { webhookToken: true },
    });

    if (!current) {
      return identityConflictResponse();
    }
    // Registration proves only possession of the enrollment secret. It is not
    // physical-state evidence and must never refresh checkout eligibility.
    webhookToken = current.webhookToken;
  } else {
    const candidateToken = randomBytes(32).toString("base64url");

    try {
      const created = await db.machine.create({
        data: {
          name: body.name,
          sshHostKeySha256: body.sshHostKeySha256,
          tailscaleIp: body.tailscaleIp,
          webhookToken: candidateToken,
          status: "offline",
          lastHeartbeat: null,
        },
        select: { webhookToken: true },
      });
      webhookToken = created.webhookToken;
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const concurrentlyCreated = await db.machine.findFirst({
        where: {
          name: body.name,
          sshHostKeySha256: body.sshHostKeySha256,
          tailscaleIp: body.tailscaleIp,
        },
        select: { id: true, webhookToken: true },
      });

      if (!concurrentlyCreated) {
        return identityConflictResponse();
      }

      webhookToken = concurrentlyCreated.webhookToken;
    }
  }

  return NextResponse.json(
    { webhookToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
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

  let body: RekeyBody;

  try {
    body =
      (await readBoundedJsonObject(request, MAX_REGISTRATION_BODY_BYTES)) ?? {};
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body.machineId !== "string" ||
    !/^[A-Za-z0-9_-]{10,64}$/.test(body.machineId) ||
    typeof body.expectedName !== "string" ||
    !/^[A-Za-z0-9._ -]{1,64}$/.test(body.expectedName) ||
    typeof body.expectedTailscaleIp !== "string" ||
    !isTailscaleIpv4(body.expectedTailscaleIp) ||
    !(
      body.expectedSshHostKeySha256 === null ||
      isValidSshHostKeySha256Fingerprint(body.expectedSshHostKeySha256)
    ) ||
    typeof body.name !== "string" ||
    !/^[A-Za-z0-9._ -]{1,64}$/.test(body.name) ||
    typeof body.tailscaleIp !== "string" ||
    !isTailscaleIpv4(body.tailscaleIp) ||
    !isValidSshHostKeySha256Fingerprint(body.sshHostKeySha256)
  ) {
    return NextResponse.json(
      {
        error:
          "A machine ID plus valid expected identity/pin and replacement identity/SSH host-key pin are required.",
      },
      { status: 400 },
    );
  }

  const replacementToken = randomBytes(32).toString("base64url");

  try {
    const result = await db.$transaction(async (transaction) => {
      const machine = await transaction.machine.findUnique({
        where: { id: body.machineId as string },
        select: {
          id: true,
          name: true,
          safetyHoldCredentialId: true,
          sshHostKeySha256: true,
          tailscaleIp: true,
          status: true,
        },
      });

      if (!machine) {
        return { status: "not_found" as const };
      }
      if (
        machine.name !== body.expectedName ||
        machine.tailscaleIp !== body.expectedTailscaleIp ||
        machine.sshHostKeySha256 !== body.expectedSshHostKeySha256
      ) {
        return { status: "identity_conflict" as const };
      }
      if (
        machine.status !== "available" ||
        machine.safetyHoldCredentialId !== null
      ) {
        return { status: "not_drained" as const };
      }

      const currentCredential = await transaction.guestCredential.findFirst({
        where: { machineId: machine.id, revokedAt: null },
        select: { id: true },
      });
      if (currentCredential) {
        return { status: "not_drained" as const };
      }

      const updated = await transaction.machine.updateMany({
        where: {
          id: machine.id,
          name: machine.name,
          sshHostKeySha256: machine.sshHostKeySha256,
          tailscaleIp: machine.tailscaleIp,
          status: "available",
          safetyHoldCredentialId: null,
        },
        data: {
          name: body.name as string,
          sshHostKeySha256: body.sshHostKeySha256 as string,
          tailscaleIp: body.tailscaleIp as string,
          webhookToken: replacementToken,
          status: "offline",
          lastHeartbeat: null,
          safetyHoldCredentialId: null,
        },
      });
      if (updated.count !== 1) {
        return { status: "not_drained" as const };
      }

      await transaction.auditLog.create({
        data: {
          machineId: machine.id,
          event: "machine_rekey",
          detail: `Drained machine identity and SSH host-key pin changed from ${machine.name} (${machine.tailscaleIp}) to ${body.name as string} (${body.tailscaleIp as string}); webhook token rotated and machine held offline pending a safe heartbeat.`,
        },
      });

      return { machineId: machine.id, status: "rekeyed" as const };
    });

    if (result.status === "not_found") {
      return NextResponse.json({ error: "Machine not found." }, { status: 404 });
    }
    if (result.status === "identity_conflict") {
      return identityConflictResponse();
    }
    if (result.status === "not_drained") {
      return NextResponse.json(
        {
          error:
            "Machine rekey requires an available machine with no current credential.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        machineId: result.machineId,
        name: body.name,
        sshHostKeySha256: body.sshHostKeySha256,
        tailscaleIp: body.tailscaleIp,
        webhookToken: replacementToken,
        status: "offline",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      return identityConflictResponse();
    }
    throw error;
  }
}
