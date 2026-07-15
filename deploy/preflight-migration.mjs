import {
  accessSync,
  constants as fsConstants,
  lstatSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import Database from "better-sqlite3";

function fail(message) {
  console.error(`LabGate startup preflight failed: ${message}`);
  process.exit(1);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    fail(`${name} is required.`);
  }

  return value;
}

function validateOpaqueValue(name, { minimum = 1, maximum = 512 } = {}) {
  const value = requiredEnvironment(name);

  if (
    value.length < minimum ||
    value.length > maximum ||
    /\s/.test(value)
  ) {
    fail(
      `${name} must contain ${minimum}-${maximum} non-whitespace characters.`,
    );
  }

  return value;
}

function validateBearerSecret(name) {
  const value = requiredEnvironment(name);

  if (
    value.length < 20 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(value)
  ) {
    fail(
      `${name} must be a 20-256 character RFC 6750 b64token without whitespace or quoting.`,
    );
  }
}

function validateAdminEmails(allowedDomain) {
  const rawValue = requiredEnvironment("ADMIN_EMAILS");
  const entries = rawValue.split(",");

  if (entries.some((entry) => entry.trim().length === 0)) {
    fail("ADMIN_EMAILS must be a comma-separated list without empty entries.");
  }

  for (const entry of entries) {
    const email = entry.trim().toLowerCase();
    const parts = email.split("@");
    const localPart = parts[0] ?? "";

    if (
      email.length > 254 ||
      parts.length !== 2 ||
      localPart.length === 0 ||
      localPart.length > 64 ||
      localPart.includes("..") ||
      !/^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]*[a-z0-9])?$/i.test(
        localPart,
      ) ||
      parts[1] !== allowedDomain
    ) {
      fail(
        `ADMIN_EMAILS entries must be valid @${allowedDomain} email addresses.`,
      );
    }
  }
}

