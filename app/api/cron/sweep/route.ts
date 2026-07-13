import { NextResponse } from "next/server";
import { sweepExpiredCredentials } from "@/lib/backstop";
import { hasValidBearerToken } from "@/lib/secure-bearer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (!cronSecret) {
    return NextResponse.json(
      { error: "Backstop sweep is not configured." },
      { status: 503 },
    );
  }

  if (!hasValidBearerToken(request.headers, cronSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sweepExpiredCredentials();
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
