import { isValidCredentialId } from "@/lib/credential-id";
import { readBoundedJsonObject } from "@/lib/request-body";

export const MAX_MACHINE_REPORT_BYTES = 4_096;

export interface CredentialMachineReport {
  credentialId: string;
  stateVersion: 2 | 3;
}

export interface HeartbeatMachineReport {
  credentialId: string | null;
  guestLocked: boolean;
  sessionActive: boolean;
  state: "pending" | "active" | "revoked" | null;
  stateVersion: 1 | 2 | 3 | null;
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  return readBoundedJsonObject(request, MAX_MACHINE_REPORT_BYTES);
}

export async function readCredentialMachineReport(
  request: Request,
): Promise<CredentialMachineReport | null> {
  const body = await readJsonObject(request);

  if (
    !body ||
    typeof body.credentialId !== "string" ||
    !isValidCredentialId(body.credentialId) ||
    (body.stateVersion !== 2 && body.stateVersion !== 3)
  ) {
    return null;
  }

  return {
    credentialId: body.credentialId,
    stateVersion: body.stateVersion,
  };
}

export async function readHeartbeatMachineReport(
  request: Request,
): Promise<HeartbeatMachineReport | null> {
  const body = await readJsonObject(request);

  if (!body) {
    return null;
  }

  const credentialId = body.credentialId;
  const state = body.state;
  const stateVersion = body.stateVersion;

  if (
    (credentialId !== null &&
      (typeof credentialId !== "string" || !isValidCredentialId(credentialId))) ||
    typeof body.guestLocked !== "boolean" ||
    typeof body.sessionActive !== "boolean" ||
    (state !== null &&
      state !== "pending" &&
      state !== "active" &&
      state !== "revoked") ||
    (stateVersion !== null &&
      stateVersion !== 1 &&
      stateVersion !== 2 &&
      stateVersion !== 3)
  ) {
    return null;
  }

  const hasCredential = credentialId !== null;
  const expectedVersion =
    state === "pending" ? 1 : state === "active" ? 2 : state === "revoked" ? 3 : null;

  if (
    hasCredential !== (state !== null) ||
    hasCredential !== (stateVersion !== null) ||
    stateVersion !== expectedVersion ||
    body.sessionActive !== (state === "active") ||
    (state === "pending" && body.guestLocked) ||
    (state === "active" && body.guestLocked) ||
    (state === "revoked" && !body.guestLocked)
  ) {
    return null;
  }

  return {
    credentialId,
    guestLocked: body.guestLocked,
    sessionActive: body.sessionActive,
    state,
    stateVersion,
  };
}
