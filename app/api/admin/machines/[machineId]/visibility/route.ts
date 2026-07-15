import { NextResponse } from "next/server";
import { getAdminAuthorization } from "@/lib/admin-authorization";
import { setMachineVisibility } from "@/lib/admin-machines";
import {
  readBoundedJsonObject,
  RequestBodyError,
} from "@/lib/request-body";

export const runtime = "nodejs";

const MAX_VISIBILITY_BODY_BYTES = 1_024;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ machineId: string }> },
) {
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

  const { machineId } = await context.params;
  if (!MACHINE_ID_PATTERN.test(machineId)) {
    return NextResponse.json(
      { error: "A valid machine ID is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: Record<string, unknown>;

  try {
    body =
      (await readBoundedJsonObject(request, MAX_VISIBILITY_BODY_BYTES)) ?? {};
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (
    typeof body.hidden !== "boolean" ||
    Object.keys(body).some((key) => key !== "hidden")
  ) {
    return NextResponse.json(
      { error: "hidden must be a Boolean and is the only accepted field." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await setMachineVisibility({
    machineId,
    hidden: body.hidden,
    adminEmail: authorization.adminEmail,
  });

  if (!result) {
    return NextResponse.json(
      { error: "Machine not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { machineId, hidden: result.hidden },
    { headers: { "Cache-Control": "no-store" } },
  );
}
