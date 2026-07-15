import { Buffer } from "node:buffer";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import Database from "better-sqlite3";

function fail(message) {
  console.error(`LabGate database postflight failed: ${message}`);
  process.exit(1);
}

function resolveDatabasePath() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl?.startsWith("file:")) {
    fail("DATABASE_URL must be an explicit SQLite file: URL.");
  }

  const configuredPath = databaseUrl.slice("file:".length);

  if (!configuredPath) {
    fail("DATABASE_URL does not contain a database path.");
  }

  if (/[?#%]/.test(configuredPath)) {
    fail(
      "DATABASE_URL must not contain query parameters, a fragment, or percent-encoding.",
    );
  }

  if (/[\\\0\r\n]/.test(configuredPath)) {
    fail("DATABASE_URL contains an unsupported path character.");
  }

  if (
    configuredPath === ":memory:" ||
    configuredPath.toLowerCase().includes("mode=memory")
  ) {
    fail("DATABASE_URL must name a persistent database file, not memory.");
  }

  let databasePath;

  if (isAbsolute(configuredPath)) {
    if (normalize(configuredPath) !== configuredPath) {
      fail("DATABASE_URL must contain a canonical absolute file path.");
    }
    databasePath = configuredPath;
  } else {
    if (
      !configuredPath.startsWith("./") ||
      configuredPath !== `./${normalize(configuredPath.slice(2))}`
    ) {
      fail(
        "A relative DATABASE_URL must use a canonical ./-prefixed file path.",
      );
    }
    databasePath = resolve(process.cwd(), configuredPath);
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

  return databasePath;
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

function verifyFileBoundary(databasePath) {
  const directoryPath = dirname(databasePath);
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

  const databaseExists = inspectDatabaseFile(
    databasePath,
    "The SQLite database",
  );
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
    fail("the migrated SQLite database file does not exist.");
  }
}

const expectedTables = {
  machines: {
    id: ["TEXT", 1, null, 1],
    name: ["TEXT", 1, null, 0],
    tailscale_ip: ["TEXT", 1, null, 0],
    webhook_token: ["TEXT", 1, null, 0],
    status: ["TEXT", 1, "'available'", 0],
    is_hidden: ["BOOLEAN", 1, "false", 0],
    last_heartbeat: ["DATETIME", 0, null, 0],
    safety_hold_credential_id: ["TEXT", 0, null, 0],
    ssh_host_key_sha256: ["TEXT", 0, null, 0],
  },
  guest_credentials: {
    id: ["TEXT", 1, null, 1],
    machine_id: ["TEXT", 1, null, 0],
    student_email: ["TEXT", 1, null, 0],
    created_at: ["DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    expires_at: ["DATETIME", 1, null, 0],
    revoked_at: ["DATETIME", 0, null, 0],
    session_opened_at: ["DATETIME", 0, null, 0],
    machine_state_version: ["INTEGER", 1, "0", 0],
  },
  audit_log: {
    id: ["TEXT", 1, null, 1],
    machine_id: ["TEXT", 0, null, 0],
    student_email: ["TEXT", 0, null, 0],
    event: ["TEXT", 1, null, 0],
    detail: ["TEXT", 0, null, 0],
    created_at: ["DATETIME", 1, "CURRENT_TIMESTAMP", 0],
  },
  user: {
    id: ["TEXT", 1, null, 1],
    name: ["TEXT", 1, null, 0],
    email: ["TEXT", 1, null, 0],
    emailVerified: ["BOOLEAN", 1, "false", 0],
    image: ["TEXT", 0, null, 0],
    createdAt: ["DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    updatedAt: ["DATETIME", 1, null, 0],
  },
  session: {
    id: ["TEXT", 1, null, 1],
    expiresAt: ["DATETIME", 1, null, 0],
    token: ["TEXT", 1, null, 0],
    createdAt: ["DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    updatedAt: ["DATETIME", 1, null, 0],
    ipAddress: ["TEXT", 0, null, 0],
    userAgent: ["TEXT", 0, null, 0],
    userId: ["TEXT", 1, null, 0],
  },
  account: {
    id: ["TEXT", 1, null, 1],
    accountId: ["TEXT", 1, null, 0],
    providerId: ["TEXT", 1, null, 0],
    userId: ["TEXT", 1, null, 0],
    accessToken: ["TEXT", 0, null, 0],
    refreshToken: ["TEXT", 0, null, 0],
    idToken: ["TEXT", 0, null, 0],
    accessTokenExpiresAt: ["DATETIME", 0, null, 0],
    refreshTokenExpiresAt: ["DATETIME", 0, null, 0],
    scope: ["TEXT", 0, null, 0],
    password: ["TEXT", 0, null, 0],
    createdAt: ["DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    updatedAt: ["DATETIME", 1, null, 0],
  },
  verification: {
    id: ["TEXT", 1, null, 1],
    identifier: ["TEXT", 1, null, 0],
    value: ["TEXT", 1, null, 0],
    expiresAt: ["DATETIME", 1, null, 0],
    createdAt: ["DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    updatedAt: ["DATETIME", 1, null, 0],
  },
};

const expectedForeignKeys = {
  guest_credentials: [
    {
      from: "machine_id",
      table: "machines",
      to: "id",
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    },
  ],
  audit_log: [
    {
      from: "machine_id",
      table: "machines",
      to: "id",
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    },
  ],
  session: [
    {
      from: "userId",
      table: "user",
      to: "id",
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
  ],
  account: [
    {
      from: "userId",
      table: "user",
      to: "id",
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
  ],
};

const expectedIndexes = {
  machines_webhook_token_key:
    "CREATE UNIQUE INDEX machines_webhook_token_key ON machines(webhook_token)",
  machines_name_key:
    "CREATE UNIQUE INDEX machines_name_key ON machines(name)",
  machines_tailscale_ip_key:
    "CREATE UNIQUE INDEX machines_tailscale_ip_key ON machines(tailscale_ip)",
  machines_ssh_host_key_sha256_key:
    "CREATE UNIQUE INDEX machines_ssh_host_key_sha256_key ON machines(ssh_host_key_sha256)",
  guest_credentials_active_machine_key:
    "CREATE UNIQUE INDEX guest_credentials_active_machine_key ON guest_credentials(machine_id) WHERE revoked_at IS NULL",
  guest_credentials_active_student_email_key:
    "CREATE UNIQUE INDEX guest_credentials_active_student_email_key ON guest_credentials(LOWER(student_email)) WHERE revoked_at IS NULL",
  user_email_key:
    "CREATE UNIQUE INDEX user_email_key ON user(email)",
  session_userId_idx:
    "CREATE INDEX session_userId_idx ON session(userId)",
  session_token_key:
    "CREATE UNIQUE INDEX session_token_key ON session(token)",
  account_userId_idx:
    "CREATE INDEX account_userId_idx ON account(userId)",
  verification_identifier_idx:
    "CREATE INDEX verification_identifier_idx ON verification(identifier)",
};

function normalizedSql(sql) {
  return sql.toLowerCase().replace(/["`\[\]\s;]/g, "");
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

function isCanonicalSshHostKeyPin(value) {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) {
    return false;
  }

  const encoded = value.slice("SHA256:".length);
  const digest = Buffer.from(encoded, "base64");
  return (
    digest.length === 32 &&
    digest.toString("base64").replace(/=+$/, "") === encoded
  );
}

function verifyTableColumns(database, tableName, expectedColumns) {
  const actualColumns = database
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all();

  if (actualColumns.length === 0) {
    fail(`required table ${tableName} is missing.`);
  }

  const byName = new Map(actualColumns.map((column) => [column.name, column]));

  for (const [columnName, expected] of Object.entries(expectedColumns)) {
    const column = byName.get(columnName);
    if (!column) {
      fail(`required column ${tableName}.${columnName} is missing.`);
    }

    const actual = [
      String(column.type).toUpperCase(),
      Number(column.notnull),
      column.dflt_value === null ? null : String(column.dflt_value),
      Number(column.pk),
    ];

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`column definition ${tableName}.${columnName} is not canonical.`);
    }
  }

  const unexpectedColumns = actualColumns
    .map((column) => column.name)
    .filter((columnName) => !(columnName in expectedColumns));
  if (unexpectedColumns.length > 0) {
    fail(
      `table ${tableName} has unexpected column(s): ${unexpectedColumns.join(", ")}.`,
    );
  }
}

function verifyForeignKeys(database, tableName, expected) {
  const actual = database
    .prepare(`PRAGMA foreign_key_list("${tableName}")`)
    .all()
    .map((foreignKey) => ({
      from: foreignKey.from,
      table: foreignKey.table,
      to: foreignKey.to,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
    }));

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`foreign-key definition for ${tableName} is not canonical.`);
  }
}

function verifyIndexes(database) {
  const lookup = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  );

  for (const [indexName, expectedSql] of Object.entries(expectedIndexes)) {
    const index = lookup.get(indexName);

    if (!index || typeof index.sql !== "string") {
      fail(`required index ${indexName} is missing.`);
    }

    if (normalizedSql(index.sql) !== normalizedSql(expectedSql)) {
      fail(`index definition ${indexName} is not canonical.`);
    }
  }
}

function verifyDataInvariants(database) {
  const machines = database
    .prepare(
      `SELECT name, tailscale_ip, ssh_host_key_sha256
       FROM machines`,
    )
    .all();
  const invalidNames = machines.filter(
    (machine) => !/^[A-Za-z0-9._ -]{1,64}$/.test(machine.name),
  ).length;
  const invalidAddresses = machines.filter(
    (machine) => !isCanonicalTailscaleIpv4(machine.tailscale_ip),
  ).length;
  const invalidPins = machines.filter(
    (machine) =>
      machine.ssh_host_key_sha256 !== null &&
      !isCanonicalSshHostKeyPin(machine.ssh_host_key_sha256),
  ).length;

  if (invalidNames > 0 || invalidAddresses > 0 || invalidPins > 0) {
    fail(
      `${invalidNames} machine name(s), ${invalidAddresses} Tailscale address(es), and ${invalidPins} SSH host-key pin(s) are non-canonical. Quarantine and reconcile those machine identities before startup.`,
    );
  }

  const invalidStatuses = database
    .prepare(
      `SELECT COUNT(*) AS conflict_rows
       FROM machines
       WHERE status NOT IN ('available', 'occupied', 'offline')`,
    )
    .get().conflict_rows;
  if (invalidStatuses > 0) {
    fail(`${invalidStatuses} machine row(s) have an invalid lifecycle status.`);
  }

  const invalidVisibilityValues = database
    .prepare(
      `SELECT COUNT(*) AS conflict_rows
       FROM machines
       WHERE typeof(is_hidden) <> 'integer'
          OR is_hidden NOT IN (0, 1)`,
    )
    .get().conflict_rows;
  if (invalidVisibilityValues > 0) {
    fail(
      `${invalidVisibilityValues} machine row(s) have a non-Boolean is_hidden value.`,
    );
  }

  const identityConflicts = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM (
           SELECT name FROM machines GROUP BY name HAVING COUNT(*) > 1
         )) AS names,
         (SELECT COUNT(*) FROM (
           SELECT tailscale_ip FROM machines
           GROUP BY tailscale_ip HAVING COUNT(*) > 1
         )) AS addresses,
         (SELECT COUNT(*) FROM (
           SELECT webhook_token FROM machines
           GROUP BY webhook_token HAVING COUNT(*) > 1
         )) AS tokens,
         (SELECT COUNT(*) FROM (
           SELECT ssh_host_key_sha256 FROM machines
           WHERE ssh_host_key_sha256 IS NOT NULL
           GROUP BY ssh_host_key_sha256 HAVING COUNT(*) > 1
         )) AS pins`,
    )
    .get();
  if (
    identityConflicts.names > 0 ||
    identityConflicts.addresses > 0 ||
    identityConflicts.tokens > 0 ||
    identityConflicts.pins > 0
  ) {
    fail(
      `${identityConflicts.names} name, ${identityConflicts.addresses} address, ${identityConflicts.tokens} webhook-token, and ${identityConflicts.pins} SSH-pin conflict group(s) identify duplicate machines.`,
    );
  }

  const currentCredentialConflicts = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM (
           SELECT machine_id
           FROM guest_credentials
           WHERE revoked_at IS NULL
           GROUP BY machine_id
           HAVING COUNT(*) > 1
         )) AS machines,
         (SELECT COUNT(*) FROM (
           SELECT LOWER(student_email)
           FROM guest_credentials
           WHERE revoked_at IS NULL
           GROUP BY LOWER(student_email)
           HAVING COUNT(*) > 1
         )) AS students`,
    )
    .get();
  if (
    currentCredentialConflicts.machines > 0 ||
    currentCredentialConflicts.students > 0
  ) {
    fail(
      `${currentCredentialConflicts.machines} machine and ${currentCredentialConflicts.students} student conflict group(s) have multiple current credentials.`,
    );
  }

  const unsafeAvailableRows = database
    .prepare(
      `SELECT
         SUM(CASE WHEN safety_hold_credential_id IS NOT NULL THEN 1 ELSE 0 END)
           AS held,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM guest_credentials AS credential
           WHERE credential.machine_id = machine.id
             AND credential.revoked_at IS NULL
         ) THEN 1 ELSE 0 END) AS current_credentials
       FROM machines AS machine
       WHERE status = 'available'`,
    )
    .get();
  const heldAvailableRows = Number(unsafeAvailableRows.held ?? 0);
  const availableCurrentCredentials = Number(
    unsafeAvailableRows.current_credentials ?? 0,
  );
  if (heldAvailableRows > 0 || availableCurrentCredentials > 0) {
    fail(
      `${heldAvailableRows} available machine row(s) retain a safety hold and ${availableCurrentCredentials} available row(s) retain a current credential. Reconcile the exact physical generation before startup.`,
    );
  }

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
      `LabGate database postflight warning: ${quarantinedMachines} occupied machine row(s) have no current credential and remain quarantined for operator reconciliation.`,
    );
  }
}

const databasePath = resolveDatabasePath();
verifyFileBoundary(databasePath);

let database;

try {
  database = new Database(databasePath, { readonly: true, fileMustExist: true });

  const integrityRows = database.pragma("integrity_check");
  if (
    integrityRows.length !== 1 ||
    String(integrityRows[0]?.integrity_check).toLowerCase() !== "ok"
  ) {
    fail("PRAGMA integrity_check did not return ok.");
  }

  const foreignKeyViolations = database.pragma("foreign_key_check");
  if (foreignKeyViolations.length !== 0) {
    fail(
      `PRAGMA foreign_key_check found ${foreignKeyViolations.length} violation(s).`,
    );
  }

  for (const [tableName, columns] of Object.entries(expectedTables)) {
    verifyTableColumns(database, tableName, columns);
  }

  for (const [tableName, foreignKeys] of Object.entries(expectedForeignKeys)) {
    verifyForeignKeys(database, tableName, foreignKeys);
  }

  verifyDataInvariants(database);
  verifyIndexes(database);
} catch (error) {
  fail(
    error instanceof Error
      ? `database verification could not complete: ${error.message}`
      : "database verification could not complete.",
  );
} finally {
  database?.close();
}

// A read against a WAL database can create a shared-memory file. Recheck the
// whole boundary after closing SQLite so every artifact is covered.
verifyFileBoundary(databasePath);
