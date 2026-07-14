import { Buffer } from "node:buffer";

const SHA256_FINGERPRINT_PREFIX = "SHA256:";
const SHA256_BASE64_LENGTH = 43;

export function sshHostKeySha256Digest(
  fingerprint: string,
): Buffer | undefined {
  if (
    !fingerprint.startsWith(SHA256_FINGERPRINT_PREFIX) ||
    fingerprint.length !==
      SHA256_FINGERPRINT_PREFIX.length + SHA256_BASE64_LENGTH
  ) {
    return undefined;
  }

  const encoded = fingerprint.slice(SHA256_FINGERPRINT_PREFIX.length);

  if (!/^[A-Za-z0-9+/]{43}$/.test(encoded)) {
    return undefined;
  }

  const digest = Buffer.from(encoded, "base64");
  const canonical = digest.toString("base64").replace(/=+$/, "");

  return digest.length === 32 && canonical === encoded ? digest : undefined;
}

export function isValidSshHostKeySha256Fingerprint(
  value: unknown,
): value is string {
  return typeof value === "string" && sshHostKeySha256Digest(value) !== undefined;
}
