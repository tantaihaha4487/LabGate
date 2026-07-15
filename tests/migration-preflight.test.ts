import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import Database from "better-sqlite3";

const preflightPath = resolve("deploy/preflight-migration.mjs");
const keyDirectory = mkdtempSync(join(tmpdir(), "labgate-preflight-key-"));
const testKeyPath = join(keyDirectory, "provisioner-key");
const looseKeyPath = join(keyDirectory, "loose-provisioner-key");
writeFileSync(testKeyPath, "test-only-private-key-fixture\n", { mode: 0o600 });
writeFileSync(looseKeyPath, "test-only-loose-key-fixture\n", { mode: 0o644 });
chmodSync(testKeyPath, 0o600);
chmodSync(looseKeyPath, 0o644);
after(() => rmSync(keyDirectory, { recursive: true, force: true }));

const validEnvironment = {
  ADMIN_EMAILS: "admin@ubu.ac.th",
  ALLOWED_EMAIL_DOMAIN: "ubu.ac.th",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  CRON_SECRET: "test-only-cron-secret",
  GOOGLE_CLIENT_ID: "test-only-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-only-google-client-secret",
  MACHINE_REGISTRATION_SECRET: "test-only-machine-registration-secret",
  PROVISIONER_SSH_KEY_PATH: testKeyPath,
};

function createSecureDatabase(databasePath: string) {
  const database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  return database;
}

function runPreflightUrl(
  databaseUrl: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [preflightPath], {
    cwd: resolve("."),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      ...validEnvironment,
      ...environment,
    },
    encoding: "utf8",
  });
}

function runPreflight(databasePath: string) {
  return runPreflightUrl(`file:${databasePath}`);
}

function runPreflightWithEnvironment(
  databasePath: string,
  environment: Record<string, string>,
) {
  return runPreflightUrl(`file:${databasePath}`, environment);
}

test("migration preflight accepts clean history and blocks duplicate unrevoked rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-preflight-"));
  const databasePath = join(directory, "legacy.db");
  const database = createSecureDatabase(databasePath);

  try {
    database.exec(`
      CREATE TABLE guest_credentials (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        student_email TEXT NOT NULL,
        revoked_at DATETIME
      )
    `);
    database
      .prepare(
        "INSERT INTO guest_credentials (id, machine_id, student_email, revoked_at) VALUES (?, ?, ?, ?)",
      )
      .run(randomUUID(), "machine-clean", "clean@ubu.ac.th", null);

    const clean = runPreflight(databasePath);
    assert.equal(clean.status, 0, clean.stderr);

    database
      .prepare(
        "INSERT INTO guest_credentials (id, machine_id, student_email, revoked_at) VALUES (?, ?, ?, ?)",
      )
      .run(randomUUID(), "machine-clean", "other@ubu.ac.th", null);
    database
      .prepare(
        "INSERT INTO guest_credentials (id, machine_id, student_email, revoked_at) VALUES (?, ?, ?, ?)",
      )
      .run(randomUUID(), "machine-other", "CLEAN@ubu.ac.th", null);

    const conflicted = runPreflight(databasePath);
    assert.notEqual(conflicted.status, 0);
    assert.match(conflicted.stderr, /multiple unrevoked credentials/);
    assert.match(conflicted.stderr, /1 machine conflict group/);
    assert.match(conflicted.stderr, /1 student conflict group/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup preflight exits nonzero for invalid lifecycle configuration", () => {
  const missingDatabase = join(
    keyDirectory,
    `labgate-missing-${randomUUID()}.db`,
  );

  for (const [environment, expectedError] of [
    [{ GUEST_PASSWORD_LENGTH: "7" }, /GUEST_PASSWORD_LENGTH/],
    [{ GUEST_PASSWORD_LENGTH: " " }, /GUEST_PASSWORD_LENGTH/],
    [{ CREDENTIAL_TTL_HOURS: "0.001" }, /CREDENTIAL_TTL_HOURS/],
    [{ CREDENTIAL_TTL_HOURS: " " }, /CREDENTIAL_TTL_HOURS/],
  ] as const) {
    const result = runPreflightWithEnvironment(missingDatabase, environment);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  }
});

