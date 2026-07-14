import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installerPath = resolve("machine-setup/install-machine.sh");
const provisionerSysusersPath = resolve(
  "machine-setup/labgate-provisioner.conf",
);

test("one-shot installer is executable, syntactically valid, and documents its modes", () => {
  assert.notEqual(statSync(installerPath).mode & 0o111, 0);

  const syntax = spawnSync("bash", ["-n", installerPath], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync(installerPath, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--local/);
  assert.match(help.stdout, /--commit SHA/);
  assert.match(help.stdout, /Secrets are read from \/dev\/tty without echo/);
});

test("dry-run prints a redacted enrollment preview without requiring Ubuntu or root", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-installer-test-"));
  const privateKey = join(directory, "provisioner-key");
  const publicKey = `${privateKey}.pub`;
  const registrationSecret = "test-only-registration-secret-123";
  const tailscaleAuthKey = "test-only-tailscale-auth-key-123";
  const keyResult = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "labgate-test", "-f", privateKey],
    { encoding: "utf8", timeout: 5_000 },
  );

  try {
    assert.equal(keyResult.status, 0, keyResult.stderr);
    const preview = spawnSync(installerPath, ["--local", "--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        LABGATE_API_URL: "http://100.64.0.5:3000",
        LABGATE_MACHINE_NAME: "Lab A - PC 01",
        LABGATE_INSTALL_NONINTERACTIVE: "1",
        LABGATE_PASSWORD_LENGTH: "8",
        LABGATE_PROVISIONER_PUBLIC_KEY_FILE: publicKey,
        LABGATE_REGISTRATION_SECRET: registrationSecret,
        TAILSCALE_AUTH_KEY: tailscaleAuthKey,
      },
      timeout: 8_000,
    });

    assert.equal(
      preview.status,
      0,
      JSON.stringify({
        error: preview.error?.message,
        stderr: preview.stderr,
        stdout: preview.stdout,
      }),
    );
    assert.match(preview.stdout, /LabGate physical machine installer/);
    assert.match(preview.stdout, /Fresh enrollment/);
    assert.match(preview.stdout, /Pi API:\s+http:\/\/100\.64\.0\.5:3000/);
    assert.match(preview.stdout, /Pi preflight:\s+health and enrollment compatibility/);
    assert.match(preview.stdout, /Registration key:\s+supplied \(hidden\)/);
    assert.match(preview.stdout, /Dry run complete; no host or Pi state was changed/);
    assert.doesNotMatch(preview.stdout, new RegExp(registrationSecret));
    assert.doesNotMatch(preview.stderr, new RegExp(registrationSecret));
    assert.doesNotMatch(preview.stdout, new RegExp(tailscaleAuthKey));
    assert.doesNotMatch(preview.stderr, new RegExp(tailscaleAuthKey));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installer checks the Pi before local identity changes and publishes the key last", () => {
  const source = readFileSync(installerPath, "utf8");
  const execution = source.slice(source.indexOf("[4/8] Checking the Pi"));

  assert.ok(execution.indexOf("check_pi_health") >= 0);
  assert.ok(execution.indexOf("check_registration_readiness") >= 0);
  assert.ok(execution.indexOf("prepare_provisioner") >= 0);
  assert.ok(
    execution.indexOf("check_pi_health") <
      execution.indexOf("prepare_provisioner"),
  );
  assert.ok(
    execution.indexOf("check_registration_readiness") <
      execution.indexOf("prepare_provisioner"),
  );
  assert.ok(
    execution.indexOf("run_hardened_setup") <
      execution.indexOf("install_provisioner_key"),
  );
  assert.match(source, /--auth-key="file:\$\{tailscale_key_file\}"/);
  assert.match(source, /header = "Authorization: Bearer %s"/);
  assert.doesNotMatch(
    source,
    /(^|[^A-Za-z0-9_])(useradd|userdel|adduser|deluser)([^A-Za-z0-9_]|$)/m,
  );

  assert.equal(
    readFileSync(provisionerSysusersPath, "utf8"),
    'u provisioner - "LabGate constrained SSH provisioner" /var/lib/labgate-provisioner /usr/sbin/nologin\n',
  );
});

test("installer rejects ambiguous source selection and malformed commits early", () => {
  const ambiguous = spawnSync(
    installerPath,
    ["--dry-run", "--local", "--commit", "a".repeat(40)],
    { encoding: "utf8" },
  );
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /mutually exclusive/);

  const malformed = spawnSync(
    installerPath,
    ["--dry-run", "--commit", "main"],
    { encoding: "utf8" },
  );
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /lowercase 40-character Git SHA/);
});
