import { db } from "@/lib/db/client";
import { isAllowedInstitutionEmail } from "@/lib/auth";
import { credentialTtlMilliseconds } from "@/lib/config";
import { Prisma } from "@/lib/generated/prisma/client";
import { heartbeatEligibilityWindow } from "@/lib/machine-liveness";
import { generateGuestPassword } from "@/lib/password";
import {
  provisionMachine,
  revokeMachine,
  type ProvisionCredential,
  type ProvisionTarget,
} from "@/lib/provision";

type ProvisionFunction = (
  machine: ProvisionTarget,
  credential: ProvisionCredential,
) => Promise<void>;

type RevokeFunction = (
  machine: ProvisionTarget,
  credentialId: string,
) => Promise<void>;

interface CheckoutOptions {
  machineId: string;
  studentEmail: string;
  provision?: ProvisionFunction;
  revoke?: RevokeFunction;
  now?: Date;
}

interface FailedIssueCompensationOptions {
  error: unknown;
  machineId: string;
  password: string;
  reservation: {
    credential: { id: string };
    machine: ProvisionTarget;
  };
  revoke: RevokeFunction;
  studentEmail: string;
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

function errorDetail(error: unknown, sensitiveValues: string[] = []): string {
  let detail = error instanceof Error ? error.message : "Unknown error";

  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) {
      detail = detail.replaceAll(sensitiveValue, "[REDACTED]");
    }
  }

  return detail.slice(0, 500);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

async function compensateFailedIssue({
  error,
  machineId,
  password,
  reservation,
  revoke,
  studentEmail,
}: FailedIssueCompensationOptions): Promise<never> {
  const failedAt = new Date();
  let lockConfirmed = false;
  let lockError: unknown;
  let reservationIdentityStillCurrent = false;

  // Keep this generation current while the compensating SSH lock is in
  // flight. A conflicting machine report may have terminalized it during the
  // issue command; leaving it terminal would let a different hold clear and
  // advertise the machine while this password could still be pending locally.
  // An immediate expiry also lets the durable sweep retry the exact ID if this
  // request loses connectivity.
  try {
    reservationIdentityStillCurrent = await db.$transaction(
      async (transaction) => {
        const sameMachineIdentity = await transaction.machine.findFirst({
          where: {
            id: machineId,
            sshHostKeySha256: reservation.machine.sshHostKeySha256,
            tailscaleIp: reservation.machine.tailscaleIp,
          },
          select: { id: true },
        });
        if (!sameMachineIdentity) {
          return false;
        }

        const credential = await transaction.guestCredential.findUnique({
          where: { id: reservation.credential.id },
          select: { sessionOpenedAt: true },
        });
        if (!credential) {
          throw new Error("Issued credential disappeared before compensation.");
        }

        await transaction.guestCredential.update({
          where: { id: reservation.credential.id },
          data: {
            expiresAt: failedAt,
            revokedAt: null,
            machineStateVersion: credential.sessionOpenedAt === null ? 1 : 2,
          },
        });
        const held = await transaction.machine.updateMany({
          where: {
            id: machineId,
            sshHostKeySha256: reservation.machine.sshHostKeySha256,
            tailscaleIp: reservation.machine.tailscaleIp,
          },
          data: { status: "occupied" },
        });
        if (held.count !== 1) {
          throw new Error("Machine identity changed during issue compensation.");
        }
        return true;
      },
    );
  } catch (preparationError: unknown) {
    const identityStillMatches = await db.machine.findFirst({
      where: {
        id: machineId,
        sshHostKeySha256: reservation.machine.sshHostKeySha256,
        tailscaleIp: reservation.machine.tailscaleIp,
      },
      select: { id: true },
    });
    if (identityStillMatches) {
      throw preparationError;
    }
    reservationIdentityStillCurrent = false;
  }

  try {
    await revoke(reservation.machine, reservation.credential.id);
    lockConfirmed = true;
  } catch (compensationError: unknown) {
    lockError = compensationError;
  }

  await db.$transaction(async (transaction) => {
    let preservedDifferentSafetyHold = false;

    if (!reservationIdentityStillCurrent) {
      // A drained rekey is a hard identity boundary. The old target still gets
      // an exact best-effort lock, but its outcome cannot mutate the new row.
    } else if (lockConfirmed) {
      await transaction.guestCredential.updateMany({
        where: { id: reservation.credential.id, revokedAt: null },
        data: { revokedAt: failedAt, machineStateVersion: 3 },
      });
      const anotherCredential = await transaction.guestCredential.findFirst({
        where: { machineId, revokedAt: null },
        select: { id: true },
      });

      if (!anotherCredential) {
        await transaction.machine.updateMany({
          where: {
            id: machineId,
            status: "occupied",
            sshHostKeySha256: reservation.machine.sshHostKeySha256,
            tailscaleIp: reservation.machine.tailscaleIp,
            OR: [
              { safetyHoldCredentialId: null },
              { safetyHoldCredentialId: reservation.credential.id },
            ],
          },
          data: { status: "available", safetyHoldCredentialId: null },
        });
      }
    } else {
      await transaction.guestCredential.updateMany({
        where: { id: reservation.credential.id, revokedAt: null },
        data: { expiresAt: failedAt },
      });
      const held = await transaction.machine.updateMany({
        where: {
          id: machineId,
          sshHostKeySha256: reservation.machine.sshHostKeySha256,
          tailscaleIp: reservation.machine.tailscaleIp,
          OR: [
            { safetyHoldCredentialId: null },
            { safetyHoldCredentialId: reservation.credential.id },
          ],
        },
        data: {
          status: "occupied",
          safetyHoldCredentialId: reservation.credential.id,
        },
      });
      if (held.count === 0) {
        preservedDifferentSafetyHold = true;
        await transaction.machine.updateMany({
          where: {
            id: machineId,
            sshHostKeySha256: reservation.machine.sshHostKeySha256,
            tailscaleIp: reservation.machine.tailscaleIp,
          },
          data: { status: "occupied" },
        });
      }
    }

    await transaction.auditLog.create({
      data: {
        machineId,
        studentEmail,
        event: "provision_fail",
        detail: [
          `Credential issue failed: ${errorDetail(error, [password])}`,
          lockConfirmed
            ? reservationIdentityStillCurrent
              ? "Compensating generation lock confirmed."
              : "Old-target generation lock confirmed after machine rekey; replacement identity was not mutated."
            : [
                `Compensating lock pending: ${errorDetail(lockError)}`,
                !reservationIdentityStillCurrent
                  ? "Machine identity changed; replacement identity and old credential state were not mutated."
                  : preservedDifferentSafetyHold
                  ? "A different physical generation safety hold was preserved."
                  : "Ambiguous issued generation held for exact lock confirmation.",
              ].join(" "),
        ]
          .join(" ")
          .slice(0, 500),
      },
    });
  });

  throw new CheckoutError("Machine provisioning failed. Please retry.", 502);
}

