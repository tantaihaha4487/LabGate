import { NextResponse } from "next/server";
import { CheckoutError, checkoutMachine } from "@/lib/checkout";
import { getInstitutionSession } from "@/lib/server-session";

export const runtime = "nodejs";

interface CheckoutBody {
  machineId?: unknown;
}

export async function POST(request: Request) {
  const session = await getInstitutionSession(request.headers);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CheckoutBody;

  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.machineId !== "string" || body.machineId.length === 0) {
    return NextResponse.json({ error: "machineId is required." }, { status: 400 });
  }

  try {
    const credential = await checkoutMachine({
      machineId: body.machineId,
      studentEmail: session.user.email,
    });

    return NextResponse.json(
      {
        ...credential,
        serverTime: new Date().toISOString(),
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error: unknown) {
    if (error instanceof CheckoutError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error("Checkout failed", error);
    return NextResponse.json({ error: "Checkout failed." }, { status: 500 });
  }
}
