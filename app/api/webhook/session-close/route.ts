import { NextResponse } from "next/server";
import { closeMachineCredential } from "@/lib/credential-lifecycle";
import { readCredentialMachineReport } from "@/lib/machine-report";
import { RequestBodyError } from "@/lib/request-body";
import { authenticateWebhookMachine } from "@/lib/webhook-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const machine = await authenticateWebhookMachine(request.headers);

  if (!machine) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let report: Awaited<ReturnType<typeof readCredentialMachineReport>>;

  try {
    report = await readCredentialMachineReport(request);
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  if (!report) {
    return NextResponse.json(
      { error: "A valid credentialId is required." },
      { status: 400 },
    );
  }

  if (report.stateVersion !== 3) {
    return NextResponse.json(
      { error: "session-close requires revoked stateVersion 3." },
      { status: 400 },
    );
  }

  const status = await closeMachineCredential({
    machineId: machine.id,
    credentialId: report.credentialId,
    stateVersion: report.stateVersion,
    event: "session_close",
    detail:
      "The lab machine confirmed that guest was locked and the physical session closed.",
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
