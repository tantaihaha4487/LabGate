import { Buffer } from "node:buffer";
import { AuditEvent } from "@/lib/generated/prisma/enums";
import { db } from "@/lib/db/client";

export const ADMIN_ACTIVITY_PAGE_SIZE = 50;
export const activitySources = ["all", "web", "physical"] as const;
export const activityActions = ["all", "login", "logout", "timeout"] as const;

export type ActivitySource = (typeof activitySources)[number];
export type ActivityAction = (typeof activityActions)[number];

export interface AdminActivityFilters {
  source: ActivitySource;
  action: ActivityAction;
  email?: string;
}

export interface AdminActivityMachine {
  id: string;
  name: string;
}

export interface AdminActivityEntry {
  id: string;
  source: Exclude<ActivitySource, "all">;
  action: Exclude<ActivityAction, "all">;
  email: string;
  occurredAt: string;
  machine: AdminActivityMachine | null;
}

export interface AdminActivityPage {
  serverTime: string;
  entries: AdminActivityEntry[];
  nextCursor: string | null;
}

export class AdminActivityQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminActivityQueryError";
  }
}

interface ActivityCursor {
  createdAt: Date;
  id: string;
}

const activityPairs = [
  { event: AuditEvent.login, source: "web", action: "login" },
  { event: AuditEvent.logout, source: "web", action: "logout" },
  { event: AuditEvent.session_open, source: "physical", action: "login" },
  { event: AuditEvent.session_close, source: "physical", action: "logout" },
  {
    event: AuditEvent.password_timeout,
    source: "physical",
    action: "timeout",
  },
] as const;

function isActivitySource(value: string): value is ActivitySource {
  return (activitySources as readonly string[]).includes(value);
}

function isActivityAction(value: string): value is ActivityAction {
  return (activityActions as readonly string[]).includes(value);
}

function readSingleQueryValue(
  params: URLSearchParams,
  key: string,
): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) {
    throw new AdminActivityQueryError(`${key} must be supplied at most once.`);
  }
  return values[0];
}

function decodeCursor(value: string): ActivityCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw new AdminActivityQueryError("cursor is invalid.");
  }

  let decoded: string;
  try {
    const bytes = Buffer.from(value, "base64url");
    const canonical = bytes.toString("base64url");
    if (canonical !== value) {
      throw new Error("non-canonical cursor encoding");
    }
    decoded = bytes.toString("utf8");
  } catch {
    throw new AdminActivityQueryError("cursor is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new AdminActivityQueryError("cursor is invalid.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !Object.hasOwn(parsed, "v") ||
    !Object.hasOwn(parsed, "createdAt") ||
    !Object.hasOwn(parsed, "id")
  ) {
    throw new AdminActivityQueryError("cursor is invalid.");
  }

  const candidate = parsed as {
    v?: unknown;
    createdAt?: unknown;
    id?: unknown;
  };
  if (
    candidate.v !== 1 ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id)
  ) {
    throw new AdminActivityQueryError("cursor is invalid.");
  }

  const createdAt = new Date(candidate.createdAt);
  if (
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== candidate.createdAt
  ) {
    throw new AdminActivityQueryError("cursor is invalid.");
  }

  return { createdAt, id: candidate.id };
}

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");
}

export function parseAdminActivityQuery(
  params: URLSearchParams,
): { filters: AdminActivityFilters; cursor?: ActivityCursor } {
  const allowedKeys = new Set(["source", "action", "email", "cursor"]);
  for (const key of params.keys()) {
    if (!allowedKeys.has(key)) {
      throw new AdminActivityQueryError(`Unknown activity filter: ${key}.`);
    }
  }

  const sourceValue = readSingleQueryValue(params, "source") ?? "all";
  const actionValue = readSingleQueryValue(params, "action") ?? "all";
  const emailValue = readSingleQueryValue(params, "email");
  const cursorValue = readSingleQueryValue(params, "cursor");

  if (!isActivitySource(sourceValue)) {
    throw new AdminActivityQueryError("source must be all, web, or physical.");
  }
  if (!isActivityAction(actionValue)) {
    throw new AdminActivityQueryError(
      "action must be all, login, logout, or timeout.",
    );
  }

  const email = emailValue?.trim();
  if (email && (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email))) {
    throw new AdminActivityQueryError("email is invalid.");
  }

  return {
    filters: { source: sourceValue, action: actionValue, ...(email ? { email } : {}) },
    ...(cursorValue === undefined ? {} : { cursor: decodeCursor(cursorValue) }),
  };
}

function eventsForFilters(
  source: ActivitySource,
  action: ActivityAction,
): Array<(typeof activityPairs)[number]["event"]> {
  return activityPairs
    .filter(
      (pair) =>
        (source === "all" || pair.source === source) &&
        (action === "all" || pair.action === action),
    )
    .map((pair) => pair.event);
}

export async function listAdminActivity(
  filters: AdminActivityFilters,
  cursor?: ActivityCursor,
  now = new Date(),
): Promise<AdminActivityPage> {
  const events = eventsForFilters(filters.source, filters.action);
  const rows = await db.auditLog.findMany({
    where: {
      event: { in: events },
      studentEmail: {
        not: null,
        ...(filters.email ? { contains: filters.email } : {}),
      },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              {
                createdAt: cursor.createdAt,
                id: { lt: cursor.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ADMIN_ACTIVITY_PAGE_SIZE + 1,
    select: {
      id: true,
      event: true,
      studentEmail: true,
      createdAt: true,
      machine: { select: { id: true, name: true } },
    },
  });

  const hasMore = rows.length > ADMIN_ACTIVITY_PAGE_SIZE;
  const visibleRows = hasMore ? rows.slice(0, ADMIN_ACTIVITY_PAGE_SIZE) : rows;
  const entries = visibleRows.flatMap((row): AdminActivityEntry[] => {
    const pair = activityPairs.find((candidate) => candidate.event === row.event);
    if (!pair || !row.studentEmail) {
      return [];
    }

    return [
      {
        id: row.id,
        source: pair.source,
        action: pair.action,
        email: row.studentEmail,
        occurredAt: row.createdAt.toISOString(),
        machine: pair.source === "physical" ? row.machine : null,
      },
    ];
  });

  return {
    serverTime: now.toISOString(),
    entries,
    nextCursor:
      hasMore && visibleRows.length > 0
        ? encodeCursor({
            createdAt: visibleRows[visibleRows.length - 1].createdAt,
            id: visibleRows[visibleRows.length - 1].id,
          })
        : null,
  };
}
