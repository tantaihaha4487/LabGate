"use client";

import { useCallback, useState } from "react";

type MachineStatus = "available" | "occupied" | "offline";

interface Machine {
  id: string;
  name: string;
  status: MachineStatus;
  lastHeartbeat: string | null;
}

interface IssuedCredential {
  username: "guest";
  password: string;
  expiresAt: string;
}

const statusStyles: Record<MachineStatus, string> = {
  available: "bg-emerald-100 text-emerald-800",
  occupied: "bg-amber-100 text-amber-800",
  offline: "bg-slate-200 text-slate-600",
};

export function MachinePicker({ initialMachines }: { initialMachines: Machine[] }) {
  const [machines, setMachines] = useState<Machine[]>(initialMachines);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [credential, setCredential] = useState<IssuedCredential>();

  const loadMachines = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    const response = await fetch("/api/machines", { cache: "no-store" });

    if (!response.ok) {
      setError("Could not load lab machines.");
      setLoading(false);
      return;
    }

    const data = (await response.json()) as { machines: Machine[] };
    setMachines(data.machines);
    setLoading(false);
  }, []);

  async function checkout(machineId: string) {
    setPendingId(machineId);
    setError(undefined);

    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId }),
    });
    const data = (await response.json()) as IssuedCredential & { error?: string };

    if (!response.ok) {
      setError(data.error ?? "Checkout failed.");
      setPendingId(undefined);
      await loadMachines();
      return;
    }

    setCredential(data);
    setPendingId(undefined);
    await loadMachines();
  }

  if (credential) {
    return (
      <section className="mt-8 max-w-xl rounded-2xl border border-emerald-300 bg-emerald-50 p-6 shadow-sm">
        <p className="font-semibold text-emerald-900">Credential issued</p>
        <h2 className="mt-1 text-2xl font-bold text-slate-950">
          Copy this now—it will not be shown again.
        </h2>
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 rounded-xl bg-slate-950 p-5 font-mono text-white">
          <dt className="text-slate-400">Username</dt>
          <dd>{credential.username}</dd>
          <dt className="text-slate-400">Password</dt>
          <dd className="break-all text-lg font-bold">{credential.password}</dd>
          <dt className="text-slate-400">Expires</dt>
          <dd>{new Date(credential.expiresAt).toLocaleString()}</dd>
        </dl>
        <p className="mt-4 text-sm text-emerald-900">
          Type these credentials at the physical Ubuntu machine. This is not a
          remote desktop connection.
        </p>
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
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusStyles[machine.status]}`}
              >
                {machine.status}
              </span>
            </div>
            <p className="mt-5 text-xs text-slate-500">
              Last heartbeat: {machine.lastHeartbeat ? new Date(machine.lastHeartbeat).toLocaleString() : "never"}
            </p>
            <button
              type="button"
              disabled={machine.status !== "available" || pendingId !== undefined}
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
