"use client";

import { useCallback, useEffect, useState } from "react";
import { useVisiblePolling } from "@/components/use-visible-polling";

type MachineStatus = "available" | "occupied";
type MachineConnectivity = "online" | "offline";

interface Machine {
  id: string;
  name: string;
  status: MachineStatus;
  connectivity: MachineConnectivity;
  lastHeartbeat: string | null;
}

interface IssuedCredential {
  username: "guest";
  password: string;
  expiresAt: string;
  serverTime: string;
}

interface DisplayCredential extends IssuedCredential {
  machineId: string;
}

interface ExpirationState {
  machineId: string;
  status: "locking" | "released" | "held" | "active";
  message?: string;
}

const statusStyles: Record<MachineStatus, string> = {
  available: "bg-emerald-100 text-emerald-800",
  occupied: "bg-amber-100 text-amber-800",
};

const connectivityStyles: Record<MachineConnectivity, string> = {
  online: "bg-blue-100 text-blue-800",
  offline: "bg-slate-200 text-slate-600",
};

function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const minuteAndSecond = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minuteAndSecond}`
    : minuteAndSecond;
}

export function MachinePicker({ initialMachines }: { initialMachines: Machine[] }) {
  const [machines, setMachines] = useState<Machine[]>(initialMachines);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [credential, setCredential] = useState<DisplayCredential>();
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [expiration, setExpiration] = useState<ExpirationState>();
  const expirationMachineId = expiration?.machineId;
  const expirationStatus = expiration?.status;

  const loadMachines = useCallback(async (background = false) => {
    if (!background) {
      setError(undefined);
      setLoading(true);
    }

    try {
      const response = await fetch("/api/machines", { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Machine list request failed.");
      }

      const data = (await response.json()) as { machines?: unknown };

      if (!Array.isArray(data.machines)) {
        throw new Error("Machine list response was invalid.");
      }

      setMachines(data.machines as Machine[]);
    } catch {
      if (!background) {
        setError("Could not load lab machines.");
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, []);

  useVisiblePolling(() => loadMachines(true));

  useEffect(() => {
    if (!credential) {
      return;
    }

    const initialRemainingMilliseconds =
      new Date(credential.expiresAt).getTime() -
      new Date(credential.serverTime).getTime();
    const countdownStartedAt = Date.now();
    const countdownInterval = window.setInterval(() => {
      const remainingMilliseconds =
        initialRemainingMilliseconds - (Date.now() - countdownStartedAt);

      if (remainingMilliseconds <= 0) {
        window.clearInterval(countdownInterval);
        setRemainingSeconds(0);
        setExpiration({ machineId: credential.machineId, status: "locking" });
        setCredential(undefined);
        return;
      }

      setRemainingSeconds(Math.ceil(remainingMilliseconds / 1_000));
    }, 250);

    return () => window.clearInterval(countdownInterval);
  }, [credential]);

  useEffect(() => {
    if (!expirationMachineId || expirationStatus !== "locking") {
      return;
    }

    const machineId = expirationMachineId;
    let cancelled = false;
    let retryTimeout: number | undefined;

    async function lockExpiredCredential() {
      try {
        const response = await fetch("/api/checkout/expire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ machineId }),
        });

        if (cancelled) {
          return;
        }

        if (response.ok) {
          const result = (await response.json()) as {
            status?: "released" | "held" | "already_released" | "active";
          };

          if (
            result.status !== "released" &&
            result.status !== "held" &&
            result.status !== "already_released" &&
            result.status !== "active"
          ) {
            throw new Error("Credential expiration response was invalid.");
          }

          setExpiration({
            machineId,
            status:
              result.status === "already_released" ? "released" : result.status,
          });
          await loadMachines(true);
          return;
        }
      } catch {
        // The durable server and machine timers still enforce expiration.
      }

      if (cancelled) {
        return;
      }

      setExpiration({
        machineId,
        status: "locking",
        message: "Lock confirmation is pending. LabGate will retry automatically.",
      });
      retryTimeout = window.setTimeout(() => {
        void lockExpiredCredential();
      }, 5_000);
    }

    void lockExpiredCredential();

    return () => {
      cancelled = true;
      if (retryTimeout !== undefined) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, [expirationMachineId, expirationStatus, loadMachines]);

  async function checkout(machineId: string) {
    setPendingId(machineId);
    setError(undefined);

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId }),
      });
      const data = (await response.json()) as Partial<IssuedCredential> & {
        error?: string;
      };

      if (!response.ok) {
        setError(data.error ?? "Checkout failed.");
        await loadMachines(true);
        return;
      }

      if (
        data.username !== "guest" ||
        typeof data.password !== "string" ||
        typeof data.expiresAt !== "string" ||
        typeof data.serverTime !== "string"
      ) {
        throw new Error("Checkout response was invalid.");
      }

      const expiresAtMilliseconds = new Date(data.expiresAt).getTime();
      const serverTimeMilliseconds = new Date(data.serverTime).getTime();
      const initialRemainingMilliseconds =
        expiresAtMilliseconds - serverTimeMilliseconds;

      if (
        !Number.isFinite(expiresAtMilliseconds) ||
        !Number.isFinite(serverTimeMilliseconds)
      ) {
        throw new Error("Checkout timestamps were invalid.");
      }

      if (initialRemainingMilliseconds <= 0) {
        setRemainingSeconds(0);
        setCredential(undefined);
        setExpiration({ machineId, status: "locking" });
        await loadMachines(true);
        return;
      }

      setRemainingSeconds(Math.ceil(initialRemainingMilliseconds / 1_000));
      setExpiration(undefined);
      setCredential({
        username: data.username,
        password: data.password,
        expiresAt: data.expiresAt,
        serverTime: data.serverTime,
        machineId,
      });
      await loadMachines(true);
    } catch {
      setError(
        "Checkout could not be completed. Refresh the machine list before retrying.",
      );
      await loadMachines(true);
    } finally {
      setPendingId(undefined);
    }
  }

  if (credential) {
    return (
      <section className="mt-8 max-w-xl rounded-2xl border border-emerald-300 bg-emerald-50 p-6 shadow-sm">
        <p className="font-semibold text-emerald-900">Credential issued</p>
        <h2 className="mt-1 text-2xl font-bold text-slate-950">
          Copy this now—it will not be shown again.
        </h2>
        <div
          role="timer"
          aria-label={`${remainingSeconds} seconds left to start the physical login`}
          className="mt-5 flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50 px-5 py-4"
        >
          <span className="font-semibold text-amber-950">Login window</span>
          <span className="font-mono text-2xl font-bold tabular-nums text-amber-950">
            {formatCountdown(remainingSeconds)}
          </span>
        </div>
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 rounded-xl bg-slate-950 p-5 font-mono text-white">
          <dt className="text-slate-400">Username</dt>
          <dd>{credential.username}</dd>
          <dt className="text-slate-400">Password</dt>
          <dd className="break-all text-lg font-bold">{credential.password}</dd>
          <dt className="text-slate-400">Login by</dt>
          <dd>{new Date(credential.expiresAt).toLocaleString()}</dd>
        </dl>
        <p className="mt-4 text-sm text-emerald-900">
          Type these credentials at the physical Ubuntu machine. This is not a
          remote desktop connection.
        </p>
        <p className="mt-2 text-sm font-semibold text-amber-900">
          Start the physical login before 00:00. After login succeeds, the
          session remains active until you log out.
        </p>
      </section>
    );
  }

  if (expiration) {
    const released = expiration.status === "released";
    const held = expiration.status === "held";
    const active = expiration.status === "active";

    return (
      <section
        aria-live="polite"
        className={`mt-8 max-w-xl rounded-2xl border p-6 shadow-sm ${
          released || active
            ? "border-emerald-300 bg-emerald-50"
            : "border-amber-300 bg-amber-50"
        }`}
      >
        <p className="font-semibold text-slate-900">
          {active
            ? "Physical session active"
            : held
              ? "Credential expired—machine safety hold"
            : released
              ? "Credential expired"
              : "Credential expired—locking guest"}
        </p>
        <h2 className="mt-1 text-2xl font-bold text-slate-950">
          {active
            ? "The login window ended, but your active session remains reserved."
            : held
              ? "The password is inactive; the machine is held for safety confirmation."
            : released
              ? "The password is inactive and your reservation has been released."
              : "The password has been removed from this page."}
        </h2>
        <p className="mt-4 text-sm text-slate-700">
          {expiration.message ??
            (active
              ? "There is no maximum duration for an active session unless you specify one. Log out at the physical machine to release it."
              : held
                ? "You may request a different available machine. This machine will remain unavailable until its exact physical state is safely confirmed."
              : released
                ? "You may return to the machine list and make a new reservation."
                : "Waiting for the lab machine to confirm that the guest account is locked.")}
        </p>
        {released || held || active ? (
          <button
            type="button"
            onClick={() => setExpiration(undefined)}
            className="mt-6 rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-500"
          >
            Return to machines
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="mt-8">
      {error ? (
        <p role="alert" className="mb-5 rounded-xl bg-red-50 p-4 text-red-700">
          {error}
        </p>
      ) : null}
      {loading ? <p className="text-slate-600">Loading machines…</p> : null}
      {!loading && machines.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-slate-600 shadow-sm">
          No machines have been registered yet.
        </p>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {machines.map((machine) => (
          <article key={machine.id} className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-xl font-bold">{machine.name}</h2>
              <div className="flex flex-wrap justify-end gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusStyles[machine.status]}`}
                >
                  {machine.status}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${connectivityStyles[machine.connectivity]}`}
                >
                  {machine.connectivity}
                </span>
              </div>
            </div>
            <p className="mt-5 text-xs text-slate-500">
              Last heartbeat: {machine.lastHeartbeat ? new Date(machine.lastHeartbeat).toLocaleString() : "never"}
            </p>
            <button
              type="button"
              disabled={
                machine.status !== "available" ||
                machine.connectivity !== "online" ||
                pendingId !== undefined
              }
              onClick={() => checkout(machine.id)}
              className="mt-6 w-full rounded-xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {pendingId === machine.id ? "Reserving…" : "Reserve machine"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