function isLoopbackHostname(hostname) {
  if (["localhost", "::1", "[::1]"].includes(hostname.toLowerCase())) {
    return true;
  }

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function validateApplicationEnvironment() {
  const authUrlValue = requiredEnvironment("BETTER_AUTH_URL");
  let authUrl;

  try {
    authUrl = new URL(authUrlValue);
  } catch {
    fail("BETTER_AUTH_URL must be a valid absolute HTTP(S) URL.");
  }

  if (
    !["http:", "https:"].includes(authUrl.protocol) ||
    !authUrl.hostname ||
    authUrl.username ||
    authUrl.password ||
    authUrl.pathname !== "/" ||
    authUrl.search ||
    authUrl.hash ||
    /[?#\\]/.test(authUrlValue) ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(authUrlValue)
  ) {
    fail(
      "BETTER_AUTH_URL must be an origin-only absolute HTTP(S) URL without credentials, a path, a query, or a fragment.",
    );
  }

  if (process.env.NODE_ENV === "production" && authUrl.protocol !== "https:") {
    fail("BETTER_AUTH_URL must use HTTPS in production.");
  }

  if (
    authUrl.protocol === "http:" &&
    process.env.NODE_ENV !== "production" &&
    !isLoopbackHostname(authUrl.hostname)
  ) {
    fail(
      "BETTER_AUTH_URL may use HTTP only with a loopback hostname outside production.",
    );
  }

  validateOpaqueValue("BETTER_AUTH_SECRET", { minimum: 32, maximum: 512 });
  validateOpaqueValue("GOOGLE_CLIENT_ID", { minimum: 8, maximum: 512 });
  validateOpaqueValue("GOOGLE_CLIENT_SECRET", { minimum: 8, maximum: 512 });

  const allowedDomain = requiredEnvironment("ALLOWED_EMAIL_DOMAIN")
    .replace(/^@/, "")
    .toLowerCase();
  if (
    allowedDomain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      allowedDomain,
    )
  ) {
    fail("ALLOWED_EMAIL_DOMAIN must be a valid DNS domain name.");
  }

  validateAdminEmails(allowedDomain);

  validateBearerSecret("MACHINE_REGISTRATION_SECRET");
  validateBearerSecret("CRON_SECRET");

  const keyPath = requiredEnvironment("PROVISIONER_SSH_KEY_PATH");
  if (!isAbsolute(keyPath)) {
    fail("PROVISIONER_SSH_KEY_PATH must be an absolute path.");
  }
  try {
    const keyStat = lstatSync(keyPath);
    if (!keyStat.isFile() || keyStat.size === 0) {
      fail(
        "PROVISIONER_SSH_KEY_PATH must name a non-empty regular file (not a symlink).",
      );
    }
    if ((keyStat.mode & 0o077) !== 0) {
      fail(
        "PROVISIONER_SSH_KEY_PATH must not be readable or writable by group or other users (use mode 0600).",
      );
    }
    accessSync(keyPath, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LabGate startup")) {
      throw error;
    }
    fail("PROVISIONER_SSH_KEY_PATH must name a readable regular file.");
  }
}

function isCanonicalTailscaleIpv4(value) {
  const parts = value.split(".");

  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))
  ) {
    return false;
  }

  const octets = parts.map(Number);
  return (
    octets.every((octet) => octet >= 0 && octet <= 255) &&
    octets.join(".") === value &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

const configuredPasswordLength = process.env.GUEST_PASSWORD_LENGTH;
if (
  configuredPasswordLength !== undefined &&
  (!/^\d+$/.test(configuredPasswordLength.trim()) ||
    Number(configuredPasswordLength.trim()) < 8 ||
    Number(configuredPasswordLength.trim()) > 128)
) {
  fail("GUEST_PASSWORD_LENGTH must be a whole number between 8 and 128.");
}

const configuredTtl = process.env.CREDENTIAL_TTL_HOURS;
if (configuredTtl !== undefined) {
  const hours = Number(configuredTtl.trim());

  if (!Number.isFinite(hours) || hours < 1 / 60 || hours > 24) {
    fail(
      "CREDENTIAL_TTL_HOURS must be at least one minute and no more than 24 hours.",
    );
  }
}

validateApplicationEnvironment();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl?.startsWith("file:")) {
  fail("DATABASE_URL must be an explicit SQLite file: URL.");
}

const configuredDatabasePath = databaseUrl.slice("file:".length);

if (!configuredDatabasePath) {
  fail("DATABASE_URL does not contain a database path.");
}

