import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET() {
  try {
    await db.machine.count();
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
