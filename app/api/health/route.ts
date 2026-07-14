import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { machineEnrollmentProtocol } from "@/lib/machine-enrollment-protocol";

export const runtime = "nodejs";

export async function GET() {
  try {
    await db.machine.count();
    return NextResponse.json(
      { ok: true, ...machineEnrollmentProtocol },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, ...machineEnrollmentProtocol },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
