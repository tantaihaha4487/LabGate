import { NextResponse } from "next/server";
import { listPublicMachines } from "@/lib/machines";
import { getInstitutionSession } from "@/lib/server-session";

export async function GET(request: Request) {
  const session = await getInstitutionSession(request.headers);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const machines = await listPublicMachines();

  return NextResponse.json(
    { machines },
    { headers: { "Cache-Control": "no-store" } },
  );
}
