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
const setupPath = resolve("machine-setup/setup-machine.sh");
const webhookFlushPathPath = resolve(
  "machine-setup/guest-webhook-flush.path",
);
const webhookFlushTimerPath = resolve(
  "machine-setup/guest-webhook-flush.timer",
);
const platformPath = resolve("machine-setup/labgate-platform.sh");
const installerGuidePath = resolve("docs/install-lab-machine.md");
const provisionerSysusersPath = resolve(
  "machine-setup/labgate-provisioner.conf",
);
const ansiPattern = /\u001b\[/;

function extractShellFunction(source: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`^${escapedName}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m"),
  );

  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

test("one-shot installer is executable, syntactically valid, and documents its modes", () => {
  assert.notEqual(statSync(installerPath).mode & 0o111, 0);

  const syntax = spawnSync("bash", ["-n", installerPath], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const platformSyntax = spawnSync("bash", ["-n", platformPath], {
    encoding: "utf8",
  });
  assert.equal(platformSyntax.status, 0, platformSyntax.stderr);

  const help = spawnSync(installerPath, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--local/);
  assert.match(help.stdout, /--commit SHA/);
  assert.match(help.stdout, /Ubuntu or Arch-family Desktop/);
  assert.match(help.stdout, /Secrets are read from \/dev\/tty without echo/);
  assert.doesNotMatch(
    readFileSync(installerGuidePath, "utf8"),
    /~~~sh\n# (Pi|Physical lab machine)/,
  );
});

test("webhook outbox changes wake the worker while the retry timer remains enabled", () => {
  const installerSource = readFileSync(installerPath, "utf8");
  const setupSource = readFileSync(setupPath, "utf8");
  const pathUnit = readFileSync(webhookFlushPathPath, "utf8");
  const timerUnit = readFileSync(webhookFlushTimerPath, "utf8");
  const sourceValidation = extractShellFunction(
    installerSource,
    "validate_source_tree",
  );
  const migrationQuiescence = extractShellFunction(
    setupSource,
    "quiesce_legacy_outbox_worker",
  );

  assert.match(pathUnit, /^\[Path\]$/m);
  assert.match(pathUnit, /^PathChanged=\/var\/lib\/labgate\/outbox$/m);
  assert.match(pathUnit, /^Unit=guest-webhook-flush\.service$/m);
  assert.match(pathUnit, /^WantedBy=multi-user\.target$/m);
  assert.match(timerUnit, /^OnUnitActiveSec=10s$/m);
  assert.match(timerUnit, /^Persistent=true$/m);
  assert.match(timerUnit, /^Unit=guest-webhook-flush\.service$/m);

  assert.match(sourceValidation, /^    guest-webhook-flush\.path$/m);
  assert.match(setupSource, /guest-webhook-flush\.path guest-webhook-flush\.service guest-webhook-flush\.timer/);
  assert.match(
    setupSource,
    /guest-webhook-flush\.path guest-webhook-flush\.timer\n/,
  );
  assert.match(migrationQuiescence, /systemctl disable --now/);
  assert.match(migrationQuiescence, /guest-webhook-flush\.path guest-webhook-flush\.timer/);
  assert.match(
    migrationQuiescence,
    /guest-webhook-flush\.path guest-webhook-flush\.timer guest-webhook-flush\.service/,
  );
});

test("platform classifier accepts Ubuntu, Arch, and Arch derivatives only", () => {
  const classify = (id: string, idLike = "") =>
    spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; labgate_classify_platform "$2" "$3"',
        "labgate-platform-test",
        platformPath,
        id,
        idLike,
      ],
      { encoding: "utf8" },
    );

  const ubuntu = classify("ubuntu");
  assert.equal(ubuntu.status, 0, ubuntu.stderr);
  assert.equal(ubuntu.stdout, "ubuntu\n");

  const arch = classify("arch");
  assert.equal(arch.status, 0, arch.stderr);
  assert.equal(arch.stdout, "arch\n");

  const endeavour = classify("endeavouros", "arch");
  assert.equal(endeavour.status, 0, endeavour.stderr);
  assert.equal(endeavour.stdout, "arch\n");

  const unrelatedSubstring = classify("notarch", "debian archlike");
  assert.notEqual(unrelatedSubstring.status, 0);
  assert.equal(unrelatedSubstring.stdout, "");
});

test("Arch bootstrap installs missing prerequisites without a full system upgrade", () => {
  const source = readFileSync(installerPath, "utf8");

  assert.match(source, /pacman -S --needed --noconfirm/);
  assert.doesNotMatch(source, /pacman -Syu/);
  assert.match(source, /pacman -Q \"\$\{package\}\"/);
  assert.match(source, /IFS= read -r value <\/proc\/sys\/kernel\/hostname/);
  assert.match(source, /machine_name=\$\{LABGATE_MACHINE_NAME:-\$\(default_machine_name\)\}/);
  for (const packageName of [
    "inetutils",
    "keyutils",
    "openssh",
    "pam",
    "polkit",
    "shadow",
    "sudo",
    "systemd",
    "tailscale",
    "util-linux",
  ]) {
    assert.match(source, new RegExp(`(^|\\s)${packageName}(\\s|$)`, "m"));
  }
});

test("dry-run prints a redacted enrollment preview without requiring root", () => {
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
    const baseEnvironment = {
      ...process.env,
      LABGATE_API_URL: "http://100.64.0.5:3000",
      LABGATE_INSTALL_NONINTERACTIVE: "1",
      LABGATE_MACHINE_NAME: "Lab A - PC 01",
      LABGATE_PASSWORD_LENGTH: "8",
      LABGATE_PROVISIONER_PUBLIC_KEY_FILE: publicKey,
      LABGATE_REGISTRATION_SECRET: registrationSecret,
      TAILSCALE_AUTH_KEY: tailscaleAuthKey,
      TERM: "xterm-256color",
    };
    const runPreview = (environment: NodeJS.ProcessEnv) =>
      spawnSync(installerPath, ["--local", "--dry-run"], {
        encoding: "utf8",
        env: environment,
        timeout: 8_000,
      });
    const plainEnvironment: NodeJS.ProcessEnv = { ...baseEnvironment };
    delete plainEnvironment.NO_COLOR;
    const preview = runPreview({
      ...plainEnvironment,
      LABGATE_INSTALL_COLOR: "auto",
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
    assert.match(
      preview.stdout,
      /(?:auth key supplied \(hidden\)|supplied auth key will not be used)/,
    );
    assert.match(preview.stdout, /Dry run complete; no host or Pi state was changed/);
    assert.doesNotMatch(preview.stdout, ansiPattern);
    assert.doesNotMatch(preview.stdout, new RegExp(registrationSecret));
    assert.doesNotMatch(preview.stderr, new RegExp(registrationSecret));
    assert.doesNotMatch(preview.stdout, new RegExp(tailscaleAuthKey));
    assert.doesNotMatch(preview.stderr, new RegExp(tailscaleAuthKey));

    const coloredPreview = runPreview({
      ...plainEnvironment,
      LABGATE_INSTALL_COLOR: "always",
    });
    assert.equal(coloredPreview.status, 0, coloredPreview.stderr);
    assert.match(
      coloredPreview.stdout,
      /\u001b\[1;36mLabGate physical machine installer\u001b\[0m/,
    );
    assert.match(
      coloredPreview.stdout,
      /\u001b\[1;34mMode:\s+\u001b\[0m Fresh enrollment/,
    );
    assert.match(
      coloredPreview.stdout,
      /\u001b\[1;32mDry run complete;\u001b\[0m/,
    );
    assert.ok(coloredPreview.stdout.endsWith("\u001b[0m"));
    assert.doesNotMatch(coloredPreview.stdout, new RegExp(registrationSecret));
    assert.doesNotMatch(coloredPreview.stdout, new RegExp(tailscaleAuthKey));

    for (const environment of [
      { ...plainEnvironment, LABGATE_INSTALL_COLOR: "never" },
      {
        ...plainEnvironment,
        LABGATE_INSTALL_COLOR: "always",
        NO_COLOR: "",
      },
      {
        ...plainEnvironment,
        LABGATE_INSTALL_COLOR: "always",
        TERM: "dumb",
      },
    ]) {
      const plainPreview = runPreview(environment);
      assert.equal(plainPreview.status, 0, plainPreview.stderr);
      assert.doesNotMatch(plainPreview.stdout, ansiPattern);
      assert.doesNotMatch(plainPreview.stderr, ansiPattern);
    }

    const invalidColor = spawnSync(installerPath, ["--help"], {
      encoding: "utf8",
      env: {
        ...plainEnvironment,
        LABGATE_INSTALL_COLOR: "sometimes",
        NO_COLOR: "",
      },
    });
    assert.notEqual(invalidColor.status, 0);
    assert.match(
      invalidColor.stderr,
      /LABGATE_INSTALL_COLOR must be auto, always, or never/,
    );

    const coloredError = spawnSync(installerPath, ["--invalid-option"], {
      encoding: "utf8",
      env: {
        ...plainEnvironment,
        LABGATE_INSTALL_COLOR: "always",
      },
    });
    assert.notEqual(coloredError.status, 0);
    assert.match(
      coloredError.stderr,
      /\u001b\[1;31minstall-machine: ERROR: unknown option/,
    );
    assert.ok(coloredError.stderr.endsWith("\u001b[0m"));

    const invalidPassword = spawnSync(
      installerPath,
      ["--local", "--dry-run"],
      {
        encoding: "utf8",
        env: {
          ...baseEnvironment,
          LABGATE_API_URL: "http://100.64.0.5:3000",
          LABGATE_INSTALL_NONINTERACTIVE: "1",
          LABGATE_MACHINE_NAME: "Lab A - PC 01",
          LABGATE_PASSWORD_LENGTH: "4",
          LABGATE_PROVISIONER_PUBLIC_KEY_FILE: publicKey,
          LABGATE_REGISTRATION_SECRET: registrationSecret,
          TAILSCALE_AUTH_KEY: tailscaleAuthKey,
        },
        timeout: 8_000,
      },
    );
    assert.notEqual(invalidPassword.status, 0);
    assert.match(
      invalidPassword.stderr,
      /guest password length must be between 5 and 128/,
    );

    const minimumPassword = spawnSync(
      installerPath,
      ["--local", "--dry-run"],
      {
        encoding: "utf8",
        env: {
          ...baseEnvironment,
          LABGATE_API_URL: "http://100.64.0.5:3000",
          LABGATE_INSTALL_NONINTERACTIVE: "1",
          LABGATE_MACHINE_NAME: "Lab A - PC 01",
          LABGATE_PASSWORD_LENGTH: "5",
          LABGATE_PROVISIONER_PUBLIC_KEY_FILE: publicKey,
          LABGATE_REGISTRATION_SECRET: registrationSecret,
          TAILSCALE_AUTH_KEY: tailscaleAuthKey,
        },
        timeout: 8_000,
      },
    );
    assert.equal(minimumPassword.status, 0, minimumPassword.stderr);
    assert.match(minimumPassword.stdout, /Password length:\s+5/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("child output is sanitized and redacted without masking command status", () => {
  const source = readFileSync(installerPath, "utf8");
  const helperSource = [
    extractShellFunction(source, "redact_child_output"),
    extractShellFunction(source, "render_child_output"),
    extractShellFunction(source, "run_child_command"),
  ].join("\n");
  const renderer = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -uo pipefail",
        "style_child=$'\\033[2m'",
        "style_reset=$'\\033[0m'",
        "stdout_style_used=0",
        "registration_secret=test-only-registration-secret-123",
        "tailscale_auth_key=test-only-tailscale-auth-key-456",
        'die() { printf "renderer error: %s\\n" "$1" >&2; exit 99; }',
        helperSource,
        `run_child_command bash -c 'printf "\\033[31mchild test-only-registration-secret-123 test-only-tailscale-auth-key-456\\033[0m\\r\\n"; exit 23'`,
        "command_status=$?",
        'printf "status=%s\\n" "${command_status}"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(renderer.status, 0, renderer.stderr);
  assert.match(renderer.stdout, /\u001b\[2m\| child \[REDACTED] \[REDACTED]\u001b\[0m/);
  assert.match(renderer.stdout, /status=23/);
  assert.doesNotMatch(renderer.stdout, /\u001b\[31m/);
  assert.doesNotMatch(renderer.stdout, /test-only-registration-secret-123/);
  assert.doesNotMatch(renderer.stdout, /test-only-tailscale-auth-key-456/);
  assert.match(source, /sed -u -E/);

  const rendererFailure = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -uo pipefail",
        "style_child=$'\\033[2m'",
        "style_reset=$'\\033[0m'",
        "stdout_style_used=0 registration_secret= tailscale_auth_key=",
        'sed() { return 41; }',
        'die() { printf "renderer error: %s\\n" "$1" >&2; exit 99; }',
        helperSource,
        "run_child_command printf 'child\\n'",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(rendererFailure.status, 99);
  assert.match(
    rendererFailure.stderr,
    /could not safely render child-command output/,
  );
});

test("success and failure action blocks provide a safe operator handoff", () => {
  const source = readFileSync(installerPath, "utf8");
  const commonFunctions = [
    extractShellFunction(source, "documentation_url"),
  ].join("\n");
  const completion = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -uo pipefail",
        "style_success= style_reset= style_label= style_warning=",
        "stdout_style_used=0",
        "REPOSITORY_OWNER=tantaihaha4487 REPOSITORY_NAME=LabGate DEFAULT_REF=main",
        "EXPECTED_ENROLLMENT_VERSION=1",
        "source_revision=0123456789abcdef0123456789abcdef01234567",
        "fresh_install=1",
        "machine_summary='Lab A - PC 01'",
        "tailscale_ip=100.92.10.14",
        "key_fingerprint=SHA256:REDACTED",
        extractShellFunction(source, "print_success_heading"),
        extractShellFunction(source, "print_completion_row"),
        commonFunctions,
        extractShellFunction(source, "print_completion_summary"),
        "print_completion_summary SHA256:HOSTPIN",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(completion.status, 0, completion.stderr);
  assert.match(completion.stdout, /LabGate machine installation complete/);
  assert.match(completion.stdout, /Initial heartbeat:\s+local service completed/);
  assert.match(completion.stdout, /Required operator actions/);
  assert.match(completion.stdout, /Manual shell commands: none/);
  assert.match(
    completion.stdout,
    /blob\/0123456789abcdef0123456789abcdef01234567\/docs\/recovery\.md#physical-acceptance/,
  );

  const failure = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -uo pipefail",
        "stderr_style_error= stderr_style_reset= stderr_style_warning=",
        "stderr_style_used=0 failure_reported=0",
        "REPOSITORY_OWNER=tantaihaha4487 REPOSITORY_NAME=LabGate DEFAULT_REF=main",
        "source_revision=0123456789abcdef0123456789abcdef01234567",
        "current_stage=6 current_stage_title='Applying the hardened LabGate machine setup'",
        "failure_recovery=guide",
        commonFunctions,
        extractShellFunction(source, "print_stage_failure"),
        "print_stage_failure",
        "current_stage=7 current_stage_title='Publishing the key last and sending a safe heartbeat'",
        "failure_recovery=heartbeat failure_reported=0",
        "print_stage_failure",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(failure.status, 0, failure.stderr);
  assert.match(failure.stderr, /\[ERROR\] Stage 6\/8 failed/);
  assert.match(failure.stderr, /Recovery guide:/);
  assert.match(
    failure.stderr,
    /sudo systemctl status guest-heartbeat\.service --no-pager/,
  );
  assert.match(
    failure.stderr,
    /sudo journalctl -u guest-heartbeat\.service -n 100 --no-pager/,
  );
  assert.match(
    failure.stderr,
    /After correcting the cause: sudo systemctl start guest-heartbeat\.service/,
  );
  assert.match(failure.stderr, /Do not allow student use/g);
  assert.doesNotMatch(failure.stderr, /installation complete/);
});

test("installer checks the Pi before local identity changes and publishes the key last", () => {
  const source = readFileSync(installerPath, "utf8");
  const execution = source.slice(
    source.indexOf("print_stage 4 'Checking the Pi"),
  );
  const stageNumbers = [...source.matchAll(/^print_stage ([1-8]) /gm)].map(
    (match) => Number(match[1]),
  );

  assert.deepEqual(stageNumbers, [1, 2, 3, 4, 5, 6, 7, 8]);
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
  assert.match(source, /prompt_validated_value password_length/);
  assert.match(source, /while true; do\n\s+prompt_value value/);
  assert.match(source, /\[OK\] %s/);
  assert.match(source, /Ubuntu prerequisites installed\./);
  assert.match(source, /Arch prerequisites installed; no full system upgrade was run\./);
  assert.match(source, /local destination_name=.*prompted_value/);
  assert.match(source, /Locked provisioner boundary prepared\./);
  assert.match(source, /initial safe heartbeat service completed\./);
  assert.match(source, /Required operator actions/);
  assert.match(source, /Initial heartbeat:' 'local service completed'/);
  assert.match(source, /Manual shell commands:/);
  assert.match(source, /sudo systemctl status guest-heartbeat\.service --no-pager/);
  assert.match(source, /sudo journalctl -u guest-heartbeat\.service -n 100 --no-pager/);
  assert.match(source, /After correcting the cause: sudo systemctl start guest-heartbeat\.service/);
  assert.match(source, /Recovery guide:/);
  assert.match(source, /Do not allow student use/);
  assert.match(source, /\$\{color_mode\} == always \|\| -t 1/);
  assert.match(source, /\$\{color_mode\} == always \|\| -t 2/);
  assert.match(source, /\$\{color_mode\} == always \|\| -t 3/);
  assert.doesNotMatch(
    source,
    /(^|[^A-Za-z0-9_])(useradd|userdel|adduser|deluser)([^A-Za-z0-9_]|$)/m,
  );

  assert.equal(
    readFileSync(provisionerSysusersPath, "utf8"),
    'u provisioner - "LabGate constrained SSH provisioner" /var/lib/labgate-provisioner /usr/sbin/nologin\n',
  );
});

test("fresh retries restore only the exact partial provisioner shell to nologin", () => {
  const source = readFileSync(installerPath, "utf8");
  const prepareProvisioner = extractShellFunction(source, "prepare_provisioner");
  const passwordLock = prepareProvisioner.indexOf("passwd -l provisioner");
  const keyAbsence = prepareProvisioner.indexOf(
    "[[ ! -e ${home}/.ssh/authorized_keys && ! -L ${home}/.ssh/authorized_keys ]]",
  );
  const restoreNologin = prepareProvisioner.indexOf(
    "chsh --shell /usr/sbin/nologin provisioner",
  );

  assert.match(prepareProvisioner, /\$\{shell\} == \/bin\/sh/);
  assert.match(
    prepareProvisioner,
    /fresh provisioner identity has an unexpected login shell/,
  );
  assert.match(
    prepareProvisioner,
    /partial provisioner shell target must not be group- or world-writable/,
  );
  assert.ok(passwordLock >= 0);
  assert.ok(keyAbsence > passwordLock);
  assert.ok(restoreNologin > keyAbsence);
  assert.match(
    prepareProvisioner,
    /fresh provisioner identity is not locked behind nologin/,
  );
});

test("installation guide contains complete Ubuntu and EndeavourOS transcripts", () => {
  const guide = readFileSync(installerGuidePath, "utf8");

  assert.match(guide, /### Complete Ubuntu Desktop example/);
  assert.match(guide, /Target OS:\s+Ubuntu Desktop confirmed/);
  assert.match(guide, /### Complete EndeavourOS example/);
  assert.match(guide, /Target OS:\s+EndeavourOS \(Arch family\) confirmed/);
  for (let stage = 1; stage <= 8; stage += 1) {
    assert.equal(
      [...guide.matchAll(new RegExp(`^\\[${stage}/8\\]`, "gm"))].length,
      2,
    );
  }
  assert.equal(
    [...guide.matchAll(/additional apt output varies/g)].length,
    1,
  );
  assert.equal(
    [...guide.matchAll(/pacman output varies when missing prerequisites are installed/g)].length,
    1,
  );
  assert.equal([...guide.matchAll(/^Required operator actions$/gm)].length, 2);
  assert.equal([...guide.matchAll(/^Initial heartbeat:\s+/gm)].length, 2);
  assert.equal([...guide.matchAll(/^Manual shell commands: none/gm)].length, 2);
  assert.equal(
    [...guide.matchAll(/docs\/recovery\.md#physical-acceptance/g)].length,
    2,
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

test("installer exposes the guest-home mode contract", () => {
  const installer = readFileSync(installerPath, "utf8");
  const setup = readFileSync(setupPath, "utf8");

  assert.match(installer, /Keep \/home\/guest contents between sessions\? \[y\/N\]/);
  assert.match(installer, /LABGATE_KEEP_GUEST_HOME/);
  assert.match(installer, /existing_guest_home_mode/);
  assert.match(installer, /guest_home_mode=y/);
  assert.match(installer, /guest_home_mode=n/);
  assert.match(setup, /guest-home-mode/);
  assert.match(setup, /labgate_guest_home_mode_change_is_drained/);
  assert.match(setup, /chmod 0600[\s\S]*guest-home-mode/);
});