test("startup preflight rejects invalid app secrets and provisioner key paths", () => {
  const missingDatabase = join(
    keyDirectory,
    `labgate-missing-${randomUUID()}.db`,
  );

  for (const [environment, expectedError] of [
    [{ BETTER_AUTH_SECRET: " " }, /BETTER_AUTH_SECRET/],
    [{ BETTER_AUTH_URL: "not-a-url" }, /BETTER_AUTH_URL/],
    [{ ALLOWED_EMAIL_DOMAIN: "not a domain" }, /ALLOWED_EMAIL_DOMAIN/],
    [{ ADMIN_EMAILS: "" }, /ADMIN_EMAILS/],
    [{ ADMIN_EMAILS: "admin" }, /ADMIN_EMAILS/],
    [{ ADMIN_EMAILS: "admin@gmail.com" }, /ADMIN_EMAILS/],
    [{ ADMIN_EMAILS: "admin@sub.ubu.ac.th" }, /ADMIN_EMAILS/],
    [{ ADMIN_EMAILS: "admin@ubu.ac.th.example.com" }, /ADMIN_EMAILS/],
    [{ ADMIN_EMAILS: "admin@ubu.ac.th," }, /ADMIN_EMAILS/],
    [
      { MACHINE_REGISTRATION_SECRET: "contains\"unsupported-characters" },
      /MACHINE_REGISTRATION_SECRET/,
    ],
    [{ CRON_SECRET: "short" }, /CRON_SECRET/],
    [{ PROVISIONER_SSH_KEY_PATH: "relative/key" }, /absolute path/],
    [
      { PROVISIONER_SSH_KEY_PATH: missingDatabase },
      /readable regular file/,
    ],
    [{ PROVISIONER_SSH_KEY_PATH: tmpdir() }, /non-empty regular file/],
    [{ PROVISIONER_SSH_KEY_PATH: looseKeyPath }, /mode 0600/],
  ] as const) {
    const result = runPreflightWithEnvironment(missingDatabase, environment);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  }

  const base64Bearer = runPreflightWithEnvironment(missingDatabase, {
    MACHINE_REGISTRATION_SECRET: "AbCdEfGhIjKlMnOpQrStUvWxYz+/==",
  });
  assert.equal(base64Bearer.status, 0, base64Bearer.stderr);

  const normalizedAdmins = runPreflightWithEnvironment(missingDatabase, {
    ADMIN_EMAILS: " ADMIN@UBU.AC.TH,admin@ubu.ac.th ",
  });
  assert.equal(normalizedAdmins.status, 0, normalizedAdmins.stderr);
});

