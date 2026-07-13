import { db } from "@/lib/db/client";

const RECENT_ACTIVITY_WINDOW_MS = 2 * 60 * 1000;

export interface BackstopSweepResult {
  revokedCredentials: number;
  releasedMachines: number;
}

export async function sweepExpiredCredentials(
  now = new Date(),
): Promise<BackstopSweepResult> {
  const activityCutoff = new Date(
    now.getTime() - RECENT_ACTIVITY_WINDOW_MS,
  );
  const expiredCredentials = await db.guestCredential.findMany({
    where: {
      revokedAt: null,
      expiresAt: { lte: now },
    },
    select: {
      id: true,
      machineId: true,
      studentEmail: true,
      machine: { select: { lastHeartbeat: true } },
    },
  });
  const staleCredentials = expiredCredentials.filter(
    ({ machine }) =>
      !machine.lastHeartbeat || machine.lastHeartbeat < activityCutoff,
  );
  const result: BackstopSweepResult = {
    revokedCredentials: 0,
    releasedMachines: 0,
  };

  for (const credential of staleCredentials) {
    const outcome = await db.$transaction(async (transaction) => {
      const revoked = await transaction.guestCredential.updateMany({
        where: { id: credential.id, revokedAt: null },
        data: { revokedAt: now },
      });

      if (revoked.count !== 1) {
        return { revoked: false, released: false };
      }

      const newerCredential = await transaction.guestCredential.findFirst({
        where: {
          machineId: credential.machineId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      let released = false;

      if (!newerCredential) {
        const machineUpdate = await transaction.machine.updateMany({
          where: { id: credential.machineId },
          data: { status: "available" },
        });
        released = machineUpdate.count === 1;
      }

      await transaction.auditLog.create({
        data: {
          machineId: credential.machineId,
          studentEmail: credential.studentEmail,
          event: "force_revoke",
          detail: "Expired credential recovered after heartbeat timeout.",
        },
      });

      return { revoked: true, released };
    });

    if (outcome.revoked) {
      result.revokedCredentials += 1;
    }
    if (outcome.released) {
      result.releasedMachines += 1;
    }
  }

  return result;
}
