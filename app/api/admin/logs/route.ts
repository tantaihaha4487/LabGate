import { NextResponse } from "next/server";
import { getAdminAuthorization } from "@/lib/admin-authorization";
import {
  AdminActivityQueryError,
  listAdminActivity,
  parseAdminActivityQuery,
} from "@/lib/admin-activity";

export const runtime = "nodejs";

const noStoreHeaders = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStoreHeaders });
}

export async function GET(request: Request) {
  try {
    const authorization = await getAdminAuthorization(request.headers);

    if (authorization.status === "unauthenticated") {
      return json({ error: "Unauthorized" }, 401);
    }
    if (authorization.status === "forbidden") {
      return json({ error: "Forbidden" }, 403);
    }

    let query: ReturnType<typeof parseAdminActivityQuery>;
    try {
      query = parseAdminActivityQuery(new URL(request.url).searchParams);
    } catch (error: unknown) {
      if (error instanceof AdminActivityQueryError) {
        return json({ error: error.message }, 400);
      }
      return json({ error: "Invalid activity filters." }, 400);
    }

    return json(
      await listAdminActivity(
        query.filters,
        query.cursor,
        new Date(),
      ),
    );
  } catch {
    return json({ error: "Could not load activity." }, 500);
  }
}
