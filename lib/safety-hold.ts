// This value is deliberately outside the public credential-ID alphabet. It
// represents more than one contradictory physical generation (or an unsafe
// report without an ID), so no generation-scoped terminal event may match it.
export const CONFLICT_SAFETY_HOLD = "!conflicting-physical-generations!";

export function mergeSafetyHold(
  existingHold: string | null,
  reportedCredentialId: string,
): string {
  if (
    existingHold === null ||
    existingHold === reportedCredentialId
  ) {
    return reportedCredentialId;
  }

  return CONFLICT_SAFETY_HOLD;
}

export function reconcileFreshActiveHold(
  existingHold: string | null,
  reportedCredentialId: string,
): string | null {
  if (
    existingHold === null ||
    existingHold === reportedCredentialId
  ) {
    return null;
  }

  return CONFLICT_SAFETY_HOLD;
}

export function mergeUnsafeGenerations(
  existingHold: string | null,
  currentCredentialIds: readonly string[],
  reportedCredentialId: string,
): string {
  let mergedHold = existingHold;

  for (const currentCredentialId of currentCredentialIds) {
    mergedHold = mergeSafetyHold(mergedHold, currentCredentialId);
  }

  return mergeSafetyHold(mergedHold, reportedCredentialId);
}
