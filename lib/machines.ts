import { db } from "@/lib/db/client";

const OFFLINE_AFTER_MS = 2 * 60 * 1000;

export type PublicMachineStatus = "available" | "occupied" | "offline";

export interface PublicMachine {
  id: string;
  name: string;
  status: PublicMachineStatus;
  lastHeartbeat: string | null;
}

export async function listPublicMachines(now = new Date()): Promise<PublicMachine[]> {
  const machines = await db.machine.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      status: true,
      lastHeartbeat: true,
    },
  });
  const heartbeatCutoff = now.getTime() - OFFLINE_AFTER_MS;

  return machines.map((machine) => ({
    ...machine,
    status:
      !machine.lastHeartbeat ||
      machine.lastHeartbeat.getTime() < heartbeatCutoff
        ? "offline"
        : machine.status,
    lastHeartbeat: machine.lastHeartbeat?.toISOString() ?? null,
  }));
}
