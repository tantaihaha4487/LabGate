export const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

export function isValidCredentialId(credentialId: string): boolean {
  return CREDENTIAL_ID_PATTERN.test(credentialId);
}
