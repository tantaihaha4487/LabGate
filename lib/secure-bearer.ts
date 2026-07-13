import { timingSafeEqual } from "node:crypto";

export function hasValidBearerToken(
  headers: Headers,
  expectedToken: string | null | undefined,
): boolean {
  const expected = expectedToken?.trim();
  const authorization = headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!expected || !provided) {
    return false;
  }

  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);

  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}
