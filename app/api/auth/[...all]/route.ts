import { auth } from "@/lib/auth";
import {
  readBoundedRequestBody,
  RequestBodyError,
} from "@/lib/request-body";
import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";

const handlers = toNextJsHandler(auth);
const MAX_AUTH_BODY_BYTES = 64 * 1_024;

function preventSessionCaching(response: Response): Response {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  const vary = response.headers.get("Vary");
  if (
    !vary
      ?.split(",")
      .some((value) => value.trim().toLowerCase() === "cookie")
  ) {
    response.headers.set("Vary", vary ? `${vary}, Cookie` : "Cookie");
  }
  return response;
}

export async function GET(request: Request): Promise<Response> {
  return preventSessionCaching(await handlers.GET(request));
}

export async function POST(request: Request): Promise<Response> {
  let body: Uint8Array | null;

  try {
    body = await readBoundedRequestBody(request, MAX_AUTH_BODY_BYTES);
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return preventSessionCaching(
        Response.json({ error: error.message }, { status: error.status }),
      );
    }
    throw error;
  }

  if (body === null) {
    return preventSessionCaching(
      Response.json({ error: "Invalid request body." }, { status: 400 }),
    );
  }

  const boundedBody = new ArrayBuffer(body.byteLength);
  new Uint8Array(boundedBody).set(body);
  const boundedRequest = new Request(request, { body: boundedBody });
  return preventSessionCaching(await handlers.POST(boundedRequest));
}