test("migration preflight blocks duplicate physical machine identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-machine-preflight-"));
  const databasePath = join(directory, "legacy.db");
  const database = createSecureDatabase(databasePath);

  try {
    database.exec(`
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tailscale_ip TEXT NOT NULL
      );
      INSERT INTO machines (id, name, tailscale_ip) VALUES
        ('one', 'Duplicate name', '100.64.0.10'),
        ('two', 'Duplicate name', '100.64.0.11'),
        ('three', 'Unique name', '100.64.0.11');
    `);

    const result = runPreflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate physical machines/);
    assert.match(result.stderr, /1 machine name conflict group/);
    assert.match(result.stderr, /1 Tailscale address conflict group/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration preflight blocks available-current drift but preserves quarantine", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-state-preflight-"));
  const databasePath = join(directory, "legacy.db");
  const database = createSecureDatabase(databasePath);

  try {
    database.exec(`
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tailscale_ip TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE guest_credentials (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        student_email TEXT NOT NULL,
        revoked_at DATETIME
      );
      INSERT INTO machines (id, name, tailscale_ip, status) VALUES
        ('available-current', 'Available with current', '100.64.0.20', 'available'),
        ('occupied-empty', 'Occupied without current', '100.64.0.21', 'occupied');
      INSERT INTO guest_credentials (id, machine_id, student_email, revoked_at)
      VALUES ('current', 'available-current', 'drift@ubu.ac.th', NULL);
    `);

    const result = runPreflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /1 available machine row\(s\)/);
    assert.match(result.stderr, /physical endpoint/);

    database
      .prepare("UPDATE machines SET status = 'occupied' WHERE id = ?")
      .run("available-current");
    database
      .prepare("UPDATE guest_credentials SET revoked_at = CURRENT_TIMESTAMP")
      .run();

    const quarantined = runPreflight(databasePath);
    assert.equal(quarantined.status, 0, quarantined.stderr);
    assert.match(quarantined.stderr, /warning: 2 occupied machine row\(s\)/);
    assert.match(quarantined.stderr, /remain quarantined/);

    database.exec(
      "ALTER TABLE machines ADD COLUMN safety_hold_credential_id TEXT",
    );
    database
      .prepare(
        "UPDATE machines SET status = 'available', safety_hold_credential_id = ? WHERE id = ?",
      )
      .run("unknown_generation_123456789", "occupied-empty");
    const unsafeRelease = runPreflight(databasePath);
    assert.notEqual(unsafeRelease.status, 0);
    assert.match(unsafeRelease.stderr, /generation-scoped safety hold/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration preflight blocks legacy non-canonical machine addresses", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-address-preflight-"));
  const databasePath = join(directory, "legacy.db");
  const database = createSecureDatabase(databasePath);

  try {
    database.exec(`
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tailscale_ip TEXT NOT NULL
      );
      INSERT INTO machines (id, name, tailscale_ip)
      VALUES ('alias', 'Legacy alias', '100.064.000.001');
    `);

    const result = runPreflight(databasePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /non-canonical or out-of-range/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup preflight enforces canonical persistent database URLs and the production data boundary", () => {
  const missingName = `missing-${randomUUID()}.db`;
  const productionEnvironment = {
    BETTER_AUTH_URL: "https://labgate.example.edu",
    NODE_ENV: "production",
  };

  const accepted = runPreflightUrl(`file:${join(keyDirectory, missingName)}`);
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const [databaseUrl, environment, expectedError] of [
    ["file::memory:", {}, /persistent database file/],
    [
      `file:/app/data/${missingName}?mode=ro`,
      productionEnvironment,
      /query parameters/,
    ],
    [
      `file:/app/data/${missingName}#fragment`,
      productionEnvironment,
      /fragment/,
    ],
    [
      "file:/app/data/%6cabgate.db",
      productionEnvironment,
      /percent-encoding/,
    ],
    [
      `file:/app/data/../${missingName}`,
      productionEnvironment,
      /canonical absolute file path/,
    ],
    ["file:data/labgate.db", {}, /canonical \.\/-prefixed/],
    [
      `file:${join(tmpdir(), missingName)}`,
      productionEnvironment,
      /under \/app\/data/,
    ],
  ] as const) {
    const result = runPreflightUrl(databaseUrl, environment);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  }
});

test("startup preflight requires an origin-only HTTPS auth URL in production and loopback for development HTTP", () => {
  const productionDatabase = `file:/app/data/missing-${randomUUID()}.db`;

  for (const [environment, expectedError] of [
    [
      { BETTER_AUTH_URL: "http://127.0.0.1:3000", NODE_ENV: "production" },
      /HTTPS in production/,
    ],
    [
      {
        BETTER_AUTH_URL: "https://labgate.example.edu/auth",
        NODE_ENV: "production",
      },
      /origin-only/,
    ],
    [
      { BETTER_AUTH_URL: "http://labgate.example.edu", NODE_ENV: "test" },
      /loopback hostname/,
    ],
    [
      {
        BETTER_AUTH_URL: "https://labgate.example.edu?tenant=ubu",
        NODE_ENV: "test",
      },
      /origin-only/,
    ],
    [
      { BETTER_AUTH_URL: "https://labgate.example.edu/.", NODE_ENV: "test" },
      /origin-only/,
    ],
  ] as const) {
    const result = runPreflightUrl(productionDatabase, environment);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  }
});

