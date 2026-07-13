import { MachinePicker } from "@/components/machine-picker";
import { listPublicMachines } from "@/lib/machines";

export default async function DashboardPage() {
  const machines = await listPublicMachines();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold">Lab machines</h1>
      <p className="mt-2 text-slate-600">
        Reserve an available physical Ubuntu workstation for up to three minutes.
      </p>
      <MachinePicker initialMachines={machines} />
    </main>
  );
}
