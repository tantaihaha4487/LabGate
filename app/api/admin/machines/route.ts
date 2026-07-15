import { NextResponse } from "next/server";
import { getAdminAuthorization } from "@/lib/admin-authorization";
import { listAdminMachines } from "@/lib/admin-machines";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await getAdminAuthorization(request.headers);

  if (authorization.status === "unauthenticated") {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (authorization.status === "forbidden") {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const now = new Date();
  const machines = await listAdminMachines(now);

  return NextResponse.json(
    { serverTime: now.toISOString(), machines },
    { headers: { "Cache-Control": "no-store" } },
  );
}
