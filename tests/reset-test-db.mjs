import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testEnvironmentPath = resolve(projectRoot, ".env.test");
const dataDirectory = resolve(projectRoot, "data");
const testDatabasePath = resolve(dataDirectory, "labgate-test.db");
const prismaCliPath = resolve(
  projectRoot,
  "node_modules/prisma/build/index.js",
);
const machineSetupTestPath = resolve(
  projectRoot,
  "tests/machine-setup.test.sh",
);
const uninstallScriptTestPath = resolve(
  projectRoot,
  "tests/uninstall-scripts.test.sh",
);

function stop(message) {
  console.error(`Test setup refused to run: ${message}`);
  process.exit(1);
}

if (!existsSync(testEnvironmentPath)) {
  stop(".env.test is missing.");
}

const configuredEnvironment = parseEnv(
  readFileSync(testEnvironmentPath, "utf8"),
);
const allowedTestKeys = new Set([
  "NODE_ENV",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAIL_DOMAIN",
  "DATABASE_URL",
  "PROVISIONER_SSH_KEY_PATH",
  "CREDENTIAL_TTL_HOURS",
  "GUEST_PASSWORD_LENGTH",
  "MACHINE_REGISTRATION_SECRET",
  "CRON_SECRET",
]);
const unexpectedKeys = Object.keys(configuredEnvironment).filter(
  (key) => !allowedTestKeys.has(key),
);

if (unexpectedKeys.length > 0) {
  stop(`.env.test contains unexpected keys: ${unexpectedKeys.join(", ")}.`);
}

const requiredExactValues = {
  NODE_ENV: "test",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  ALLOWED_EMAIL_DOMAIN: "ubu.ac.th",
  DATABASE_URL: "file:./data/labgate-test.db",
  PROVISIONER_SSH_KEY_PATH: "./data/nonexistent-test-provisioner-key",
  CREDENTIAL_TTL_HOURS: "0.05",
  GUEST_PASSWORD_LENGTH: "8",
};

for (const [key, expectedValue] of Object.entries(requiredExactValues)) {
  if (configuredEnvironment[key] !== expectedValue) {
    stop(`${key} in .env.test must be ${JSON.stringify(expectedValue)}.`);
  }
}

for (const key of [
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MACHINE_REGISTRATION_SECRET",
  "CRON_SECRET",
]) {
  if (!configuredEnvironment[key]?.startsWith("test-only-")) {
    stop(`${key} in .env.test must be an explicit test-only dummy value.`);
  }
}

if (!existsSync(prismaCliPath)) {
  stop("the local Prisma CLI is missing; run npm install first.");
}

const inheritedKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
];
const childEnvironment = Object.fromEntries(
  inheritedKeys.flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);

Object.assign(childEnvironment, configuredEnvironment, {
  // Prevent @next/env in prisma.config.ts from merging any other env file.
  // NODE_ENV=test also excludes .env.local from Next.js's candidate files.
  __NEXT_PROCESSED_ENV: "true",
  PRISMA_HIDE_UPDATE_MESSAGE: "true",
});

function runCommand(label, command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: "inherit",
  });

  if (result.error) {
    stop(`${label} could not start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    if (result.signal) {
      console.error(`${label} stopped after signal ${result.signal}.`);
    }
    process.exit(result.status ?? 1);
  }
}

function runNode(label, arguments_) {
  runCommand(label, process.execPath, arguments_);
}

mkdirSync(dataDirectory, { recursive: true });
for (const suffix of ["", "-journal", "-shm", "-wal"]) {
  rmSync(`${testDatabasePath}${suffix}`, { force: true });
}

runNode("Prisma client generation", [prismaCliPath, "generate"]);

runNode("Prisma test migration", [
  prismaCliPath,
  "migrate",
  "deploy",
]);

if (!existsSync(testDatabasePath)) {
  stop(`Prisma did not create the expected test database at ${testDatabasePath}.`);
}

const testFiles = readdirSync(resolve(projectRoot, "tests"))
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => resolve(projectRoot, "tests", file));

if (testFiles.length === 0) {
  stop("no tests/*.test.ts files were found.");
}

runNode("Node test runner", [
  "--import",
  "tsx",
  "--test",
  "--test-concurrency=1",
  ...testFiles,
]);

if (!existsSync(machineSetupTestPath)) {
  stop("tests/machine-setup.test.sh is missing.");
}
runCommand("Machine setup test runner", machineSetupTestPath, []);

if (!existsSync(uninstallScriptTestPath)) {
  stop("tests/uninstall-scripts.test.sh is missing.");
}
runCommand("Uninstall script test runner", uninstallScriptTestPath, []);
