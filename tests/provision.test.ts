import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  NodeSSH,
  type Config,
  type SSHExecCommandOptions,
  type SSHExecCommandResponse,
} from "node-ssh";
import { isValidCredentialId } from "../lib/credential-id";
import {
  provisionMachine,
  revokeMachine,
  type ProvisionTarget,
} from "../lib/provision";

const VALID_CREDENTIAL_ID = "credential_123456789";
const VALID_PASSWORD = "Abcdef23";
const RAW_HOST_KEY = Buffer.from("test-ed25519-host-key-blob");
const VALID_HOST_FINGERPRINT = `SHA256:${createHash("sha256")
  .update(RAW_HOST_KEY)
  .digest("base64")
  .replace(/=+$/, "")}`;
const TARGET: ProvisionTarget = {
  sshHostKeySha256: VALID_HOST_FINGERPRINT,
  tailscaleIp: "100.64.0.10",
};

test("credential IDs use only 20-64 shell-safe characters", () => {
  assert.equal(isValidCredentialId("A".repeat(20)), true);
  assert.equal(isValidCredentialId("aZ09_-".repeat(10).slice(0, 60)), true);
  assert.equal(isValidCredentialId("z".repeat(64)), true);

  assert.equal(isValidCredentialId("A".repeat(19)), false);
  assert.equal(isValidCredentialId("A".repeat(65)), false);
  assert.equal(isValidCredentialId(`${"A".repeat(20)};`), false);
  assert.equal(isValidCredentialId(`${"A".repeat(20)} `), false);
  assert.equal(isValidCredentialId(`${"A".repeat(20)}\n`), false);
  assert.equal(isValidCredentialId("credential/123456789"), false);
});

test("provisioning rejects unsafe or invalid inputs before SSH", async (t) => {
  let connectCalls = 0;

  t.mock.method(
    NodeSSH.prototype,
    "connect",
    async function (this: NodeSSH): Promise<NodeSSH> {
      connectCalls += 1;
      return this;
    },
  );

  const futureExpiry = new Date(Date.now() + 60_000);

  await assert.rejects(
    revokeMachine(
      { ...TARGET, sshHostKeySha256: "SHA256:not-a-canonical-fingerprint" },
      VALID_CREDENTIAL_ID,
    ),
    /valid SSH host-key pin/,
  );
  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: "too-short",
      expiresAt: futureExpiry,
      password: VALID_PASSWORD,
    }),
    /invalid credential ID/,
  );
  await assert.rejects(
    revokeMachine(TARGET, `${VALID_CREDENTIAL_ID};`),
    /invalid credential ID/,
  );
  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: futureExpiry,
      password: "unsafe;password",
    }),
    /invalid guest password/,
  );
  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: new Date(Number.NaN),
      password: VALID_PASSWORD,
    }),
    /valid future Date/,
  );
  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: new Date(Date.now() - 1_000),
      password: VALID_PASSWORD,
    }),
    /valid future Date/,
  );
  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: "tomorrow" as unknown as Date,
      password: VALID_PASSWORD,
    }),
    /valid future Date/,
  );

  class UnsafeEpochDate extends Date {
    override getTime(): number {
      return Number.MAX_SAFE_INTEGER * 2_000;
    }
  }

  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: new UnsafeEpochDate(),
      password: VALID_PASSWORD,
    }),
    /future safe Unix timestamp/,
  );

  assert.equal(connectCalls, 0);
});

test("provisioning requires an expiry in a future Unix second", async (t) => {
  const fixedNow = 1_800_000_000_500;
  let connectCalls = 0;
  t.mock.method(Date, "now", () => fixedNow);
  t.mock.method(
    NodeSSH.prototype,
    "connect",
    async function (this: NodeSSH): Promise<NodeSSH> {
      connectCalls += 1;
      return this;
    },
  );

  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: new Date(fixedNow + 400),
      password: VALID_PASSWORD,
    }),
    /future safe Unix timestamp/,
  );
  assert.equal(connectCalls, 0);
});

