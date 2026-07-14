import { NextResponse } from "next/server";
import {
  activateMachineCredential,
  closeMachineCredential,
} from "@/lib/credential-lifecycle";
import { db } from "@/lib/db/client";
import { readHeartbeatMachineReport } from "@/lib/machine-report";
import { RequestBodyError } from "@/lib/request-body";
import {
  CONFLICT_SAFETY_HOLD,
  mergeSafetyHold,
  mergeUnsafeGenerations,
  reconcileFreshActiveHold,
} from "@/lib/safety-hold";
import { authenticateWebhookMachine } from "@/lib/webhook-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const machine = await authenticateWebhookMachine(request.headers);

  if (!machine) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let report: Awaited<ReturnType<typeof readHeartbeatMachineReport>>;

  try {
    report = await readHeartbeatMachineReport(request);
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  if (!report) {
    return NextResponse.json(
      { error: "A valid machine state report is required." },
      { status: 400 },
    );
  }

  const now = new Date();

  if (report.sessionActive && report.credentialId) {
    const status = await activateMachineCredential({
      machineId: machine.id,
      credentialId: report.credentialId,
      stateVersion: 2,
      now,
      source: "heartbeat",
      webhookToken: machine.webhookToken,
    });

    if (status === "unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { ok: true, status },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (report.guestLocked && report.credentialId) {
    const status = await closeMachineCredential({
      allowHeartbeatSafeReleaseOnDuplicate: true,
      machineId: machine.id,
      credentialId: report.credentialId,
      stateVersion: 3,
      now,
      event: report.state === "revoked" ? "force_revoke" : "session_close",
      detail:
        "Heartbeat reconciled a missed machine webhook after confirming no active session and a locked guest account.",
      webhookToken: machine.webhookToken,
    });

    if (status === "unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { ok: true, status },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (
    report.state === "pending" &&
    report.stateVersion === 1 &&
    report.credentialId
  ) {
    const credentialId = report.credentialId;
    const status = await db.$transaction(async (transaction) => {
      const authenticatedMachine = await transaction.machine.findFirst({
        where: { id: machine.id, webhookToken: machine.webhookToken },
        select: { safetyHoldCredentialId: true },
      });
      if (!authenticatedMachine) {
        return "unauthorized" as const;
      }

      const credential = await transaction.guestCredential.findFirst({
        where: { id: credentialId, machineId: machine.id },
        select: { machineStateVersion: true, revokedAt: true },
      });

      if (
        credential &&
        credential.revokedAt === null &&
        credential.machineStateVersion < 2
      ) {
        await transaction.guestCredential.updateMany({
          where: {
            id: credentialId,
            machineId: machine.id,
            revokedAt: null,
            machineStateVersion: { lt: 1 },
          },
          data: { machineStateVersion: 1 },
        });
        await transaction.machine.update({
          where: { id: machine.id },
          data: {
            lastHeartbeat: now,
            status: "occupied",
            safetyHoldCredentialId: reconcileFreshActiveHold(
              authenticatedMachine.safetyHoldCredentialId,
              credentialId,
            ),
          },
        });
        return "observed";
      }

      const currentCredentials = await transaction.guestCredential.findMany({
        where: { machineId: machine.id, revokedAt: null },
        select: { id: true },
      });
      await transaction.guestCredential.updateMany({
        where: { machineId: machine.id, revokedAt: null },
        data: { revokedAt: now, machineStateVersion: 3 },
      });
      await transaction.machine.update({
        where: { id: machine.id },
        data: {
          lastHeartbeat: now,
          status: "occupied",
          safetyHoldCredentialId: mergeUnsafeGenerations(
            authenticatedMachine.safetyHoldCredentialId,
            currentCredentials.map(({ id }) => id),
            credentialId,
          ),
        },
      });
      await transaction.auditLog.create({
        data: {
          machineId: machine.id,
          event: "session_open",
          detail:
            "Machine reported an unlocked pending generation that is unknown or older than server state; machine held occupied.",
        },
      });
      return "unsafe_pending";
    });

    if (status === "unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { ok: true, status },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const observed = await db.$transaction(async (transaction) => {
    const authenticatedMachine = await transaction.machine.findFirst({
      where: { id: machine.id, webhookToken: machine.webhookToken },
      select: { safetyHoldCredentialId: true },
    });
    if (!authenticatedMachine) {
      return false;
    }

    const currentCredential = await transaction.guestCredential.findFirst({
      where: { machineId: machine.id, revokedAt: null },
      select: { id: true },
    });

    if (!report.guestLocked) {
      await transaction.guestCredential.updateMany({
        where: { machineId: machine.id, revokedAt: null },
        data: { revokedAt: now, machineStateVersion: 3 },
      });
    }

    await transaction.machine.update({
      where: { id: machine.id },
      data: {
        lastHeartbeat: now,
        status:
          !report.guestLocked || currentCredential ? "occupied" : "available",
        safetyHoldCredentialId:
          report.guestLocked && !currentCredential
            ? null
            : !report.guestLocked && report.credentialId === null
              ? authenticatedMachine.safetyHoldCredentialId === null
                ? CONFLICT_SAFETY_HOLD
                : mergeSafetyHold(
                    authenticatedMachine.safetyHoldCredentialId,
                    CONFLICT_SAFETY_HOLD,
                  )
              : undefined,
      },
    });
    return true;
  });

  if (!observed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    { ok: true, status: "observed" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
