import { db } from "@/lib/db/client";
import { isHeartbeatEligible } from "@/lib/machine-liveness";

export type PublicMachineStatus = "available" | "occupied";
export type PublicMachineConnectivity = "online" | "offline";

export interface PublicMachine {
  id: string;
  name: string;
  status: PublicMachineStatus;
  connectivity: PublicMachineConnectivity;
  lastHeartbeat: string | null;
}

export async function listPublicMachines(now = new Date()): Promise<PublicMachine[]> {
  const machines = await db.machine.findMany({
    where: { isHidden: false },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      status: true,
      sshHostKeySha256: true,
      lastHeartbeat: true,
    },
  });
  return machines.map((machine) => {
    const online = isHeartbeatEligible(machine.lastHeartbeat, now);

    return {
      id: machine.id,
      name: machine.name,
      status:
        machine.status === "available" && machine.sshHostKeySha256 !== null
          ? "available"
          : "occupied",
      connectivity: online ? "online" : "offline",
      lastHeartbeat: machine.lastHeartbeat?.toISOString() ?? null,
    };
  });
}
