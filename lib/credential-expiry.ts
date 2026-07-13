import { db } from "@/lib/db/client";
import {
  revokeMachine,
  type ProvisionTarget,
} from "@/lib/provision";

const RECENT_HEARTBEAT_WINDOW_MS = 2 * 60 * 1000;

type RevokeFunction = (machine: ProvisionTarget) => Promise<void>;

export interface CredentialExpiryResult {
  status: "released" | "already_released" | "retry";
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

function hasRecentHeartbeat(lastHeartbeat: Date | null, now: Date): boolean {
  return (
    lastHeartbeat !== null &&
    lastHeartbeat.getTime() >= now.getTime() - RECENT_HEARTBEAT_WINDOW_MS
  );
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
      },
      select: {
        machineId: true,
        studentEmail: true,
      },
    });

    if (!credential) {
      return { status: "already_released", releasedMachine: false };
    }

    const revoked = await transaction.guestCredential.updateMany({
      where: {
        id: credentialId,
        revokedAt: null,
        expiresAt: { lte: now },
      },
      data: { revokedAt: now },
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
        where: { id: credential.machineId },
        data: { status: "available" },
      });
      releasedMachine = released.count === 1;
    }

    await transaction.auditLog.create({
      data: {
        machineId: credential.machineId,
        studentEmail: credential.studentEmail,
        event: "force_revoke",
        detail: detail.slice(0, 500),
      },
    });

    return { status: "released", releasedMachine };
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
          lastHeartbeat: true,
          tailscaleIp: true,
        },
      },
    },
  });

  if (!credential) {
    return { status: "already_released", releasedMachine: false };
  }

  if (hasRecentHeartbeat(credential.machine.lastHeartbeat, now)) {
    try {
      await revoke(credential.machine);
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

  return finalizeExpiredCredential({
    credentialId,
    now,
    detail:
      "Expired credential recovered after heartbeat timeout; the local persistent cleanup timer enforces the account lock.",
  });
}
