import { db } from "@/lib/db/client";
import {
  revokeMachine,
  type ProvisionTarget,
} from "@/lib/provision";

type RevokeFunction = (
  machine: ProvisionTarget,
  credentialId: string,
) => Promise<void>;

export interface CredentialExpiryResult {
  status: "released" | "held" | "already_released" | "active" | "retry";
  releasedMachine: boolean;
}

interface ExpireCredentialOptions {
  credentialId: string;
  now?: Date;
  revoke?: RevokeFunction;
}

interface FinalizeCredentialOptions {
  credentialId: string;
  now: Date;
  detail: string;
}

export async function finalizeExpiredCredential({
  credentialId,
  now,
  detail,
}: FinalizeCredentialOptions): Promise<CredentialExpiryResult> {
  return db.$transaction(async (transaction) => {
    const credential = await transaction.guestCredential.findFirst({
      where: {
        id: credentialId,
        revokedAt: null,
        expiresAt: { lte: now },
        sessionOpenedAt: null,
      },
      select: {
        machine: {
          select: {
            safetyHoldCredentialId: true,
            sshHostKeySha256: true,
          },
        },
        machineId: true,
        studentEmail: true,
      },
    });

    if (!credential) {
      const activeCredential = await transaction.guestCredential.findFirst({
        where: {
          id: credentialId,
          revokedAt: null,
          sessionOpenedAt: { not: null },
        },
        select: { id: true },
      });

      if (activeCredential) {
        return { status: "active", releasedMachine: false };
      }

      return { status: "already_released", releasedMachine: false };
    }

    const revoked = await transaction.guestCredential.updateMany({
      where: {
        id: credentialId,
        revokedAt: null,
        expiresAt: { lte: now },
        sessionOpenedAt: null,
      },
      data: { revokedAt: now, machineStateVersion: 3 },
    });

    if (revoked.count !== 1) {
      return { status: "already_released", releasedMachine: false };
    }

    const anotherCredential = await transaction.guestCredential.findFirst({
      where: {
        machineId: credential.machineId,
        revokedAt: null,
      },
      select: { id: true },
    });
    let releasedMachine = false;

    if (!anotherCredential) {
      const released = await transaction.machine.updateMany({
        where: {
          id: credential.machineId,
          sshHostKeySha256: { not: null },
          OR: [
            { safetyHoldCredentialId: null },
            { safetyHoldCredentialId: credentialId },
          ],
        },
        data: { status: "available", safetyHoldCredentialId: null },
      });
      releasedMachine = released.count === 1;
      if (!releasedMachine && credential.machine.sshHostKeySha256 === null) {
        await transaction.machine.updateMany({
          where: {
            id: credential.machineId,
            sshHostKeySha256: null,
            OR: [
              { safetyHoldCredentialId: null },
              { safetyHoldCredentialId: credentialId },
            ],
          },
          data: { status: "offline", safetyHoldCredentialId: null },
        });
      }
    }

    await transaction.auditLog.create({
      data: {
        machineId: credential.machineId,
        studentEmail: credential.studentEmail,
        event: "force_revoke",
        detail: detail.slice(0, 500),
      },
    });

    return {
      status: releasedMachine ? "released" : "held",
      releasedMachine,
    };
  });
}

export async function expireCredential({
  credentialId,
  now = new Date(),
  revoke = revokeMachine,
}: ExpireCredentialOptions): Promise<CredentialExpiryResult> {
  const credential = await db.guestCredential.findFirst({
    where: {
      id: credentialId,
      revokedAt: null,
      expiresAt: { lte: now },
    },
    select: {
      machine: {
        select: {
          sshHostKeySha256: true,
          tailscaleIp: true,
        },
      },
      sessionOpenedAt: true,
    },
  });

  if (!credential) {
    return { status: "already_released", releasedMachine: false };
  }

  if (credential.sessionOpenedAt) {
    return { status: "active", releasedMachine: false };
  }

  if (credential.machine.sshHostKeySha256 === null) {
    return { status: "retry", releasedMachine: false };
  }

  try {
    await revoke(
      {
        sshHostKeySha256: credential.machine.sshHostKeySha256,
        tailscaleIp: credential.machine.tailscaleIp,
      },
      credentialId,
    );
  } catch (error: unknown) {
    console.error("Could not lock expired guest credential", error);
    return { status: "retry", releasedMachine: false };
  }

  return finalizeExpiredCredential({
    credentialId,
    now,
    detail: "Expired credential locked over SSH before machine release.",
  });
}
