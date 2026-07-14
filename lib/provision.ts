import { createHash, timingSafeEqual } from "node:crypto";
import { NodeSSH } from "node-ssh";
import { isValidCredentialId } from "@/lib/credential-id";
import { isValidGuestPassword } from "@/lib/password";
import { sshHostKeySha256Digest } from "@/lib/ssh-host-key";

export interface ProvisionTarget {
  sshHostKeySha256: string;
  tailscaleIp: string;
}

export interface ProvisionCredential {
  credentialId: string;
  expiresAt: Date;
  password: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const GUEST_ACCOUNT_SCRIPT = "/usr/local/sbin/guest-account.sh";

function credentialExpiryUnixSeconds(expiresAt: Date): number {
  if (!(expiresAt instanceof Date)) {
    throw new TypeError("Credential expiry must be a valid future Date.");
  }

  const expiryMilliseconds = expiresAt.getTime();

  if (!Number.isFinite(expiryMilliseconds) || expiryMilliseconds <= Date.now()) {
    throw new RangeError("Credential expiry must be a valid future Date.");
  }

  const expiryUnixSeconds = Math.floor(expiryMilliseconds / 1_000);
  const currentUnixSeconds = Math.floor(Date.now() / 1_000);

  if (
    !Number.isSafeInteger(expiryUnixSeconds) ||
    expiryUnixSeconds <= currentUnixSeconds
  ) {
    throw new RangeError(
      "Credential expiry must produce a future safe Unix timestamp.",
    );
  }

  return expiryUnixSeconds;
}

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
  credentialId: string,
  expiresAt?: Date,
  password?: string,
): Promise<void> {
  if (!isValidCredentialId(credentialId)) {
    throw new Error("Refusing to use an invalid credential ID.");
  }

  const expectedHostKeyDigest = sshHostKeySha256Digest(
    machine.sshHostKeySha256,
  );

  if (!expectedHostKeyDigest) {
    throw new Error("Refusing to connect without a valid SSH host-key pin.");
  }

  let command: string;
  let commandStdin: string | undefined;

  if (action === "issue") {
    if (!password || !isValidGuestPassword(password)) {
      throw new Error("Refusing to provision an invalid guest password.");
    }

    if (!expiresAt) {
      throw new TypeError("Credential expiry must be a valid future Date.");
    }

    const expiryUnixSeconds = credentialExpiryUnixSeconds(expiresAt);
    command = `sudo ${GUEST_ACCOUNT_SCRIPT} issue ${credentialId} ${expiryUnixSeconds}`;
    commandStdin = `${password}\n`;
  } else {
    command = `sudo ${GUEST_ACCOUNT_SCRIPT} revoke ${credentialId}`;
  }

  const ssh = new NodeSSH();

  try {
    await withTimeout(
      ssh.connect({
        host: machine.tailscaleIp,
        username: "provisioner",
        privateKeyPath: requiredSshKeyPath(),
        readyTimeout: CONNECT_TIMEOUT_MS,
        algorithms: {
          serverHostKey: ["ssh-ed25519"],
        },
        hostVerifier: (rawHostKey: Buffer): boolean => {
          const actualHostKeyDigest = createHash("sha256")
            .update(rawHostKey)
            .digest();

          return (
            actualHostKeyDigest.length === expectedHostKeyDigest.length &&
            timingSafeEqual(actualHostKeyDigest, expectedHostKeyDigest)
          );
        },
      }),
      CONNECT_TIMEOUT_MS,
      "SSH connection timed out.",
    );

    const result = await withTimeout(
      ssh.execCommand(
        command,
        commandStdin === undefined ? undefined : { stdin: commandStdin },
      ),
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
  } catch (error: unknown) {
    if (action === "issue") {
      throw new Error("Guest account issue command failed.");
    }
    throw error;
  } finally {
    ssh.dispose();
  }
}

export async function provisionMachine(
  machine: ProvisionTarget,
  { credentialId, expiresAt, password }: ProvisionCredential,
): Promise<void> {
  await runGuestAccountCommand(
    machine,
    "issue",
    credentialId,
    expiresAt,
    password,
  );
}

export async function revokeMachine(
  machine: ProvisionTarget,
  credentialId: string,
): Promise<void> {
  await runGuestAccountCommand(machine, "revoke", credentialId);
}
