export interface ProvisionTarget {
  tailscaleIp: string;
}

export async function provisionMachine(
  _machine: ProvisionTarget,
  _password: string,
): Promise<void> {
  void _machine;
  void _password;
  throw new Error("SSH provisioning is implemented in Phase 4.");
}