test("startup preflight rejects unsafe database and sidecar filesystem metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-db-metadata-"));
  const databasePath = join(directory, "labgate.db");
  const database = createSecureDatabase(databasePath);
  database.close();

  try {
    chmodSync(databasePath, 0o644);
    const looseDatabase = runPreflight(databasePath);
    assert.notEqual(looseDatabase.status, 0);
    assert.match(looseDatabase.stderr, /mode 0600/);

    chmodSync(databasePath, 0o600);
    const accepted = runPreflight(databasePath);
    assert.equal(accepted.status, 0, accepted.stderr);

    const linkPath = join(directory, "linked.db");
    symlinkSync(databasePath, linkPath);
    const linked = runPreflight(linkPath);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /symbolic link/);

    const realDirectory = mkdtempSync(join(directory, "real-parent-"));
    const realDatabasePath = join(realDirectory, "labgate.db");
    const realDatabase = createSecureDatabase(realDatabasePath);
    realDatabase.close();
    const linkedDirectory = join(directory, "linked-parent");
    symlinkSync(realDirectory, linkedDirectory, "dir");
    const linkedParent = runPreflight(join(linkedDirectory, "labgate.db"));
    assert.notEqual(linkedParent.status, 0);
    assert.match(linkedParent.stderr, /parent.*symbolic link/i);

    writeFileSync(`${databasePath}-wal`, "unsafe-sidecar", { mode: 0o644 });
    chmodSync(`${databasePath}-wal`, 0o644);
    const looseSidecar = runPreflight(databasePath);
    assert.notEqual(looseSidecar.status, 0);
    assert.match(looseSidecar.stderr, /WAL sidecar/);
    assert.match(looseSidecar.stderr, /mode 0600/);

    rmSync(`${databasePath}-wal`, { force: true });
    const orphanPath = join(directory, "orphan.db");
    writeFileSync(`${orphanPath}-shm`, "orphan-sidecar", { mode: 0o600 });
    chmodSync(`${orphanPath}-shm`, 0o600);
    const orphaned = runPreflight(orphanPath);
    assert.notEqual(orphaned.status, 0);
    assert.match(orphaned.stderr, /must not exist without/);

    chmodSync(directory, 0o755);
    const looseParent = runPreflight(databasePath);
    assert.notEqual(looseParent.status, 0);
    assert.match(looseParent.stderr, /mode 0700/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration preflight quarantines materially future-dated heartbeats", () => {
  const directory = mkdtempSync(join(tmpdir(), "labgate-future-heartbeat-"));
  const databasePath = join(directory, "legacy.db");
  const database = createSecureDatabase(databasePath);

  try {
    database.exec(`
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tailscale_ip TEXT NOT NULL,
        last_heartbeat DATETIME
      )
    `);
    database
      .prepare(
        "INSERT INTO machines (id, name, tailscale_ip, last_heartbeat) VALUES (?, ?, ?, ?)",
      )
      .run(
        "future-machine",
        "Future machine",
        "100.64.0.31",
        new Date(Date.now() + 5 * 60_000).toISOString(),
      );
    database
      .prepare(
        "INSERT INTO machines (id, name, tailscale_ip, last_heartbeat) VALUES (?, ?, ?, ?)",
      )
      .run(
        "future-machine-epoch-ms",
        "Future machine epoch ms",
        "100.64.0.32",
        Date.now() + 5 * 60_000,
      );

    const future = runPreflight(databasePath);
    assert.notEqual(future.status, 0);
    assert.match(
      future.stderr,
      /2 machine heartbeat row\(s\) are more than 30 seconds in the future/,
    );

    database
      .prepare("UPDATE machines SET last_heartbeat = ? WHERE id = ?")
      .run(new Date(Date.now() + 5_000).toISOString(), "future-machine");
    database
      .prepare("UPDATE machines SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() + 5_000, "future-machine-epoch-ms");
    const withinSkew = runPreflight(databasePath);
    assert.equal(withinSkew.status, 0, withinSkew.stderr);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
