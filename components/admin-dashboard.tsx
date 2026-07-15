"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { normalizeAdminEmail } from "@/lib/admin-email-validation";
import type {
  AdminMachine,
  AdminMachineConnectivity,
  AdminMachineStatus,
  AdminReservationState,
} from "@/lib/admin-machines";

const machineStatusStyles: Record<AdminMachineStatus, string> = {
  available: "bg-emerald-100 text-emerald-800",
  occupied: "bg-amber-100 text-amber-800",
  offline: "bg-slate-200 text-slate-700",
};

const connectivityStyles: Record<AdminMachineConnectivity, string> = {
  online: "bg-blue-100 text-blue-800",
  offline: "bg-slate-200 text-slate-700",
};

const reservationStyles: Record<AdminReservationState, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-violet-100 text-violet-800",
};

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "None";
  }

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    return "Invalid timestamp";
  }

  return timestamp.toISOString().replace("T", " ").replace(".000Z", "Z");
}

function StatusBadge({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

export function AdminDashboard({
  initialMachines,
  initialServerTime,
  admins,
  allowedDomain,
}: {
  initialMachines: AdminMachine[];
  initialServerTime: string;
  admins: string[];
  allowedDomain: string;
}) {
  const [machines, setMachines] = useState(initialMachines);
  const [serverTime, setServerTime] = useState(initialServerTime);
  const [loading, setLoading] = useState(false);
  const [pendingMachineId, setPendingMachineId] = useState<string>();
  const [error, setError] = useState<string>();
  const [candidateAdmin, setCandidateAdmin] = useState("");
  const [generatorError, setGeneratorError] = useState<string>();
  const [generatedLine, setGeneratedLine] = useState<string>();
  const [duplicateAdmin, setDuplicateAdmin] = useState(false);

  const loadMachines = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setError(undefined);
    }

    try {
      const response = await fetch("/api/admin/machines", { cache: "no-store" });

      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (response.status === 403) {
        window.location.assign("/");
        return;
      }
      if (!response.ok) {
        throw new Error("Admin machine list request failed.");
      }

      const result = (await response.json()) as {
        serverTime?: unknown;
        machines?: unknown;
      };
      if (
        typeof result.serverTime !== "string" ||
        !Array.isArray(result.machines)
      ) {
        throw new Error("Admin machine list response was invalid.");
      }

      setServerTime(result.serverTime);
      setMachines(result.machines as AdminMachine[]);
      setError(undefined);
    } catch {
      if (!background) {
        setError("Could not refresh machine administration data.");
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const refreshInterval = window.setInterval(() => {
      void loadMachines(true);
    }, 15_000);

    return () => window.clearInterval(refreshInterval);
  }, [loadMachines]);

  async function updateVisibility(machine: AdminMachine) {
    const hidden = !machine.isHidden;
    setPendingMachineId(machine.id);
    setError(undefined);

    try {
      const response = await fetch(
        `/api/admin/machines/${encodeURIComponent(machine.id)}/visibility`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden }),
        },
      );

      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (response.status === 403) {
        window.location.assign("/");
        return;
      }

      const result = (await response.json()) as {
        hidden?: unknown;
        error?: unknown;
      };
      if (!response.ok || typeof result.hidden !== "boolean") {
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "Visibility update failed.",
        );
      }

      setMachines((current) =>
        current.map((item) =>
          item.id === machine.id
            ? { ...item, isHidden: result.hidden as boolean }
            : item,
        ),
      );
      await loadMachines(true);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update machine visibility.",
      );
    } finally {
      setPendingMachineId(undefined);
    }
  }

  function generateAdminConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGeneratorError(undefined);
    setGeneratedLine(undefined);

    try {
      const normalized = normalizeAdminEmail(candidateAdmin, allowedDomain);
      const nextAdmins = [...new Set([...admins, normalized])];
      setDuplicateAdmin(admins.includes(normalized));
      setGeneratedLine(`ADMIN_EMAILS=${nextAdmins.join(",")}`);
    } catch (caught: unknown) {
      setGeneratorError(
        caught instanceof Error
          ? caught.message
          : "Enter a valid administrator email address.",
      );
    }
  }

  const hiddenCount = machines.filter((machine) => machine.isHidden).length;

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
            Operations
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Administration
          </h1>
          <p className="mt-2 max-w-3xl text-slate-600">
            Review physical endpoint state and control whether machines appear
            to students. Visibility changes do not alter reservations, sessions,
            heartbeats, or safety holds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadMachines(false)}
          disabled={loading}
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Managed machines</p>
          <p className="mt-1 text-3xl font-bold">{machines.length}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Hidden from students</p>
          <p className="mt-1 text-3xl font-bold">{hiddenCount}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Server snapshot</p>
          <p className="mt-2 text-sm font-semibold text-slate-800">
            {formatTimestamp(serverTime)}
          </p>
        </div>
      </section>

      {error ? (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      <section className="mt-8 space-y-5" aria-labelledby="managed-machines">
        <h2 id="managed-machines" className="text-2xl font-bold">
          Managed machines
        </h2>

        {machines.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-slate-600 shadow-sm">
            No machines are registered.
          </div>
        ) : (
          machines.map((machine) => (
            <article
              key={machine.id}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-bold">{machine.name}</h3>
                    <StatusBadge
                      label={machine.isHidden ? "Hidden" : "Visible"}
                      className={
                        machine.isHidden
                          ? "bg-rose-100 text-rose-800"
                          : "bg-emerald-100 text-emerald-800"
                      }
                    />
                    <StatusBadge
                      label={`Stored: ${machine.status}`}
                      className={machineStatusStyles[machine.status]}
                    />
                    <StatusBadge
                      label={machine.connectivity}
                      className={connectivityStyles[machine.connectivity]}
                    />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">ID: {machine.id}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void updateVisibility(machine)}
                  disabled={pendingMachineId === machine.id}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                    machine.isHidden
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : "bg-rose-700 hover:bg-rose-800"
                  }`}
                >
                  {pendingMachineId === machine.id
                    ? "Saving…"
                    : machine.isHidden
                      ? "Restore to students"
                      : "Hide from students"}
                </button>
              </div>

              <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <dt className="text-slate-500">Last heartbeat</dt>
                  <dd className="mt-1 font-medium">
                    {formatTimestamp(machine.lastHeartbeat)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Tailscale address</dt>
                  <dd className="mt-1 font-mono font-medium">
                    {machine.tailscaleIp}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-slate-500">SSH host-key fingerprint</dt>
                  <dd className="mt-1 break-all font-mono text-xs font-medium">
                    {machine.sshHostKeySha256 ?? "Not pinned"}
                  </dd>
                </div>
                <div className="sm:col-span-2 xl:col-span-4">
                  <dt className="text-slate-500">Safety hold credential</dt>
                  <dd className="mt-1 break-all font-mono text-xs font-medium">
                    {machine.safetyHoldCredentialId ?? "None"}
                  </dd>
                </div>
              </dl>

              <div className="mt-6 rounded-xl bg-slate-50 p-4">
                <h4 className="font-semibold">Current reservation</h4>
                {machine.currentReservation ? (
                  <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                    <div className="sm:col-span-2">
                      <dt className="text-slate-500">Student</dt>
                      <dd className="mt-1 font-medium">
                        {machine.currentReservation.studentEmail}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">State</dt>
                      <dd className="mt-1">
                        <StatusBadge
                          label={machine.currentReservation.state}
                          className={
                            reservationStyles[machine.currentReservation.state]
                          }
                        />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">State version</dt>
                      <dd className="mt-1 font-medium">
                        {machine.currentReservation.machineStateVersion}
                      </dd>
                    </div>
                    <div className="sm:col-span-2 xl:col-span-4">
                      <dt className="text-slate-500">Credential ID</dt>
                      <dd className="mt-1 break-all font-mono text-xs font-medium">
                        {machine.currentReservation.id}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Created</dt>
                      <dd className="mt-1 font-medium">
                        {formatTimestamp(machine.currentReservation.createdAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">First-login deadline</dt>
                      <dd className="mt-1 font-medium">
                        {formatTimestamp(machine.currentReservation.expiresAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Session opened</dt>
                      <dd className="mt-1 font-medium">
                        {formatTimestamp(
                          machine.currentReservation.sessionOpenedAt,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Revoked</dt>
                      <dd className="mt-1 font-medium">Not revoked</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-2 text-sm text-slate-600">
                    No current unrevoked credential.
                  </p>
                )}
              </div>
            </article>
          ))
        )}
      </section>

      <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-bold">Administrators</h2>
        <p className="mt-2 text-sm text-slate-600">
          Authorization comes only from the server&apos;s ADMIN_EMAILS environment
          value. LabGate does not store roles in SQLite or edit the Pi environment.
        </p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {admins.map((admin) => (
            <li
              key={admin}
              className="rounded-xl bg-slate-100 px-4 py-3 font-mono text-sm"
            >
              {admin}
            </li>
          ))}
        </ul>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <h3 className="text-lg font-bold">Add administrator</h3>
          <p className="mt-1 text-sm text-slate-600">
            Generate a complete replacement line for the Pi configuration.
          </p>
          <form
            onSubmit={generateAdminConfiguration}
            className="mt-4 flex max-w-2xl flex-col gap-3 sm:flex-row"
          >
            <label className="flex-1">
              <span className="sr-only">Administrator email</span>
              <input
                type="email"
                value={candidateAdmin}
                onChange={(event) => setCandidateAdmin(event.target.value)}
                placeholder={`name@${allowedDomain}`}
                autoComplete="email"
                className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none ring-blue-600 focus:ring-2"
              />
            </label>
            <button
              type="submit"
              className="rounded-xl bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Generate configuration
            </button>
          </form>

          {generatorError ? (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {generatorError}
            </p>
          ) : null}

          {generatedLine ? (
            <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-5">
              <p className="text-sm font-semibold text-blue-950">
                {duplicateAdmin
                  ? "That address is already configured; the deduplicated line is unchanged."
                  : "Use this replacement line:"}
              </p>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-4 text-sm text-slate-100">
                <code>{generatedLine}</code>
              </pre>
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-blue-950">
                <li>
                  On the Raspberry Pi, open the reviewed LabGate checkout and
                  replace the ADMIN_EMAILS line in <code>.env.local</code>.
                </li>
                <li>
                  From that same checkout, apply the environment change with:
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-slate-100">
                    <code>
                      docker compose up -d --force-recreate labgate
                    </code>
                  </pre>
                </li>
                <li>Sign in with the new address and verify access to /admin.</li>
              </ol>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
