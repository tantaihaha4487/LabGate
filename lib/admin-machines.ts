import { db } from "@/lib/db/client";
import { isHeartbeatEligible } from "@/lib/machine-liveness";

export type AdminMachineStatus = "available" | "occupied" | "offline";
export type AdminMachineConnectivity = "online" | "offline";
export type AdminReservationState = "pending" | "active";

export interface AdminReservation {
  id: string;
  studentEmail: string;
  state: AdminReservationState;
  createdAt: string;
  expiresAt: string;
  revokedAt: null;
  sessionOpenedAt: string | null;
  machineStateVersion: number;
}

export interface AdminMachine {
  id: string;
  name: string;
  isHidden: boolean;
  status: AdminMachineStatus;
  connectivity: AdminMachineConnectivity;
  lastHeartbeat: string | null;
  tailscaleIp: string;
  sshHostKeySha256: string | null;
  safetyHoldCredentialId: string | null;
  currentReservation: AdminReservation | null;
}

export async function listAdminMachines(
  now = new Date(),
): Promise<AdminMachine[]> {
  const machines = await db.machine.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      isHidden: true,
      status: true,
      lastHeartbeat: true,
      tailscaleIp: true,
      sshHostKeySha256: true,
      safetyHoldCredentialId: true,
      guestCredentials: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          studentEmail: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          sessionOpenedAt: true,
          machineStateVersion: true,
        },
      },
    },
  });

  return machines.map((machine) => {
    const credential = machine.guestCredentials[0];

    return {
      id: machine.id,
      name: machine.name,
      isHidden: machine.isHidden,
      status: machine.status,
      connectivity: isHeartbeatEligible(machine.lastHeartbeat, now)
        ? "online"
        : "offline",
      lastHeartbeat: machine.lastHeartbeat?.toISOString() ?? null,
      tailscaleIp: machine.tailscaleIp,
      sshHostKeySha256: machine.sshHostKeySha256,
      safetyHoldCredentialId: machine.safetyHoldCredentialId,
      currentReservation: credential
        ? {
            id: credential.id,
            studentEmail: credential.studentEmail,
            state: credential.sessionOpenedAt === null ? "pending" : "active",
            createdAt: credential.createdAt.toISOString(),
            expiresAt: credential.expiresAt.toISOString(),
            revokedAt: null,
            sessionOpenedAt: credential.sessionOpenedAt?.toISOString() ?? null,
            machineStateVersion: credential.machineStateVersion,
          }
        : null,
    };
  });
}

export async function setMachineVisibility({
  machineId,
  hidden,
  adminEmail,
}: {
  machineId: string;
  hidden: boolean;
  adminEmail: string;
}): Promise<{ status: "updated" | "unchanged"; hidden: boolean } | null> {
  return db.$transaction(async (transaction) => {
    const changed = await transaction.machine.updateMany({
      where: { id: machineId, isHidden: !hidden },
      data: { isHidden: hidden },
    });

    if (changed.count === 1) {
      await transaction.auditLog.create({
        data: {
          machineId,
          studentEmail: adminEmail,
          event: hidden ? "machine_hide" : "machine_restore",
          detail: hidden
            ? "Machine hidden from student listings and checkout."
            : "Machine restored to student listings and checkout eligibility checks.",
        },
      });

      return { status: "updated" as const, hidden };
    }

    const existing = await transaction.machine.findUnique({
      where: { id: machineId },
      select: { isHidden: true },
    });

    if (!existing) {
      return null;
    }

    return { status: "unchanged" as const, hidden: existing.isHidden };
  });
}