if (/[?#%]/.test(configuredDatabasePath)) {
  fail(
    "DATABASE_URL must not contain query parameters, a fragment, or percent-encoding.",
  );
}

if (/[\\\0\r\n]/.test(configuredDatabasePath)) {
  fail("DATABASE_URL contains an unsupported path character.");
}

if (
  configuredDatabasePath === ":memory:" ||
  configuredDatabasePath.toLowerCase().includes("mode=memory")
) {
  fail("DATABASE_URL must name a persistent database file, not an in-memory database.");
}

let databasePath;

if (isAbsolute(configuredDatabasePath)) {
  if (normalize(configuredDatabasePath) !== configuredDatabasePath) {
    fail("DATABASE_URL must contain a canonical absolute file path.");
  }
  databasePath = configuredDatabasePath;
} else {
  if (
    !configuredDatabasePath.startsWith("./") ||
    configuredDatabasePath !== `./${normalize(configuredDatabasePath.slice(2))}`
  ) {
    fail(
      "A relative DATABASE_URL must use a canonical ./-prefixed file path.",
    );
  }
  databasePath = resolve(process.cwd(), configuredDatabasePath);
}

if (process.env.NODE_ENV === "production") {
  const relativeProductionPath = relative("/app/data", databasePath);
  if (
    !relativeProductionPath ||
    relativeProductionPath === ".." ||
    relativeProductionPath.startsWith("../") ||
    isAbsolute(relativeProductionPath)
  ) {
    fail("In production, DATABASE_URL must name a file under /app/data.");
  }
}

function inspectDatabaseFile(path, label) {
  let fileStat;

  try {
    fileStat = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    fail(`${label} could not be inspected safely.`);
  }

  if (!fileStat.isFile()) {
    fail(`${label} must be a regular file and must not be a symbolic link.`);
  }

  if (fileStat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current service UID.`);
  }

  if ((fileStat.mode & 0o077) !== 0 || (fileStat.mode & 0o600) !== 0o600) {
    fail(
      `${label} must be owner-readable and owner-writable with no group or other permissions (use mode 0600).`,
    );
  }

  return true;
}

function inspectDatabaseDirectory(path) {
  const directoryPath = dirname(path);
  let directoryStat;

  try {
    directoryStat = lstatSync(directoryPath);
  } catch {
    fail("The SQLite database parent directory must already exist.");
  }

  if (!directoryStat.isDirectory()) {
    fail(
      "The SQLite database parent must be a real directory and must not be a symbolic link.",
    );
  }

  if (directoryStat.uid !== process.getuid()) {
    fail("The SQLite database parent directory must be owned by the service UID.");
  }

  if (
    (directoryStat.mode & 0o077) !== 0 ||
    (directoryStat.mode & 0o700) !== 0o700
  ) {
    fail(
      "The SQLite database parent directory must be owner-readable, writable, and searchable with no group or other permissions (use mode 0700).",
    );
  }
}

inspectDatabaseDirectory(databasePath);

const databaseExists = inspectDatabaseFile(databasePath, "The SQLite database");
const walExists = inspectDatabaseFile(
  `${databasePath}-wal`,
  "The SQLite WAL sidecar",
);
const shmExists = inspectDatabaseFile(
  `${databasePath}-shm`,
  "The SQLite shared-memory sidecar",
);

if (!databaseExists && (walExists || shmExists)) {
  fail("SQLite WAL/SHM sidecars must not exist without their database file.");
}

if (!databaseExists) {
  process.exit(0);
}

let database;

try {
  database = new Database(databasePath, { readonly: true, fileMustExist: true });
  const hasCredentialTable = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guest_credentials'",
    )
    .get();

  const hasMachineTable = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'machines'",
    )
    .get();

  if (!hasCredentialTable && !hasMachineTable) {
    process.exit(0);
  }

  let machineNameConflicts = 0;
  let machineIpConflicts = 0;

  if (hasMachineTable) {
    const machineColumns = database
      .prepare("PRAGMA table_info(machines)")
      .all();
    const invalidMachineAddresses = database
      .prepare("SELECT tailscale_ip FROM machines")
      .all()
      .filter(
        (machine) => !isCanonicalTailscaleIpv4(machine.tailscale_ip),
      ).length;

    if (invalidMachineAddresses > 0) {
      fail(
        `${invalidMachineAddresses} machine row(s) have a non-canonical or out-of-range Tailscale IPv4 address. Use the drained machine-identity maintenance procedure to reconcile canonical CGNAT addresses before migrating.`,
      );
    }

    if (machineColumns.some((column) => column.name === "last_heartbeat")) {
      const futureHeartbeats = database
        .prepare(
          `SELECT COUNT(*) AS conflict_rows
           FROM machines
           WHERE last_heartbeat IS NOT NULL
             AND (
               (
                 typeof(last_heartbeat) IN ('integer', 'real')
                 AND CAST(last_heartbeat AS REAL) >
                   ((julianday('now') - 2440587.5) * 86400000.0) + 30000
               )
               OR (
                 typeof(last_heartbeat) = 'text'
                 AND julianday(last_heartbeat) > julianday('now', '+30 seconds')
               )
             )`,
        )
        .get().conflict_rows;

      if (futureHeartbeats > 0) {
        fail(
          `${futureHeartbeats} machine heartbeat row(s) are more than 30 seconds in the future. Keep those machines quarantined and reconcile database/host clocks before startup.`,
        );
      }
    }

    machineNameConflicts = database
      .prepare(
        `SELECT COUNT(*) AS conflict_groups
         FROM (
           SELECT name FROM machines GROUP BY name HAVING COUNT(*) > 1
         )`,
      )
      .get().conflict_groups;
    machineIpConflicts = database
      .prepare(
        `SELECT COUNT(*) AS conflict_groups
         FROM (
           SELECT tailscale_ip FROM machines GROUP BY tailscale_ip HAVING COUNT(*) > 1
         )`,
      )
      .get().conflict_groups;
  }

  if (machineNameConflicts > 0 || machineIpConflicts > 0) {
    fail(
      `${machineNameConflicts} machine name conflict group(s) and ${machineIpConflicts} Tailscale address conflict group(s) identify duplicate physical machines. Reconcile machine registration before migrating.`,
    );
  }

  let credentialMachineConflicts = 0;
  let studentConflicts = 0;

  if (hasCredentialTable) {
    credentialMachineConflicts = database
      .prepare(
        `SELECT COUNT(*) AS conflict_groups
         FROM (
           SELECT machine_id
           FROM guest_credentials
           WHERE revoked_at IS NULL
           GROUP BY machine_id
           HAVING COUNT(*) > 1
         )`,
      )
      .get().conflict_groups;
    studentConflicts = database
      .prepare(
        `SELECT COUNT(*) AS conflict_groups
         FROM (
           SELECT LOWER(student_email)
           FROM guest_credentials
           WHERE revoked_at IS NULL
           GROUP BY LOWER(student_email)
           HAVING COUNT(*) > 1
         )`,
      )
      .get().conflict_groups;
  }

  if (credentialMachineConflicts > 0 || studentConflicts > 0) {
    fail(
      `${credentialMachineConflicts} machine conflict group(s) and ${studentConflicts} student conflict group(s) have multiple unrevoked credentials. Reconcile them against physical machine state before migrating.`,
    );
  }

  if (hasMachineTable && hasCredentialTable) {
    const hasSafetyHoldColumn = database
      .prepare("PRAGMA table_info(machines)")
      .all()
      .some((column) => column.name === "safety_hold_credential_id");
    if (hasSafetyHoldColumn) {
      const availableSafetyHolds = database
        .prepare(
          `SELECT COUNT(*) AS conflict_rows
           FROM machines
           WHERE status = 'available'
             AND safety_hold_credential_id IS NOT NULL`,
        )
        .get().conflict_rows;
      if (availableSafetyHolds > 0) {
        fail(
          `${availableSafetyHolds} available machine row(s) retain a generation-scoped safety hold. Reconcile the exact physical generation before migrating.`,
        );
      }
    }

    const availableWithCurrentCredential = database
      .prepare(
        `SELECT COUNT(*) AS conflict_rows
         FROM machines AS machine
         WHERE machine.status = 'available'
           AND EXISTS (
             SELECT 1 FROM guest_credentials AS credential
             WHERE credential.machine_id = machine.id
               AND credential.revoked_at IS NULL
           )`,
      )
      .get().conflict_rows;

    if (availableWithCurrentCredential > 0) {
      fail(
        `${availableWithCurrentCredential} available machine row(s) still have a current unrevoked credential. Reconcile each row against the physical endpoint before migrating.`,
      );
    }

    const quarantinedMachines = database
      .prepare(
        `SELECT COUNT(*) AS quarantine_rows
         FROM machines AS machine
         WHERE machine.status = 'occupied'
           AND NOT EXISTS (
             SELECT 1 FROM guest_credentials AS credential
             WHERE credential.machine_id = machine.id
               AND credential.revoked_at IS NULL
           )`,
      )
      .get().quarantine_rows;
    if (quarantinedMachines > 0) {
      console.warn(
        `LabGate startup preflight warning: ${quarantinedMachines} occupied machine row(s) have no current credential and remain quarantined for operator reconciliation.`,
      );
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "could not inspect the database");
} finally {
  database?.close();
}
