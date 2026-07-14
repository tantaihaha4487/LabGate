export const LABGATE_SERVICE_NAME = "labgate";
export const MACHINE_ENROLLMENT_VERSION = 1;

export const machineEnrollmentProtocol = {
  service: LABGATE_SERVICE_NAME,
  machineEnrollmentVersion: MACHINE_ENROLLMENT_VERSION,
} as const;
