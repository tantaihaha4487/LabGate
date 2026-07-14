import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MachinePicker } from "@/components/machine-picker";
import { listPublicMachines } from "@/lib/machines";
import { getInstitutionSession } from "@/lib/server-session";

export default async function DashboardPage() {
  // Layouts and pages may render in parallel. Re-check authorization in the
  // page before loading machine data so a layout redirect cannot serialize
  // protected props into an unauthenticated RSC response.
  const session = await getInstitutionSession(await headers());
  if (!session) {
    redirect("/login");
  }
  const machines = await listPublicMachines();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold">Lab machines</h1>
      <p className="mt-2 text-slate-600">
        Reserve a physical lab workstation, then start its login before the
        credential window ends. An active session remains reserved until logout.
      </p>
      <MachinePicker initialMachines={machines} />
    </main>
  );
}
