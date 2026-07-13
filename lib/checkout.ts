import { db } from "@/lib/db/client";
import { isAllowedInstitutionEmail } from "@/lib/auth";
import { generateGuestPassword } from "@/lib/password";
import {
  provisionMachine,
  type ProvisionTarget,
} from "@/lib/provision";

const OFFLINE_AFTER_MS = 2 * 60 * 1000;

type ProvisionFunction = (
  machine: ProvisionTarget,
  password: string,
) => Promise<void>;

interface CheckoutOptions {
  machineId: string;
  studentEmail: string;
  provision?: ProvisionFunction;
  now?: Date;
}

export interface IssuedCredential {
  username: "guest";
  password: string;
  expiresAt: string;
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

function credentialTtlMilliseconds(): number {
  const hours = Number(
    process.env.CREDENTIAL_TTL_HOURS ?? "0.08333333333333333",
  );

  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error("CREDENTIAL_TTL_HOURS must be between 0 and 24.");
  }

  return hours * 60 * 60 * 1000;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

export async function checkoutMachine({
  machineId,
  studentEmail,
  provision = provisionMachine,
  now = new Date(),
}: CheckoutOptions): Promise<IssuedCredential> {
  if (!isAllowedInstitutionEmail(studentEmail)) {
    throw new CheckoutError("A university account is required.", 403);
  }

  const activeCredential = await db.guestCredential.findFirst({
    where: {
      studentEmail,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });

  if (activeCredential) {
    throw new CheckoutError("You already have an active lab credential.", 409);
  }

  const expiresAt = new Date(now.getTime() + credentialTtlMilliseconds());
  const heartbeatCutoff = new Date(now.getTime() - OFFLINE_AFTER_MS);

  const reservation = await db.$transaction(async (transaction) => {
    const claim = await transaction.machine.updateMany({
      where: {
        id: machineId,
        status: "available",
        lastHeartbeat: { gte: heartbeatCutoff },
      },
      data: { status: "occupied" },
    });

    if (claim.count !== 1) {
      throw new CheckoutError("Machine is no longer available.", 409);
    }

    const machine = await transaction.machine.findUniqueOrThrow({
      where: { id: machineId },
      select: { id: true, tailscaleIp: true },
    });
    const password = generateGuestPassword();
    const credential = await transaction.guestCredential.create({
      data: {
        machineId,
        studentEmail,
        expiresAt,
      },
      select: { id: true },
    });

    await transaction.auditLog.create({
      data: {
        machineId,
        studentEmail,
        event: "checkout",
      },
    });

    return { credential, machine, password };
  });

  try {
    await provision(reservation.machine, reservation.password);
  } catch (error: unknown) {
    await db.$transaction([
      db.machine.updateMany({
        where: { id: machineId, status: "occupied" },
        data: { status: "available" },
      }),
      db.guestCredential.update({
        where: { id: reservation.credential.id },
        data: { revokedAt: new Date() },
      }),
      db.auditLog.create({
        data: {
          machineId,
          studentEmail,
          event: "provision_fail",
          detail: errorDetail(error),
        },
      }),
    ]);

    throw new CheckoutError("Machine provisioning failed. Please retry.", 502);
  }

  await db.auditLog.create({
    data: {
      machineId,
      studentEmail,
      event: "provision_ok",
    },
  });

  return {
    username: "guest",
    password: reservation.password,
    expiresAt: expiresAt.toISOString(),
  };
}
