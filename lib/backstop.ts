import { db } from "@/lib/db/client";
import { expireCredential } from "@/lib/credential-expiry";
import type { ProvisionTarget } from "@/lib/provision";

export interface BackstopSweepResult {
  revokedCredentials: number;
  releasedMachines: number;
  pendingCredentials: number;
  deferredCredentials: number;
  activeCredentials: number;
}

export const MAX_CREDENTIALS_PER_SWEEP = 4;

type RevokeFunction = (
  machine: ProvisionTarget,
  credentialId: string,
) => Promise<void>;

let productionSweepInFlight: Promise<BackstopSweepResult> | null = null;

async function runExpiredCredentialSweep(
  now = new Date(),
  revoke?: RevokeFunction,
): Promise<BackstopSweepResult> {
  const expiredWhere = {
    revokedAt: null,
    expiresAt: { lte: now },
    sessionOpenedAt: null,
  } as const;
  const [expiredCredentialCount, expiredCredentials] = await db.$transaction([
    db.guestCredential.count({ where: expiredWhere }),
    db.guestCredential.findMany({
      where: expiredWhere,
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: MAX_CREDENTIALS_PER_SWEEP,
      select: { id: true },
    }),
  ]);
  const result: BackstopSweepResult = {
    revokedCredentials: 0,
    releasedMachines: 0,
    pendingCredentials: 0,
    deferredCredentials: Math.max(
      0,
      expiredCredentialCount - expiredCredentials.length,
    ),
    activeCredentials: await db.guestCredential.count({
      where: {
        revokedAt: null,
        expiresAt: { lte: now },
        sessionOpenedAt: { not: null },
      },
    }),
  };

  const outcomes = await Promise.all(
    expiredCredentials.map((credential) =>
      expireCredential({
        credentialId: credential.id,
        now,
        revoke,
      }),
    ),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "released" || outcome.status === "held") {
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

export async function sweepExpiredCredentials(
  now = new Date(),
  revoke?: RevokeFunction,
): Promise<BackstopSweepResult> {
  // Injected revokers are test/operator-scoped calls. Production cron calls
  // share one in-process sweep so overlapping HTTP requests cannot issue the
  // same lock commands twice.
  if (revoke) {
    return runExpiredCredentialSweep(now, revoke);
  }

  if (productionSweepInFlight) {
    return productionSweepInFlight;
  }

  const operation = runExpiredCredentialSweep(now);
  productionSweepInFlight = operation;

  try {
    return await operation;
  } finally {
    if (productionSweepInFlight === operation) {
      productionSweepInFlight = null;
    }
  }
}
