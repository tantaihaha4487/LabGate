"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type {
  ActivityAction,
  AdminActivityEntry,
  AdminActivityFilters,
  AdminActivityPage,
  ActivitySource,
} from "@/lib/admin-activity";

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString().replace("T", " ").replace(".000Z", "Z")
    : "Invalid timestamp";
}

function sourceLabel(source: AdminActivityEntry["source"]): string {
  return source === "web" ? "Web" : "Physical";
}

function actionLabel(action: AdminActivityEntry["action"]): string {
  if (action === "login") {
    return "Login";
  }
  if (action === "logout") {
    return "Logout";
  }
  return "Password timeout";
}

function isPage(value: unknown): value is AdminActivityPage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverTime === "string" &&
    Array.isArray(candidate.entries) &&
    (candidate.nextCursor === null || typeof candidate.nextCursor === "string")
  );
}

export function AdminActivityLog({
  initialPage,
}: {
  initialPage: AdminActivityPage;
}) {
  const [page, setPage] = useState(initialPage);
  const [source, setSource] = useState<ActivitySource>("all");
  const [action, setAction] = useState<ActivityAction>("all");
  const [email, setEmail] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<AdminActivityFilters>({
    source: "all",
    action: "all",
  });
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function requestPage(
    filters: AdminActivityFilters,
    cursor: string | undefined,
    nextCursorStack: Array<string | undefined>,
  ) {
    setLoading(true);
    setError(undefined);

    try {
      const params = new URLSearchParams({
        source: filters.source,
        action: filters.action,
      });
      if (filters.email) {
        params.set("email", filters.email);
      }
      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await fetch(`/api/admin/logs?${params.toString()}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (response.status === 403) {
        window.location.assign("/");
        return;
      }

      const result: unknown = await response.json();
      if (!response.ok || !isPage(result)) {
        throw new Error(
          typeof result === "object" &&
          result !== null &&
          typeof (result as Record<string, unknown>).error === "string"
            ? ((result as Record<string, unknown>).error as string)
            : "Activity request failed.",
        );
      }

      setPage(result);
      setAppliedFilters(filters);
      setCursorStack(nextCursorStack);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not load activity data.",
      );
    } finally {
      setLoading(false);
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    void requestPage(
      {
        source,
        action,
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
      },
      undefined,
      [undefined],
    );
  }

  function refresh() {
    void requestPage(
      appliedFilters,
      cursorStack[cursorStack.length - 1],
      cursorStack,
    );
  }

  function loadOlder() {
    if (!page.nextCursor) {
      return;
    }
    void requestPage(
      appliedFilters,
      page.nextCursor,
      [...cursorStack, page.nextCursor],
    );
  }

  function loadNewer() {
    if (cursorStack.length <= 1) {
      return;
    }
    const nextStack = cursorStack.slice(0, -1);
    void requestPage(
      appliedFilters,
      nextStack[nextStack.length - 1],
      nextStack,
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
            Operations
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Login activity
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Attributable web and physical login/logout/password-timeout events,
            newest first. All timestamps are UTC.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <form
        onSubmit={applyFilters}
        className="mt-8 grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
      >
        <label className="text-sm font-medium text-slate-700">
          Source
          <select
            value={source}
            onChange={(event) =>
              setSource(event.target.value as ActivitySource)
            }
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="all">All sources</option>
            <option value="web">Web</option>
            <option value="physical">Physical</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Action
          <select
            value={action}
            onChange={(event) =>
              setAction(event.target.value as ActivityAction)
            }
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="all">All actions</option>
            <option value="login">Login</option>
            <option value="logout">Logout</option>
            <option value="timeout">Password timeout</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Institutional email contains
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={254}
            type="search"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="student@ubu.ac.th"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-wait disabled:opacity-60"
        >
          Apply
        </button>
      </form>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Source</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Institutional email</th>
                <th className="px-4 py-3 font-semibold">UTC timestamp</th>
                <th className="px-4 py-3 font-semibold">Physical machine</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="px-4 py-3 text-slate-700">{sourceLabel(entry.source)}</td>
                  <td className="px-4 py-3 font-semibold text-slate-900">{actionLabel(entry.action)}</td>
                  <td className="px-4 py-3 text-slate-700">{entry.email}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600">
                    {formatTimestamp(entry.occurredAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{entry.machine?.name ?? "—"}</td>
                </tr>
              ))}
              {page.entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    No attributable activity matches these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={loadNewer}
            disabled={loading || cursorStack.length <= 1}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Newer
          </button>
          <p className="text-xs text-slate-500">
            {page.entries.length} of 50 rows per page · server {formatTimestamp(page.serverTime)}
          </p>
          <button
            type="button"
            onClick={loadOlder}
            disabled={loading || page.nextCursor === null}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Older
          </button>
        </div>
      </div>
    </main>
  );
}