test("provisioning builds generation-scoped issue and revoke commands", async (t) => {
  const previousKeyPath = process.env.PROVISIONER_SSH_KEY_PATH;
  const connectConfigurations: Config[] = [];
  const commands: Array<{
    command: string;
    stdin: string | undefined;
  }> = [];
  let disposeCalls = 0;

  process.env.PROVISIONER_SSH_KEY_PATH = "/test/provisioner-key";
  t.after(() => {
    if (previousKeyPath === undefined) {
      delete process.env.PROVISIONER_SSH_KEY_PATH;
    } else {
      process.env.PROVISIONER_SSH_KEY_PATH = previousKeyPath;
    }
  });

  t.mock.method(
    NodeSSH.prototype,
    "connect",
    async function (this: NodeSSH, config: Config): Promise<NodeSSH> {
      connectConfigurations.push(config);
      return this;
    },
  );
  t.mock.method(
    NodeSSH.prototype,
    "execCommand",
    async (
      command: string,
      options?: SSHExecCommandOptions,
    ): Promise<SSHExecCommandResponse> => {
      commands.push({
        command,
        stdin: typeof options?.stdin === "string" ? options.stdin : undefined,
      });
      return { stdout: "", stderr: "", code: 0, signal: null };
    },
  );
  t.mock.method(NodeSSH.prototype, "dispose", () => {
    disposeCalls += 1;
  });

  const expiresAt = new Date(Date.now() + 60_000);
  const expiryUnixSeconds = Math.floor(expiresAt.getTime() / 1_000);

  await provisionMachine(TARGET, {
    credentialId: VALID_CREDENTIAL_ID,
    expiresAt,
    password: VALID_PASSWORD,
  });
  await revokeMachine(TARGET, VALID_CREDENTIAL_ID);

  assert.deepEqual(commands, [
    {
      command: `sudo /usr/local/sbin/guest-account.sh issue ${VALID_CREDENTIAL_ID} ${expiryUnixSeconds}`,
      stdin: `${VALID_PASSWORD}\n`,
    },
    {
      command: `sudo /usr/local/sbin/guest-account.sh revoke ${VALID_CREDENTIAL_ID}`,
      stdin: undefined,
    },
  ]);
  assert.doesNotMatch(commands[0].command, new RegExp(VALID_PASSWORD));
  assert.equal(connectConfigurations.length, 2);
  for (const configuration of connectConfigurations) {
    assert.equal(configuration.host, TARGET.tailscaleIp);
    assert.equal(configuration.username, "provisioner");
    assert.equal(configuration.privateKeyPath, "/test/provisioner-key");
    assert.equal(configuration.readyTimeout, 5_000);
    assert.deepEqual(configuration.algorithms?.serverHostKey, ["ssh-ed25519"]);
    assert.equal(configuration.hostHash, undefined);
    assert.equal(configuration.hostVerifier?.(RAW_HOST_KEY), true);
    assert.equal(
      configuration.hostVerifier?.(Buffer.from("different-host-key")),
      false,
    );
  }
  assert.equal(disposeCalls, 2);
});

test("SSH host-key mismatch rejects before any remote command or stdin", async (t) => {
  const previousKeyPath = process.env.PROVISIONER_SSH_KEY_PATH;
  let commandCalls = 0;
  let verifierCalls = 0;

  process.env.PROVISIONER_SSH_KEY_PATH = "/test/provisioner-key";
  t.after(() => {
    if (previousKeyPath === undefined) {
      delete process.env.PROVISIONER_SSH_KEY_PATH;
    } else {
      process.env.PROVISIONER_SSH_KEY_PATH = previousKeyPath;
    }
  });

  t.mock.method(
    NodeSSH.prototype,
    "connect",
    async function (this: NodeSSH, config: Config): Promise<NodeSSH> {
      verifierCalls += 1;
      if (!config.hostVerifier?.(Buffer.from("attacker-host-key"))) {
        throw new Error("Host key verification failed");
      }
      return this;
    },
  );
  t.mock.method(
    NodeSSH.prototype,
    "execCommand",
    async (): Promise<SSHExecCommandResponse> => {
      commandCalls += 1;
      return { stdout: "", stderr: "", code: 0, signal: null };
    },
  );
  t.mock.method(NodeSSH.prototype, "dispose", () => undefined);

  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: new Date(Date.now() + 60_000),
      password: VALID_PASSWORD,
    }),
    /issue command failed/,
  );
  assert.equal(verifierCalls, 1);
  assert.equal(commandCalls, 0);
});

test("provisioning never exposes an issued password through remote errors", async (t) => {
  const previousKeyPath = process.env.PROVISIONER_SSH_KEY_PATH;
  process.env.PROVISIONER_SSH_KEY_PATH = "/test/provisioner-key";
  t.after(() => {
    if (previousKeyPath === undefined) {
      delete process.env.PROVISIONER_SSH_KEY_PATH;
    } else {
      process.env.PROVISIONER_SSH_KEY_PATH = previousKeyPath;
    }
  });
  t.mock.method(
    NodeSSH.prototype,
    "connect",
    async function (this: NodeSSH): Promise<NodeSSH> {
      return this;
    },
  );
  t.mock.method(
    NodeSSH.prototype,
    "execCommand",
    async (
      command: string,
      options?: SSHExecCommandOptions,
    ): Promise<SSHExecCommandResponse> => {
      assert.doesNotMatch(command, new RegExp(VALID_PASSWORD));
      assert.equal(options?.stdin, `${VALID_PASSWORD}\n`);
      return {
        stdout: "",
        stderr: `sudo: command rejected: ${command}`,
        code: 1,
        signal: null,
      };
    },
  );
  t.mock.method(NodeSSH.prototype, "dispose", () => undefined);

  await assert.rejects(
    provisionMachine(TARGET, {
      credentialId: VALID_CREDENTIAL_ID,
      expiresAt: new Date(Date.now() + 60_000),
      password: VALID_PASSWORD,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(VALID_PASSWORD));
      assert.equal(error.message, "Guest account issue command failed.");
      return true;
    },
  );
});