export async function checkoutMachine({
  machineId,
  studentEmail,
  provision = provisionMachine,
  revoke = revokeMachine,
  now = new Date(),
}: CheckoutOptions): Promise<IssuedCredential> {
  if (!isAllowedInstitutionEmail(studentEmail)) {
    throw new CheckoutError("A university account is required.", 403);
  }

  const normalizedStudentEmail = studentEmail.toLowerCase();
  const expiresAt = new Date(now.getTime() + credentialTtlMilliseconds());
  const heartbeatWindow = heartbeatEligibilityWindow(now);
  const password = generateGuestPassword();

  let reservation: {
    credential: { id: string };
    machine: ProvisionTarget;
  };

  try {
    reservation = await db.$transaction(async (transaction) => {
      const activeCredential = await transaction.guestCredential.findFirst({
        where: {
          studentEmail: normalizedStudentEmail,
          revokedAt: null,
        },
        select: { id: true },
      });

      if (activeCredential) {
        throw new CheckoutError(
          "You already have a lab reservation or active session.",
          409,
        );
      }

      const claim = await transaction.machine.updateMany({
        where: {
          id: machineId,
          status: "available",
          sshHostKeySha256: { not: null },
          safetyHoldCredentialId: null,
          lastHeartbeat: {
            gte: heartbeatWindow.earliest,
            lte: heartbeatWindow.latest,
          },
        },
        data: { status: "occupied", safetyHoldCredentialId: null },
      });

      if (claim.count !== 1) {
        throw new CheckoutError("Machine is no longer available.", 409);
      }

      const machine = await transaction.machine.findUniqueOrThrow({
        where: { id: machineId },
        select: { sshHostKeySha256: true, tailscaleIp: true },
      });
      if (machine.sshHostKeySha256 === null) {
        throw new CheckoutError("Machine is not securely enrolled.", 409);
      }
      const credential = await transaction.guestCredential.create({
        data: {
          machineId,
          studentEmail: normalizedStudentEmail,
          expiresAt,
        },
        select: { id: true },
      });

      await transaction.auditLog.create({
        data: {
          machineId,
          studentEmail: normalizedStudentEmail,
          event: "checkout",
        },
      });

      return {
        credential,
        machine: {
          sshHostKeySha256: machine.sshHostKeySha256,
          tailscaleIp: machine.tailscaleIp,
        },
      };
    });
  } catch (error: unknown) {
    if (error instanceof CheckoutError) {
      throw error;
    }
    if (isUniqueConstraintError(error)) {
      throw new CheckoutError(
        "You already have a lab reservation or the machine was just claimed.",
        409,
      );
    }
    throw error;
  }

  try {
    await provision(reservation.machine, {
      credentialId: reservation.credential.id,
      expiresAt,
      password,
    });
  } catch (error: unknown) {
    return compensateFailedIssue({
      error,
      machineId,
      password,
      reservation,
      revoke,
      studentEmail: normalizedStudentEmail,
    });
  }

  try {
    await db.$transaction(async (transaction) => {
      const machineReady = await transaction.machine.updateMany({
        where: {
          id: machineId,
          status: "occupied",
          sshHostKeySha256: reservation.machine.sshHostKeySha256,
          safetyHoldCredentialId: null,
        },
        data: { status: "occupied" },
      });
      const credentialReady = await transaction.guestCredential.updateMany({
        where: {
          id: reservation.credential.id,
          machineId,
          revokedAt: null,
          sessionOpenedAt: null,
          machineStateVersion: { lte: 1 },
        },
        data: { machineStateVersion: 1 },
      });

      if (machineReady.count !== 1 || credentialReady.count !== 1) {
        throw new Error(
          "Issued credential lost its pending generation reservation before disclosure.",
        );
      }

      await transaction.auditLog.create({
        data: {
          machineId,
          studentEmail: normalizedStudentEmail,
          event: "provision_ok",
        },
      });
    });
  } catch (error: unknown) {
    return compensateFailedIssue({
      error,
      machineId,
      password,
      reservation,
      revoke,
      studentEmail: normalizedStudentEmail,
    });
  }

  return {
    username: "guest",
    password,
    expiresAt: expiresAt.toISOString(),
  };
}
