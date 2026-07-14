import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

const postflightPath = resolve("deploy/postflight-database.mjs");
const migrationRoot = resolve("prisma/migrations");

function createMigratedDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "labgate-postflight-"));
  const databasePath = join(directory, "labgate.db");
  const database = new Database(databasePath);

  try {
    const migrationDirectories = readdirSync(migrationRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const migrationDirectory of migrationDirectories) {
      const migrationPath = join(
        migrationRoot,
        migrationDirectory,
        "migration.sql",
      );
      database.exec(readFileSync(migrationPath, "utf8"));
    }
  } finally {
    database.close();
  }

  chmodSync(databasePath, 0o600);
  return { databasePath, directory };
}

function runPostflight(
  databasePath: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [postflightPath], {
    cwd: resolve("."),
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: `file:${databasePath}`,
      NODE_ENV: "test",
      ...environment,
    },
    encoding: "utf8",
  });
}

test("database postflight accepts the complete migrated schema", () => {
  const { databasePath, directory } = createMigratedDatabase();

  try {
    const result = runPostflight(databasePath);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database postflight verifies both current-credential partial unique predicates", () => {
  for (const mutation of [
    `DROP INDEX guest_credentials_active_machine_key`,
    `DROP INDEX guest_credentials_active_student_email_key;
     CREATE UNIQUE INDEX guest_credentials_active_student_email_key
     ON guest_credentials(LOWER(student_email))
     WHERE revoked_at IS NOT NULL`,
  ]) {
    const { databasePath, directory } = createMigratedDatabase();
    const database = new Database(databasePath);

    try {
      database.exec(mutation);
    } finally {
      database.close();
    }

    try {
      const result = runPostflight(databasePath);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /guest_credentials_active_(machine|student_email)_key/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("database postflight protects Better Auth columns, indexes, and foreign keys", () => {
  for (const mutation of [
    "DROP INDEX session_token_key",
    "ALTER TABLE verification RENAME COLUMN identifier TO unsafe_identifier",
  ]) {
    const { databasePath, directory } = createMigratedDatabase();
    const database = new Database(databasePath);

    try {
      database.exec(mutation);
    } finally {
      database.close();
    }

    try {
      const result = runPostflight(databasePath);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /(session_token_key|verification\.identifier)/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("database postflight rejects missing lifecycle columns", () => {
  const { databasePath, directory } = createMigratedDatabase();
  const database = new Database(databasePath);

  try {
    database.exec(
      "ALTER TABLE machines RENAME COLUMN safety_hold_credential_id TO unsafe_hold_id",
    );
  } finally {
    database.close();
  }

  try {
    const result = runPostflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /required column machines\.safety_hold_credential_id is missing/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database postflight rejects unexpected schema columns", () => {
  const { databasePath, directory } = createMigratedDatabase();
  const database = new Database(databasePath);

  try {
    database.exec(
      "ALTER TABLE machines ADD COLUMN unreviewed_extension TEXT",
    );
  } finally {
    database.close();
  }

  try {
    const result = runPostflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected column\(s\): unreviewed_extension/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database postflight rejects foreign-key violations", () => {
  const { databasePath, directory } = createMigratedDatabase();
  const database = new Database(databasePath);

  try {
    database.pragma("foreign_keys = OFF");
    database
      .prepare(
        `INSERT INTO guest_credentials
           (id, machine_id, student_email, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        "missing-machine",
        "orphan@ubu.ac.th",
        new Date(Date.now() + 60_000).toISOString(),
      );
  } finally {
    database.close();
  }

  try {
    const result = runPostflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /foreign_key_check found 1 violation/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database postflight rejects corrupt or weakly permissioned database files", () => {
  const migrated = createMigratedDatabase();

  try {
    chmodSync(migrated.databasePath, 0o644);
    const weakMode = runPostflight(migrated.databasePath);
    assert.notEqual(weakMode.status, 0);
    assert.match(weakMode.stderr, /mode 0600/);

    chmodSync(migrated.databasePath, 0o600);
    chmodSync(migrated.directory, 0o755);
    const weakParent = runPostflight(migrated.databasePath);
    assert.notEqual(weakParent.status, 0);
    assert.match(weakParent.stderr, /mode 0700/);
  } finally {
    rmSync(migrated.directory, { recursive: true, force: true });
  }

  const corruptDirectory = mkdtempSync(
    join(tmpdir(), "labgate-postflight-corrupt-"),
  );
  const corruptPath = join(corruptDirectory, "labgate.db");
  writeFileSync(corruptPath, "this is not a SQLite database", { mode: 0o600 });
  chmodSync(corruptPath, 0o600);

  try {
    const corrupt = runPostflight(corruptPath);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /database verification could not complete/);
  } finally {
    rmSync(corruptDirectory, { recursive: true, force: true });
  }
});

test("database postflight refuses to release available machines with current credentials or safety holds", () => {
  const { databasePath, directory } = createMigratedDatabase();
  const database = new Database(databasePath);
  const machineId = randomUUID();
  const credentialId = randomUUID();

  try {
    database
      .prepare(
        `INSERT INTO machines
           (id, name, tailscale_ip, webhook_token, status)
         VALUES (?, ?, ?, ?, 'available')`,
      )
      .run(
        machineId,
        "Unsafe available",
        "100.64.0.40",
        `unsafe-available-${randomUUID()}`,
      );
    database
      .prepare(
        `INSERT INTO guest_credentials
           (id, machine_id, student_email, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        credentialId,
        machineId,
        "unsafe-available@ubu.ac.th",
        new Date(Date.now() + 60_000).toISOString(),
      );

    const currentCredential = runPostflight(databasePath);
    assert.notEqual(currentCredential.status, 0);
    assert.match(currentCredential.stderr, /1 available row\(s\) retain a current credential/);

    database
      .prepare("UPDATE guest_credentials SET revoked_at = CURRENT_TIMESTAMP")
      .run();
    database
      .prepare(
        "UPDATE machines SET safety_hold_credential_id = ? WHERE id = ?",
      )
      .run(credentialId, machineId);

    const safetyHold = runPostflight(databasePath);
    assert.notEqual(safetyHold.status, 0);
    assert.match(safetyHold.stderr, /1 available machine row\(s\) retain a safety hold/);

    database
      .prepare("UPDATE machines SET status = 'occupied' WHERE id = ?")
      .run(machineId);
    const quarantined = runPostflight(databasePath);
    assert.equal(quarantined.status, 0, quarantined.stderr);
    assert.match(quarantined.stderr, /remain quarantined/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database postflight rejects non-canonical or duplicate machine identities", () => {
  for (const mutation of [
    (database: Database.Database) => {
      database
        .prepare(
          `INSERT INTO machines
             (id, name, tailscale_ip, webhook_token, status)
           VALUES (?, ?, ?, ?, 'offline')`,
        )
        .run(
          randomUUID(),
          "Invalid address",
          "100.064.0.41",
          `invalid-address-${randomUUID()}`,
        );
    },
    (database: Database.Database) => {
      database
        .prepare(
          `INSERT INTO machines
             (id, name, tailscale_ip, ssh_host_key_sha256, webhook_token, status)
           VALUES (?, ?, ?, ?, ?, 'offline')`,
        )
        .run(
          randomUUID(),
          "Invalid pin",
          "100.64.0.42",
          "SHA256:not-a-canonical-host-key-pin",
          `invalid-pin-${randomUUID()}`,
        );
    },
    (database: Database.Database) => {
      database.exec("DROP INDEX machines_name_key");
      const insert = database.prepare(
        `INSERT INTO machines
           (id, name, tailscale_ip, webhook_token, status)
         VALUES (?, 'Duplicate identity', ?, ?, 'offline')`,
      );
      insert.run(
        randomUUID(),
        "100.64.0.43",
        `duplicate-one-${randomUUID()}`,
      );
      insert.run(
        randomUUID(),
        "100.64.0.44",
        `duplicate-two-${randomUUID()}`,
      );
    },
  ]) {
    const { databasePath, directory } = createMigratedDatabase();
    const database = new Database(databasePath);

    try {
      mutation(database);
      const result = runPostflight(databasePath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(non-canonical|duplicate machines)/);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("database postflight quarantines materially future-dated heartbeats", () => {
  const { databasePath, directory } = createMigratedDatabase();
  const database = new Database(databasePath);

  try {
    database
      .prepare(
        `INSERT INTO machines
           (id, name, tailscale_ip, webhook_token, status, last_heartbeat)
         VALUES (?, ?, ?, ?, 'available', ?)`,
      )
      .run(
        randomUUID(),
        "Future heartbeat",
        "100.64.0.32",
        `future-heartbeat-${randomUUID()}`,
        new Date(Date.now() + 5 * 60_000).toISOString(),
      );
    database
      .prepare(
        `INSERT INTO machines
           (id, name, tailscale_ip, webhook_token, status, last_heartbeat)
         VALUES (?, ?, ?, ?, 'available', ?)`,
      )
      .run(
        randomUUID(),
        "Future heartbeat epoch ms",
        "100.64.0.33",
        `future-heartbeat-ms-${randomUUID()}`,
        Date.now() + 5 * 60_000,
      );
  } finally {
    database.close();
  }

  try {
    const result = runPostflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /2 machine heartbeat row\(s\) are more than 30 seconds in the future/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
