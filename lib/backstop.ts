import { db } from "@/lib/db/client";
import { expireCredential } from "@/lib/credential-expiry";
import type { ProvisionTarget } from "@/lib/provision";

export interface BackstopSweepResult {
  revokedCredentials: number;
  releasedMachines: number;
  pendingCredentials: number;
}

type RevokeFunction = (machine: ProvisionTarget) => Promise<void>;

export async function sweepExpiredCredentials(
  now = new Date(),
  revoke?: RevokeFunction,
): Promise<BackstopSweepResult> {
  const expiredCredentials = await db.guestCredential.findMany({
    where: {
      revokedAt: null,
      expiresAt: { lte: now },
    },
    select: { id: true },
  });
  const result: BackstopSweepResult = {
    revokedCredentials: 0,
    releasedMachines: 0,
    pendingCredentials: 0,
  };

  for (const credential of expiredCredentials) {
    const outcome = await expireCredential({
      credentialId: credential.id,
      now,
      revoke,
    });

    if (outcome.status === "released") {
      result.revokedCredentials += 1;
    }
    if (outcome.releasedMachine) {
      result.releasedMachines += 1;
    }
    if (outcome.status === "retry") {
      result.pendingCredentials += 1;
    }
  }

  return result;
}
