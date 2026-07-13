import { NodeSSH } from "node-ssh";
import { isValidGuestPassword } from "@/lib/password";

export interface ProvisionTarget {
  tailscaleIp: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const GUEST_ACCOUNT_SCRIPT = "/usr/local/sbin/guest-account.sh";

function requiredSshKeyPath(): string {
  const path = process.env.PROVISIONER_SSH_KEY_PATH?.trim();

  if (!path) {
    throw new Error("PROVISIONER_SSH_KEY_PATH is required.");
  }

  return path;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(message)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runGuestAccountCommand(
  machine: ProvisionTarget,
  action: "issue" | "revoke",
  password?: string,
): Promise<void> {
  if (action === "issue" && (!password || !isValidGuestPassword(password))) {
    throw new Error("Refusing to provision an invalid guest password.");
  }

  const ssh = new NodeSSH();
  const command =
    action === "issue"
      ? `sudo ${GUEST_ACCOUNT_SCRIPT} issue ${password}`
      : `sudo ${GUEST_ACCOUNT_SCRIPT} revoke`;

  try {
    await withTimeout(
      ssh.connect({
        host: machine.tailscaleIp,
        username: "provisioner",
        privateKeyPath: requiredSshKeyPath(),
        readyTimeout: CONNECT_TIMEOUT_MS,
      }),
      CONNECT_TIMEOUT_MS,
      "SSH connection timed out.",
    );

    const result = await withTimeout(
      ssh.execCommand(command),
      COMMAND_TIMEOUT_MS,
      "Guest account command timed out.",
    );

    if (result.code !== 0) {
      const detail = result.stderr.trim().slice(0, 500);
      throw new Error(
        detail
          ? `Guest account command failed: ${detail}`
          : "Guest account command failed with a non-zero exit code.",
      );
    }
  } finally {
    ssh.dispose();
  }
}

export async function provisionMachine(
  machine: ProvisionTarget,
  password: string,
): Promise<void> {
  await runGuestAccountCommand(machine, "issue", password);
}

export async function revokeMachine(machine: ProvisionTarget): Promise<void> {
  await runGuestAccountCommand(machine, "revoke");
}
