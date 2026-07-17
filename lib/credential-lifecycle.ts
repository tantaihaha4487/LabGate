import { db } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  mergeSafetyHold,
  mergeUnsafeGenerations,
  reconcileFreshActiveHold,
} from "@/lib/safety-hold";

export type CredentialActivationStatus =
  | "activated"
  | "already_active"
  | "conflict"
  | "not_found"
  | "stale"
  | "unauthorized";

export type CredentialClosureStatus =
  | "closed"
  | "already_closed"
  | "not_found"
  | "unauthorized";

interface ActivateCredentialOptions {
  machineId: string;
  credentialId: string;
  stateVersion: 2;
  webhookToken: string;
  now?: Date;
  source: "session-open" | "heartbeat";
}

interface CloseCredentialOptions {
  allowHeartbeatSafeReleaseOnDuplicate?: boolean;
  machineId: string;
  credentialId: string;
  stateVersion: 3;
  webhookToken: string;
  now?: Date;
  event: "session_close" | "force_revoke";
  passwordTimeout?: boolean;
  detail: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

async function recordUnsafeActiveReport(
  machineId: string,
  credentialId: string,
  webhookToken: string,
  now: Date,
  detail: string,
): Promise<boolean> {
  return db.$transaction(async (transaction) => {
    const authenticatedMachine = await transaction.machine.findFirst({
      where: { id: machineId, webhookToken },
      select: { safetyHoldCredentialId: true },
    });
    if (!authenticatedMachine) {
      return false;
    }

    const currentCredentials = await transaction.guestCredential.findMany({
      where: { machineId, revokedAt: null },
      select: { id: true },
    });

    await transaction.guestCredential.updateMany({
      where: { machineId, revokedAt: null },
      data: { revokedAt: now, machineStateVersion: 3 },
    });
    await transaction.machine.update({
      where: { id: machineId },
      data: {
        status: "occupied",
        lastHeartbeat: now,
        safetyHoldCredentialId: mergeUnsafeGenerations(
          authenticatedMachine.safetyHoldCredentialId,
          currentCredentials.map(({ id }) => id),
          credentialId,
        ),
      },
    });
    await transaction.auditLog.create({
      data: {
        machineId,
        event: "session_open",
        detail: detail.slice(0, 500),
      },
    });
    return true;
  });
}

export async function activateMachineCredential({
  machineId,
  credentialId,
  stateVersion,
  now = new Date(),
  source,
  webhookToken,
}: ActivateCredentialOptions): Promise<CredentialActivationStatus> {
  try {
    return await db.$transaction(async (transaction) => {
      const authenticatedMachine = await transaction.machine.findFirst({
        where: { id: machineId, webhookToken },
        select: { safetyHoldCredentialId: true },
      });
      if (!authenticatedMachine) {
        return "unauthorized";
      }

      const credential = await transaction.guestCredential.findFirst({
        where: { id: credentialId, machineId },
        select: {
          studentEmail: true,
          revokedAt: true,
          sessionOpenedAt: true,
          machineStateVersion: true,
        },
      });

      if (!credential) {
        const currentCredentials = await transaction.guestCredential.findMany({
          where: { machineId, revokedAt: null },
          select: { id: true },
        });
        await transaction.guestCredential.updateMany({
          where: { machineId, revokedAt: null },
          data: { revokedAt: now, machineStateVersion: 3 },
        });
        await transaction.machine.update({
          where: { id: machineId },
          data: {
            status: "occupied",
            lastHeartbeat: now,
            safetyHoldCredentialId: mergeUnsafeGenerations(
              authenticatedMachine.safetyHoldCredentialId,
              currentCredentials.map(({ id }) => id),
              credentialId,
            ),
          },
        });
        await transaction.auditLog.create({
          data: {
            machineId,
            event: "session_open",
            detail: `${source} reported an unknown credential generation; machine held occupied.`,
          },
        });
        return "not_found";
      }

      if (credential.machineStateVersion >= stateVersion) {
        const isExactCurrentActive =
          credential.machineStateVersion === stateVersion &&
          credential.revokedAt === null;

        if (isExactCurrentActive) {
          await transaction.machine.update({
            where: { id: machineId },
            data: {
              status: "occupied",
              lastHeartbeat: now,
              safetyHoldCredentialId:
                source === "heartbeat"
                  ? reconcileFreshActiveHold(
                      authenticatedMachine.safetyHoldCredentialId,
                      credentialId,
                    )
                  : undefined,
            },
          });
        } else {
          const currentCredentials = await transaction.guestCredential.findMany({
            where: { machineId, revokedAt: null },
            select: { id: true },
          });
          await transaction.guestCredential.updateMany({
            where: { machineId, revokedAt: null },
            data: { revokedAt: now, machineStateVersion: 3 },
          });
          await transaction.machine.update({
            where: { id: machineId },
            data: {
              status: "occupied",
              lastHeartbeat: now,
              safetyHoldCredentialId: mergeUnsafeGenerations(
                authenticatedMachine.safetyHoldCredentialId,
                currentCredentials.map(({ id }) => id),
                credentialId,
              ),
            },
          });
          await transaction.auditLog.create({
            data: {
              machineId,
              event: "session_open",
              detail: `${source} reported a terminal or stale credential generation as physically active; current database credentials were terminalized and the reported generation is held for fresh safety confirmation.`,
            },
          });
        }
        return isExactCurrentActive &&
          credential.sessionOpenedAt !== null
          ? "already_active"
          : "stale";
      }

      const activated = await transaction.guestCredential.updateMany({
        where: {
          id: credentialId,
          machineId,
          machineStateVersion: { lt: stateVersion },
        },
        data: {
          revokedAt: null,
          sessionOpenedAt: credential.sessionOpenedAt ?? now,
          machineStateVersion: stateVersion,
        },
      });

      if (activated.count !== 1) {
        const currentCredentials = await transaction.guestCredential.findMany({
          where: { machineId, revokedAt: null },
          select: { id: true },
        });
        await transaction.guestCredential.updateMany({
          where: { machineId, revokedAt: null },
          data: { revokedAt: now, machineStateVersion: 3 },
        });
        await transaction.machine.update({
          where: { id: machineId },
          data: {
            status: "occupied",
            lastHeartbeat: now,
            safetyHoldCredentialId: mergeUnsafeGenerations(
              authenticatedMachine.safetyHoldCredentialId,
              currentCredentials.map(({ id }) => id),
              credentialId,
            ),
          },
        });
        return "stale";
      }

      await transaction.machine.update({
        where: { id: machineId },
        data: {
          status: "occupied",
          lastHeartbeat: now,
          safetyHoldCredentialId:
            source === "heartbeat"
              ? reconcileFreshActiveHold(
                  authenticatedMachine.safetyHoldCredentialId,
                  credentialId,
                )
              : mergeSafetyHold(
                  authenticatedMachine.safetyHoldCredentialId,
                  credentialId,
                ),
        },
      });
      await transaction.auditLog.create({
        data: {
          machineId,
          studentEmail: credential.studentEmail,
          event: "session_open",
          detail:
            credential.revokedAt === null
              ? `${source} confirmed the physical guest session.`
              : `${source} restored a credential generation after delayed connectivity.`,
        },
      });
      return "activated";
    });
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const recorded = await recordUnsafeActiveReport(
      machineId,
      credentialId,
      webhookToken,
      now,
      `${source} reported a stale credential generation that conflicts with a newer reservation; machine held occupied.`,
    );
    return recorded ? "conflict" : "unauthorized";
  }
}

export async function closeMachineCredential({
  allowHeartbeatSafeReleaseOnDuplicate = false,
  machineId,
  credentialId,
  stateVersion,
  now = new Date(),
  event,
  passwordTimeout = false,
  detail,
  webhookToken,
}: CloseCredentialOptions): Promise<CredentialClosureStatus> {
  return db.$transaction(async (transaction) => {
    const machine = await transaction.machine.findFirst({
      where: { id: machineId, webhookToken },
      select: { safetyHoldCredentialId: true },
    });
    if (!machine) {
      return "unauthorized";
    }
    const credential = await transaction.guestCredential.findFirst({
      where: { id: credentialId, machineId },
      select: {
        studentEmail: true,
        machineStateVersion: true,
      },
    });

    if (!credential) {
      const confirmsSafetyHold = machine.safetyHoldCredentialId === credentialId;
      const currentCredential =
        allowHeartbeatSafeReleaseOnDuplicate || confirmsSafetyHold
          ? await transaction.guestCredential.findFirst({
              where: { machineId, revokedAt: null },
              select: { id: true },
            })
          : null;
      const freshHeartbeatCanRelease =
        allowHeartbeatSafeReleaseOnDuplicate && !currentCredential;

      await transaction.machine.update({
        where: { id: machineId },
        data: freshHeartbeatCanRelease
          ? {
              status: "available",
              lastHeartbeat: now,
              safetyHoldCredentialId: null,
            }
          : confirmsSafetyHold
            ? {
                status: currentCredential ? "occupied" : "available",
                lastHeartbeat: now,
                safetyHoldCredentialId: null,
              }
            : currentCredential
              ? { status: "occupied", lastHeartbeat: now }
              : { lastHeartbeat: now },
      });
      await transaction.auditLog.create({
        data: {
          machineId,
          event,
          detail: freshHeartbeatCanRelease
            ? "Fresh heartbeat confirmed a locked, session-free machine with no current credential; all physical-generation holds were cleared."
            : confirmsSafetyHold
              ? "Terminal machine report confirmed the exact unknown generation held for safety; the hold was cleared."
              : "Ignored a queued machine report for an unknown credential generation.",
        },
      });
      return freshHeartbeatCanRelease || confirmsSafetyHold
        ? "closed"
        : "not_found";
    }

    const revoked = await transaction.guestCredential.updateMany({
      where: {
        id: credentialId,
        machineId,
        machineStateVersion: { lt: stateVersion },
      },
      data: { revokedAt: now, machineStateVersion: stateVersion },
    });
    if (revoked.count === 1) {
      const anotherCredential = await transaction.guestCredential.findFirst({
        where: {
          machineId,
          revokedAt: null,
        },
        select: { id: true },
      });

      const freshHeartbeatCanRelease =
        allowHeartbeatSafeReleaseOnDuplicate && !anotherCredential;
      const remainingHold = freshHeartbeatCanRelease
        ? null
        : machine.safetyHoldCredentialId === credentialId
          ? null
          : machine.safetyHoldCredentialId;

      await transaction.machine.update({
        where: { id: machineId },
        data: {
          status:
            anotherCredential || remainingHold !== null
              ? "occupied"
              : "available",
          lastHeartbeat: now,
          safetyHoldCredentialId: remainingHold,
        },
      });
      await transaction.auditLog.create({
        data: {
          machineId,
          studentEmail: credential.studentEmail,
          event,
          detail: detail.slice(0, 500),
        },
      });
      if (passwordTimeout) {
        await transaction.auditLog.create({
          data: {
            machineId,
            studentEmail: credential.studentEmail,
            event: "password_timeout",
            detail: "The issued password timed out before a physical session opened.",
          },
        });
      }
      return "closed";
    }

    if (allowHeartbeatSafeReleaseOnDuplicate) {
      // Unlike a queued close, a heartbeat is a fresh complete snapshot. A
      // locked, session-free report can clear even a multi-generation hold,
      // but never around a newer current reservation.
      const currentCredential = await transaction.guestCredential.findFirst({
        where: { machineId, revokedAt: null },
        select: { id: true },
      });

      await transaction.machine.update({
        where: { id: machineId },
        data: currentCredential
          ? { status: "occupied", lastHeartbeat: now }
          : {
              status: "available",
              lastHeartbeat: now,
              safetyHoldCredentialId: null,
            },
      });
    } else if (machine.safetyHoldCredentialId === credentialId) {
      const currentCredential = await transaction.guestCredential.findFirst({
        where: { machineId, revokedAt: null },
        select: { id: true },
      });
      await transaction.machine.update({
        where: { id: machineId },
        data: {
          status: currentCredential ? "occupied" : "available",
          lastHeartbeat: now,
          safetyHoldCredentialId: null,
        },
      });
    } else {
      // A duplicate terminal report confirms only this historical generation.
      // It cannot release a quarantine held for a different physical
      // generation.
      await transaction.machine.update({
        where: { id: machineId },
        data: { lastHeartbeat: now },
      });
    }
    return "already_closed";
  });
}
